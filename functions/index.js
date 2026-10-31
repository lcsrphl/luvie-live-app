const {onRequest, onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('node:crypto');
admin.initializeApp();
const db = admin.firestore();
const APP_SECRET = defineSecret('META_APP_SECRET');
const VERIFY_TOKEN = defineSecret('META_VERIFY_TOKEN');
const IG_TOKEN = defineSecret('META_IG_ACCESS_TOKEN');
const IG_ACCOUNT_ID = defineSecret('META_IG_ACCOUNT_ID');
const ADMIN_UID = defineSecret('LUVIE_ADMIN_UID');
const REGION = 'us-central1';
const TWO_HOURS = 2 * 60 * 60 * 1000;
const graphVersion = 'v23.0'; // Atualize conforme a versão ativa do seu app Meta.

function isAdmin(request) {
  return !!request.auth && request.auth.uid === ADMIN_UID.value();
}
function codeFromComment(text) {
  const value = String(text || '').trim();
  // Apenas um código numérico isolado (com # opcional), sem frases ou números de telefone.
  const match = value.match(/^#?(\d{1,10})$/);
  return match ? match[1] : null;
}
function verifyMetaSignature(req) {
  const header = req.get('x-hub-signature-256') || '';
  const match = header.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match || !req.rawBody) return false;
  const calculated = crypto.createHmac('sha256', APP_SECRET.value()).update(req.rawBody).digest();
  const incoming = Buffer.from(match[1], 'hex');
  return incoming.length === calculated.length && crypto.timingSafeEqual(incoming, calculated);
}
async function sendPrivateReply(commentId, message) {
  const accountId = IG_ACCOUNT_ID.value();
  const accessToken = IG_TOKEN.value();
  if (!accountId || !accessToken) throw new Error('Credenciais Meta ausentes');
  const result = await fetch(`https://graph.instagram.com/${graphVersion}/${encodeURIComponent(accountId)}/messages`, {
    method:'POST',
    headers:{'Authorization':`Bearer ${accessToken}`, 'Content-Type':'application/json'},
    body:JSON.stringify({recipient:{comment_id:commentId}, message:{text:message}})
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(`Meta HTTP ${result.status}: ${JSON.stringify(data).slice(0,500)}`);
  return data;
}
async function reserveComment({commentId, codigo, username, userId, mediaId}) {
  const eventRef = db.collection('liveEvents').doc(commentId);
  const productRef = db.collection('products').doc(codigo);
  const reservationRef = db.collection('reservations').doc(commentId);
  const result = await db.runTransaction(async tx => {
    const [eventSnap, productSnap] = await Promise.all([tx.get(eventRef), tx.get(productRef)]);
    if (eventSnap.exists) return {state:'duplicate'};
    if (!productSnap.exists) {
      tx.create(eventRef,{codigo,username,mediaId,state:'unknown_product',createdAt:admin.firestore.FieldValue.serverTimestamp()});
      return {state:'unknown_product'};
    }
    const product = productSnap.data();
    const quantity = Number(product.quantidade ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      tx.create(eventRef,{codigo,username,mediaId,state:'invalid_stock',createdAt:admin.firestore.FieldValue.serverTimestamp()});
      return {state:'invalid_stock'};
    }
    // Uma única reserva ativa por código neste MVP. Quem chega depois entra na fila.
    const active = product.activeReservationId || null;
    const state = active ? 'waiting' : 'reserved';
    const now = Date.now();
    const reservation = {
      commentId,codigo,username:username || '',userId:userId || '',mediaId:mediaId || '',
      descricao:product.descricao || '',preco:Number(product.preco || 0),state,
      createdAt:admin.firestore.FieldValue.serverTimestamp(),createdAtMs:now,
      expiresAtMs:state === 'reserved' ? now + TWO_HOURS : null,
      messageStatus:'pending'
    };
    tx.create(reservationRef,reservation);
    tx.create(eventRef,{codigo,username,mediaId,state,reservationId:commentId,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    if (!active) tx.update(productRef,{activeReservationId:commentId,status:'reservado'});
    return {state,descricao:reservation.descricao,preco:reservation.preco};
  });
  return result;
}
async function processEvent(value) {
  const commentId = String(value.id || value.comment_id || '');
  const codigo = codeFromComment(value.text);
  if (!commentId || !codigo) return;
  const username = String(value.from?.username || value.username || '');
  const userId = String(value.from?.id || value.user_id || '');
  const mediaId = String(value.media?.id || value.media_id || '');
  const result = await reserveComment({commentId,codigo,username,userId,mediaId});
  if (result.state !== 'reserved' && result.state !== 'waiting') return;
  // Private Reply: apenas uma por comentário e somente durante a live.
  // Não envia link de pagamento até a integração com Mercado Pago.
  const message = result.state === 'reserved'
    ? `Luviê 💗 Sua peça ${codigo} (${result.descricao}) foi reservada! Aguarde as instruções de pagamento da equipe. Prazo de até 2 horas.`
    : `Luviê 💗 Você entrou na fila da peça ${codigo}. Se ficar disponível, a equipe entrará em contato.`;
  try {
    await sendPrivateReply(commentId,message);
    await db.collection('reservations').doc(commentId).update({messageStatus:'sent'});
  } catch(err) {
    console.error('Falha Private Reply:', commentId,err.message);
    await db.collection('reservations').doc(commentId).update({messageStatus:'failed',messageError:String(err.message).slice(0,300)});
  }
}
exports.instagramWebhook = onRequest({region:REGION, secrets:[APP_SECRET,VERIFY_TOKEN,IG_TOKEN,IG_ACCOUNT_ID],timeoutSeconds:60}, async(req,res) => {
  if(req.method === 'GET') {
    const query = req.query;
    if(query['hub.mode']==='subscribe' && query['hub.verify_token']===VERIFY_TOKEN.value()) {
      res.status(200).send(String(query['hub.challenge'] || ''));
    } else res.sendStatus(403);
    return;
  }
  if(req.method !== 'POST') {res.sendStatus(405);return;}
  if(!verifyMetaSignature(req)) {res.sendStatus(403);return;}
  // Retornar rápido à Meta; o evento é gravado em transação antes de responder.
  try {
    for (const entry of (req.body?.entry || [])) {
      for(const change of (entry.changes || [])) {
        if(change.field !== 'live_comments') continue;
        await processEvent(change.value || {});
      }
    }
    res.sendStatus(200);
  } catch(err) { console.error(err); res.sendStatus(500); }
});
exports.adminReservations = onCall({region:REGION,secrets:[ADMIN_UID]}, async request => {
  if(!isAdmin(request)) throw new HttpsError('permission-denied','Apenas administrador');
  const snap = await db.collection('reservations').orderBy('createdAtMs','desc').limit(150).get();
  return {items:snap.docs.map(d=>({id:d.id,...d.data(),createdAt:null}))};
});
exports.expireReservations = onSchedule({schedule:'every 1 minutes',region:REGION},async()=>{
  const now=Date.now();
  const snap=await db.collection('reservations').where('state','==','reserved').where('expiresAtMs','<=',now).limit(100).get();
  for(const item of snap.docs) {
    await db.runTransaction(async tx=>{
      const r=await tx.get(item.ref);
      if(!r.exists || r.data().state!=='reserved' || r.data().expiresAtMs> Date.now()) return;
      const productRef=db.collection('products').doc(r.data().codigo);
      const product=await tx.get(productRef);
      tx.update(item.ref,{state:'expired'});
      if(product.exists && product.data().activeReservationId===item.id){
        tx.update(productRef,{activeReservationId:admin.firestore.FieldValue.delete(),status:'disponivel'});
      }
    });
  }
  // Próximo candidato é promovido na execução seguinte; o envio de nova DM
  // NÃO é automático, pois Private Reply só pode ser enviado uma vez e durante a live.
  const products=await db.collection('products').where('status','==','disponivel').limit(100).get();
  for(const product of products.docs){
    const wait=await db.collection('reservations').where('codigo','==',product.id).where('state','==','waiting').orderBy('createdAtMs').limit(1).get();
    if(wait.empty) continue;
    const candidate=wait.docs[0];
    await db.runTransaction(async tx=>{
      const [p,c]=await Promise.all([tx.get(product.ref),tx.get(candidate.ref)]);
      if(!p.exists||p.data().activeReservationId||c.data()?.state!=='waiting')return;
      const now=Date.now();
      tx.update(product.ref,{activeReservationId:candidate.id,status:'reservado'});
      tx.update(candidate.ref,{state:'reserved',expiresAtMs:now+TWO_HOURS, promotedAtMs:now,requiresManualContact:true});
    });
  }
});