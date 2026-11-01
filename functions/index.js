'use strict';
const {onRequest,onCall,HttpsError}=require('firebase-functions/v2/https');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret}=require('firebase-functions/params');
const admin=require('firebase-admin');
const crypto=require('node:crypto');
admin.initializeApp();
const db=admin.firestore();
const FV=admin.firestore.FieldValue;
const APP_SECRET=defineSecret('META_APP_SECRET');
const VERIFY_TOKEN=defineSecret('META_VERIFY_TOKEN');
const IG_TOKEN=defineSecret('META_IG_ACCESS_TOKEN');
const IG_ACCOUNT_ID=defineSecret('META_IG_ACCOUNT_ID');
const ADMIN_UID=defineSecret('LUVIE_ADMIN_UID');
const REGION='us-central1';
const TWO_HOURS=2*60*60*1000;
const GRAPH_VERSION='v23.0';
const controlRef=db.doc('appConfig/liveControl');
const liveRef=id=>db.collection('lives').doc(id);
const adminOnly=req=>{if(!req.auth||req.auth.uid!==ADMIN_UID.value())throw new HttpsError('permission-denied','Acesso administrativo necessário');};
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{4,100}$/.test(s);
const codeFromComment=v=>String(v||'').trim().match(/^#?(\d{1,10})$/)?.[1]||null;
const info=s=>({id:s.id,...s.data()});
function safeProduct(p){
 const codigo=String(p?.codigo||'').trim(),descricao=String(p?.descricao||'').trim(),preco=Number(p?.preco);
 if(!/^\d{1,10}$/.test(codigo)||!descricao||descricao.length>250||!Number.isFinite(preco)||preco<=0||preco>1000000)throw new HttpsError('invalid-argument','Peça inválida: código, descrição ou preço');
 return {codigo,descricao,preco,quantidade:1,status:'disponivel',activeReservationId:null};
}
function signatureOk(req){
 const m=String(req.get('x-hub-signature-256')||'').match(/^sha256=([a-f0-9]{64})$/i);
 if(!m||!req.rawBody)return false;
 const expected=crypto.createHmac('sha256',APP_SECRET.value()).update(req.rawBody).digest();
 const actual=Buffer.from(m[1],'hex');
 return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
}
async function sendPrivateReply(commentId,message){
 const response=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(IG_ACCOUNT_ID.value())}/messages`,{
  method:'POST',headers:{Authorization:`Bearer ${IG_TOKEN.value()}`,'Content-Type':'application/json'},
  body:JSON.stringify({recipient:{comment_id:commentId},message:{text:message}})
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(`Meta HTTP ${response.status}: ${JSON.stringify(data).slice(0,400)}`);
 return data;
}
async function handleComment(value){
 const commentId=String(value.id||value.comment_id||'');
 const codigo=codeFromComment(value.text);
 if(!commentId||!codigo)return;
 const username=String(value.from?.username||value.username||'').slice(0,120);
 const userId=String(value.from?.id||value.user_id||'');
 const mediaId=String(value.media?.id||value.media_id||'');
 const outcome=await db.runTransaction(async tx=>{
  const ctrl=await tx.get(controlRef);
  const activeId=ctrl.data()?.activeLiveId;
  if(!activeId)return {state:'inactive'};
  const lref=liveRef(activeId),pRef=lref.collection('products').doc(codigo),rRef=lref.collection('reservations').doc(commentId),eRef=lref.collection('events').doc(commentId);
  const [live,prod,event]=await Promise.all([tx.get(lref),tx.get(pRef),tx.get(eRef)]);
  if(!live.exists||live.data().status!=='active')return {state:'inactive'};
  if(event.exists)return {state:'duplicate'};
  if(!prod.exists){tx.create(eRef,{codigo,username,mediaId,state:'unknown_product',createdAt:FV.serverTimestamp()});return {state:'unknown_product'};}
  const p=prod.data();
  const state=p.activeReservationId?'waiting':'reserved';
  const now=Date.now();
  const data={commentId,codigo,username,userId,mediaId,descricao:p.descricao,preco:p.preco,state,createdAt:FV.serverTimestamp(),createdAtMs:now,expiresAtMs:null,messageStatus:'pending'};
  tx.create(rRef,data);
  tx.create(eRef,{codigo,username,mediaId,state,reservationId:commentId,createdAt:FV.serverTimestamp()});
  if(state==='reserved')tx.update(pRef,{activeReservationId:commentId,status:'reservado'});
  return {state,liveId:activeId,descricao:p.descricao};
 });
 if(!['reserved','waiting'].includes(outcome.state))return;
 const message=outcome.state==='reserved'
  ?`Luviê 💗 Sua peça ${codigo} (${outcome.descricao}) foi reservada! A equipe enviará as instruções de pagamento após a live.`
  :`Luviê 💗 Você entrou na fila da peça ${codigo}. Se ficar disponível, a equipe entrará em contato.`;
 const rRef=liveRef(outcome.liveId).collection('reservations').doc(commentId);
 try{await sendPrivateReply(commentId,message);await rRef.update({messageStatus:'sent'});}
 catch(err){console.error('Private Reply:',err);await rRef.update({messageStatus:'failed',messageError:String(err.message).slice(0,300)});}
}
exports.instagramWebhook=onRequest({region:REGION,secrets:[APP_SECRET,VERIFY_TOKEN,IG_TOKEN,IG_ACCOUNT_ID],timeoutSeconds:60},async(req,res)=>{
 if(req.method==='GET'){
  if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===VERIFY_TOKEN.value())res.status(200).send(String(req.query['hub.challenge']||''));
  else res.sendStatus(403);
  return;
 }
 if(req.method!=='POST'){res.sendStatus(405);return;}
 if(!signatureOk(req)){res.sendStatus(403);return;}
 try{
  for(const entry of req.body?.entry||[])for(const change of entry.changes||[]){
   if(change.field==='live_comments')await handleComment(change.value||{});
  }
  res.sendStatus(200);
 }catch(err){console.error('Webhook:',err);res.sendStatus(500);}
});
// O painel só usa funções autenticadas, nunca grava direto no Firestore.
exports.adminLive=onCall({region:REGION,secrets:[ADMIN_UID],maxInstances:10},async req=>{
 adminOnly(req);
 const {action,liveId}=req.data||{};
 if(action==='list'){
  const [ls,ctrl]=await Promise.all([db.collection('lives').orderBy('createdAtMs','desc').limit(50).get(),controlRef.get()]);
  return {lives:ls.docs.map(info),activeLiveId:ctrl.data()?.activeLiveId||null};
 }
 if(action==='create'){
  const date=String(req.data?.date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(`${date}T12:00:00Z`)))throw new HttpsError('invalid-argument','Data inválida');
  const ref=db.collection('lives').doc();
  await ref.create({date,status:'draft',createdAt:FV.serverTimestamp(),createdAtMs:Date.now(),startedAtMs:null,endedAtMs:null});
  return {id:ref.id};
 }
 if(!validId(liveId))throw new HttpsError('invalid-argument','Live inválida');
 const ref=liveRef(liveId);
 if(action==='detail'){
  const [live,products,reservations]=await Promise.all([ref.get(),ref.collection('products').limit(450).get(),ref.collection('reservations').orderBy('createdAtMs','desc').limit(150).get()]);
  if(!live.exists)throw new HttpsError('not-found','Live não encontrada');
  return {live:info(live),products:products.docs.map(info),reservations:reservations.docs.map(info)};
 }
 if(action==='import'){
  const pieces=req.data?.products;
  if(!Array.isArray(pieces)||pieces.length<1||pieces.length>400)throw new HttpsError('invalid-argument','Envie de 1 a 400 peças por arquivo');
  const normalized=pieces.map(safeProduct);
  if(new Set(normalized.map(p=>p.codigo)).size!==normalized.length)throw new HttpsError('invalid-argument','Códigos duplicados no TXT');
  // Reserva o bloqueio de importação na live para impedir importações concorrentes.
  await db.runTransaction(async tx=>{
   const l=await tx.get(ref);
   if(!l.exists||l.data().status!=='draft')throw new HttpsError('failed-precondition','Importação permitida somente em lives não iniciadas');
   if(l.data().productsImported)throw new HttpsError('already-exists','Essa live já recebeu um arquivo TXT');
   tx.update(ref,{productsImported:true,productCount:normalized.length});
   normalized.forEach(p=>tx.create(ref.collection('products').doc(p.codigo),{...p,createdAt:FV.serverTimestamp()}));
  });
  return {count:normalized.length};
 }
 if(action==='start'){
  await db.runTransaction(async tx=>{
   const [c,l]=await Promise.all([tx.get(controlRef),tx.get(ref)]);
   if(!l.exists||l.data().status!=='draft'||!l.data().productsImported)throw new HttpsError('failed-precondition','Importe as peças antes de iniciar');
   if(c.data()?.activeLiveId)throw new HttpsError('failed-precondition','Já existe uma live ativa');
   tx.set(controlRef,{activeLiveId:liveId,updatedAt:FV.serverTimestamp()},{merge:true});
   tx.update(ref,{status:'active',startedAtMs:Date.now()});
  });return {ok:true};
 }
 if(action==='end'){
  const end=Date.now();
  await db.runTransaction(async tx=>{
   const [c,l]=await Promise.all([tx.get(controlRef),tx.get(ref)]);
   if(c.data()?.activeLiveId!==liveId||!l.exists||l.data().status!=='active')throw new HttpsError('failed-precondition','Live não está ativa');
   tx.update(controlRef,{activeLiveId:null,updatedAt:FV.serverTimestamp()});
   tx.update(ref,{status:'ended',endedAtMs:end,hasPendingReservations:true});
  });
  // Expiração é calculada no agendador a partir de endedAtMs, inclusive para reservas já feitas.
  return {ok:true,paymentDeadlineMs:end+TWO_HOURS};
 }
 if(action==='markSold'){
  const reservationId=String(req.data?.reservationId||'');
  if(!reservationId||reservationId.length>200)throw new HttpsError('invalid-argument','Reserva inválida');
  const rref=ref.collection('reservations').doc(reservationId);
  await db.runTransaction(async tx=>{
   const [l,r]=await Promise.all([tx.get(ref),tx.get(rref)]);
   if(!l.exists||l.data().status!=='ended'||!r.exists||r.data().state!=='reserved')throw new HttpsError('failed-precondition','Reserva não disponível para confirmação');
   const p=ref.collection('products').doc(r.data().codigo),ps=await tx.get(p);
   if(!ps.exists||ps.data().activeReservationId!==reservationId)throw new HttpsError('failed-precondition','Reserva não é a atual');
   tx.update(rref,{state:'sold',soldAtMs:Date.now(),confirmedManually:true});
   tx.update(p,{status:'vendido',activeReservationId:null});
  });return {ok:true};
 }
 throw new HttpsError('invalid-argument','Ação desconhecida');
});
exports.adminReservations=onCall({region:REGION,secrets:[ADMIN_UID]},async req=>{
 adminOnly(req);
 const id=req.data?.liveId;
 if(!validId(id))throw new HttpsError('invalid-argument','Informe a live');
 const s=await liveRef(id).collection('reservations').orderBy('createdAtMs','desc').limit(150).get();
 return {items:s.docs.map(info)};
});
exports.expireReservations=onSchedule({schedule:'every 1 minutes',region:REGION},async()=>{
 const now=Date.now();
 const ended=await db.collection('lives').where('status','==','ended').limit(100).get();
 for(const live of ended.docs){
  if(!live.data().endedAtMs||live.data().endedAtMs+TWO_HOURS>now)continue;
  const products=await live.ref.collection('products').limit(400).get();
  for(const p of products.docs){
   if(!p.data().activeReservationId)continue;
   const current=live.ref.collection('reservations').doc(p.data().activeReservationId);
   // Consultar fila fora da transação; confirmar novamente o candidato dentro dela.
   const queue=await live.ref.collection('reservations').where('codigo','==',p.id).limit(400).get();
   const waiting=queue.docs.filter(s=>s.data().state==='waiting').sort((a,b)=>a.data().createdAtMs-b.data().createdAtMs);
   await db.runTransaction(async tx=>{
    const [ps,rs,...ws]=await Promise.all([tx.get(p.ref),tx.get(current),...waiting.slice(0,1).map(x=>tx.get(x.ref))]);
    if(!ps.exists||ps.data().activeReservationId!==current.id||!rs.exists||rs.data().state!=='reserved')return;
    const deadline=rs.data().promotedAtMs?rs.data().promotedAtMs+TWO_HOURS:live.data().endedAtMs+TWO_HOURS;
    if(deadline>Date.now())return;
    tx.update(current,{state:'expired',expiresAtMs:deadline});
    const next=ws[0];
    if(next?.exists&&next.data().state==='waiting'){
     const time=Date.now();
     tx.update(next.ref,{state:'reserved',promotedAtMs:time,expiresAtMs:time+TWO_HOURS,requiresManualContact:true});
     tx.update(p.ref,{activeReservationId:next.id,status:'reservado'});
    }else tx.update(p.ref,{activeReservationId:null,status:'disponivel'});
   });
  }
 }
});