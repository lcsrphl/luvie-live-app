
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
const ADMIN_UID=defineSecret('LUVIE_ADMIN_UID');

const REGION='us-central1';
const TWO_HOURS=7200000;

const controlRef=db.doc('appConfig/liveControl');
const liveRef=id=>db.collection('lives').doc(id);
const info=s=>({id:s.id,...s.data()});

const validId=s=>
 typeof s==='string'&&/^[A-Za-z0-9_-]{4,100}$/.test(s);

const codeFromComment=v=>
 String(v||'').trim().match(/^#?(\d{1,10})$/)?.[1]||null;

const adminOnly=req=>{
 if(!req.auth||req.auth.uid!==ADMIN_UID.value())
  throw new HttpsError('permission-denied','Acesso administrativo necessário');
};

function safeProduct(p){
 const codigo=String(p?.codigo||'').trim();
 const descricao=String(p?.descricao||'').trim();
 const preco=Number(p?.preco);

 if(
  !/^\d{1,10}$/.test(codigo)||
  !descricao||
  descricao.length>250||
  !Number.isFinite(preco)||
  preco<=0||
  preco>1000000
 ){
  throw new HttpsError('invalid-argument','Peça inválida');
 }

 return {
  codigo,
  descricao,
  preco,
  quantidade:1,
  status:'disponivel',
  activeReservationId:null
 };
}

function signatureOk(req){
 const m=String(req.get('x-hub-signature-256')||'')
  .match(/^sha256=([a-f0-9]{64})$/i);

 if(!m||!req.rawBody)return false;

 const expected=crypto
  .createHmac('sha256',APP_SECRET.value())
  .update(req.rawBody)
  .digest();

 const actual=Buffer.from(m[1],'hex');

 return actual.length===expected.length&&
  crypto.timingSafeEqual(actual,expected);
}

const customerKey=(userId,username)=>
 crypto.createHash('sha256')
  .update(userId?'id:'+userId:'username:'+username.toLowerCase())
  .digest('hex')
  .slice(0,40);

// Cadastro permanente entre diferentes lives.
const directoryRef=key=>
 db.collection('customerDirectory').doc(key);

const handleRef=username=>
 db.collection('customerUsernameIndex')
  .doc(customerKey('',username.trim().replace(/^@/,'').toLowerCase()));

function directoryMatches(record,userId){
 return !!record&&(
  !record.userId||
  !userId||
  record.userId===userId
 );
}

// ============================================================
// RECEBIMENTO DE COMENTÁRIOS DO INSTAGRAM
// ============================================================

async function handleComment(value){
 const commentId=String(value.id||value.comment_id||'');
 const codigo=codeFromComment(value.text);

 if(!commentId||!codigo)return;

 const username=String(
  value.from?.username||value.username||''
 ).slice(0,120);

 const userId=String(
  value.from?.id||value.user_id||''
 );

 if(!userId&&!username){
  console.warn('Comentário sem identidade:',commentId);
  return;
 }

 const key=customerKey(userId,username);
 const mediaId=String(value.media?.id||value.media_id||'');

 await db.runTransaction(async tx=>{
  const ctrl=await tx.get(controlRef);
  const activeId=ctrl.data()?.activeLiveId;

  if(!activeId)return;

  const lref=liveRef(activeId);
  const pRef=lref.collection('products').doc(codigo);
  const rRef=lref.collection('reservations').doc(commentId);
  const eRef=lref.collection('events').doc(commentId);
  const dedupeRef=lref.collection('customerCodes')
   .doc(`${key}_${codigo}`);
  const customerRef=lref.collection('customers').doc(key);

  const globalRef=directoryRef(key);
  const aliasRef=username?handleRef(username):null;

  const [
   live,
   prod,
   event,
   dedupe,
   customer,
   global,
   alias
  ]=await Promise.all([
   tx.get(lref),
   tx.get(pRef),
   tx.get(eRef),
   tx.get(dedupeRef),
   tx.get(customerRef),
   tx.get(globalRef),
   aliasRef?tx.get(aliasRef):Promise.resolve(null)
  ]);

  const aliasKey=alias?.data()?.directoryKey;

  const aliasDirectoryRef=
   aliasKey&&aliasKey!==key?directoryRef(aliasKey):null;

  const aliasDirectory=aliasDirectoryRef?
   await tx.get(aliasDirectoryRef):null;

  const directory=global.exists?
   global.data():
   directoryMatches(aliasDirectory?.data(),userId)?
    aliasDirectory?.data():null;

  if(
   !live.exists||
   live.data().status!=='active'||
   live.data().salesClosed||
   event.exists
  )return;

  if(!prod.exists){
   tx.create(eRef,{
    codigo,
    username,
    mediaId,
    state:'unknown_product',
    createdAt:FV.serverTimestamp()
   });
   return;
  }

  if(dedupe.exists){
   tx.create(eRef,{
    codigo,
    username,
    mediaId,
    state:'duplicate_customer_code',
    createdAt:FV.serverTimestamp()
   });
   return;
  }

  const p=prod.data();
  const state=p.activeReservationId?'waiting':'reserved';
  const now=Date.now();

  tx.create(rRef,{
   commentId,
   codigo,
   customerKey:key,
   username,
   userId,
   mediaId,
   descricao:p.descricao,
   preco:p.preco,
   state,
   createdAt:FV.serverTimestamp(),
   createdAtMs:now,
   expiresAtMs:null,
   messageStatus:'not_sent'
  });

  tx.create(eRef,{
   codigo,
   username,
   mediaId,
   state,
   reservationId:commentId,
   createdAt:FV.serverTimestamp()
  });

  tx.create(dedupeRef,{
   commentId,
   customerKey:key,
   codigo,
   createdAtMs:now
  });

  if(!customer.exists){
   tx.create(customerRef,{
    username,
    userId,
    firstCommentId:commentId,
    firstAtMs:now,
    sendStatus:'pending',
    ...(directory?.whatsapp?{
     whatsapp:directory.whatsapp,
     whatsappOptIn:directory.whatsappOptIn===true
    }:{}),
    directoryKey:key
   });
  }else if(directory?.whatsapp&&!customer.data().whatsapp){
   tx.update(customerRef,{
    whatsapp:directory.whatsapp,
    whatsappOptIn:directory.whatsappOptIn===true,
    directoryKey:key
   });
  }

  if(
   directory&&
   (!global.exists||global.data().username!==username)
  ){
   tx.set(globalRef,{
    ...directory,
    username,
    userId:userId||directory.userId||'',
    updatedAtMs:now
   },{merge:true});
  }

  if(
   aliasRef&&(
    !alias.exists||
    aliasKey===key||
    directoryMatches(aliasDirectory?.data(),userId)
   )
  ){
   tx.set(aliasRef,{
    directoryKey:key,
    userId:userId||'',
    username:username.toLowerCase(),
    updatedAtMs:now
   },{merge:true});
  }

  if(state==='reserved'){
   tx.update(pRef,{
    activeReservationId:commentId,
    status:'reservado'
   });
  }
 });
}

// ============================================================
// WEBHOOK META
// ============================================================

exports.instagramWebhook=onRequest({
 region:REGION,
 secrets:[APP_SECRET,VERIFY_TOKEN],
 timeoutSeconds:60
},async(req,res)=>{

 if(req.method==='GET'){
  if(
   req.query['hub.mode']==='subscribe'&&
   req.query['hub.verify_token']===VERIFY_TOKEN.value()
  ){
   res.status(200).send(String(req.query['hub.challenge']||''));
  }else{
   res.sendStatus(403);
  }
  return;
 }

 if(req.method!=='POST'){
  res.sendStatus(405);
  return;
 }

 if(!signatureOk(req)){
  res.sendStatus(403);
  return;
 }

 try{
  for(const entry of req.body?.entry||[]){
   for(const change of entry.changes||[]){
    if(change.field==='live_comments'){
     await handleComment(change.value||{});
    }
   }
  }

  res.sendStatus(200);
 }catch(err){
  console.error('Webhook:',err);
  res.sendStatus(500);
 }
});

// ============================================================
// MENSAGENS PARA WHATSAPP
// ============================================================

function formatSummary(reservations,deadlineMs){
 const brl=n=>new Intl.NumberFormat('pt-BR',{
  style:'currency',
  currency:'BRL'
 }).format(n);

 const confirmed=reservations.filter(r=>r.state==='reserved');
 const waiting=reservations.filter(r=>r.state==='waiting');

 const parts=[
  'Oi, garota! 💗',
  'Aqui está o resumo das suas escolhas na nossa live!',
  ''
 ];

 if(confirmed.length){
  parts.push('✨ PEÇAS GARANTIDAS');

  for(const r of confirmed){
   parts.push(
    `✅ ${r.codigo} — ${r.descricao}: ${brl(r.preco)}`
   );
  }

  parts.push(
   `💗 TOTAL RESERVADO: ${brl(
    confirmed.reduce((s,r)=>s+r.preco,0)
   )}`,
   ''
  );
 }

 if(waiting.length){
  parts.push('⏳ LISTA DE ESPERA');

  for(const r of waiting){
   parts.push(
    `• ${r.codigo} — ${r.descricao}: `+
    `${r.queuePosition||'posição a confirmar'}ª posição`
   );
  }

  parts.push('As peças na fila não entram no total.','');
 }

 if(confirmed.length){
  parts.push(
   'Para finalizar, responda PIX ou CARTÃO aqui no WhatsApp.'
  );

  if(deadlineMs){
   parts.push(
    `Prazo para pagamento: ${
     new Intl.DateTimeFormat('pt-BR',{
      timeZone:'America/Sao_Paulo',
      dateStyle:'short',
      timeStyle:'short'
     }).format(new Date(deadlineMs))
    } (horário de Brasília).`
   );
  }else{
   parts.push(
    'O pagamento deve ser feito até 2 horas após o encerramento da live.'
   );
  }
 }else{
  parts.push(
   'Você está na lista de espera. Responda esta mensagem '+
   'caso queira continuar em contato se alguma peça ficar disponível.'
  );
 }

 parts.push(
  'Obrigada por comprar comigo! 💗',
  'Luviê | Soluções em moda'
 );

 return parts.join('\n');
}

async function summaryRows(ref,key){
 const all=await ref.collection('reservations')
  .where('customerKey','==',key)
  .limit(400)
  .get();

 const reservations=all.docs.map(info)
  .filter(r=>['reserved','waiting'].includes(r.state))
  .sort((a,b)=>a.createdAtMs-b.createdAtMs);

 const byCode=new Map();

 for(const r of reservations){
  if(!byCode.has(r.codigo)){
   byCode.set(r.codigo,r);
  }
 }

 const rows=[...byCode.values()];

 for(const r of rows.filter(x=>x.state==='waiting')){
  const queue=await ref.collection('reservations')
   .where('codigo','==',r.codigo)
   .limit(400)
   .get();

  const ordered=queue.docs.map(info)
   .filter(x=>['reserved','waiting','sold'].includes(x.state))
   .sort((a,b)=>a.createdAtMs-b.createdAtMs);

  const position=ordered.findIndex(x=>x.id===r.id)+1;
  r.queuePosition=position>0?position:null;
 }

 return rows;
}

function normalizePhone(input){
 const digits=String(input||'').replace(/\D/g,'');

 if(
  !/^\d{12,15}$/.test(digits)||
  !digits.startsWith('55')
 ){
  throw new HttpsError(
   'invalid-argument',
   'Informe o WhatsApp com DDI 55 e DDD (ex.: 5511999999999)'
  );
 }

 return digits;
}

// ============================================================
// ADMINISTRAÇÃO DAS LIVES
// ============================================================

exports.adminLive=onCall({
 region:REGION,
 secrets:[ADMIN_UID],
 maxInstances:10
},async req=>{

 adminOnly(req);

 const {action,liveId}=req.data||{};

 // LISTAR LIVES
 if(action==='list'){
  const [ls,ctrl]=await Promise.all([
   db.collection('lives')
    .orderBy('createdAtMs','desc')
    .limit(50)
    .get(),
   controlRef.get()
  ]);

  return {
   lives:ls.docs.map(info),
   activeLiveId:ctrl.data()?.activeLiveId||null
  };
 }

 // CRIAR LIVE — CORRIGIDO
 if(action==='create'){
  const date=String(req.data?.date||'');

  if(
   !/^\d{4}-\d{2}-\d{2}$/.test(date)||
   Number.isNaN(Date.parse(`${date}T12:00:00Z`))
  ){
   throw new HttpsError('invalid-argument','Data inválida');
  }

  const newRef=db.collection('lives').doc();

  await newRef.create({
   date,
   status:'draft',
   salesClosed:false,
   createdAt:FV.serverTimestamp(),
   createdAtMs:Date.now(),
   startedAtMs:null,
   endedAtMs:null
  });

  return {id:newRef.id};
 }

 if(!validId(liveId)){
  throw new HttpsError('invalid-argument','Live inválida');
 }

 const ref=liveRef(liveId);

 // DETALHES DA LIVE — PEDIDOS E CLIENTES
 if(action==='detail'){
  const [
   live,
   products,
   reservations,
   customers
  ]=await Promise.all([
   ref.get(),
   ref.collection('products').limit(450).get(),
   ref.collection('reservations')
    .orderBy('createdAtMs','desc')
    .limit(500)
    .get(),
   ref.collection('customers').limit(500).get()
  ]);

  if(!live.exists){
   throw new HttpsError('not-found','Live não encontrada');
  }

  const directory=await Promise.all(
   customers.docs.map(c=>directoryRef(c.id).get())
  );

  return {
   live:info(live),
   products:products.docs.map(info),
   reservations:reservations.docs.map(info),
   customers:customers.docs.map((c,i)=>({
    ...info(c),
    ...(directory[i].exists?{
     whatsapp:
      directory[i].data().whatsapp||
      c.data().whatsapp||
      '',
     whatsappOptIn:
      directory[i].data().whatsappOptIn===true
    }:{})
   }))
  };
 }

 // IMPORTAR PEÇAS
 if(action==='import'){
  const pieces=req.data?.products;

  if(
   !Array.isArray(pieces)||
   pieces.length<1||
   pieces.length>400
  ){
   throw new HttpsError(
    'invalid-argument',
    'Envie de 1 a 400 peças por arquivo'
   );
  }

  const normalized=pieces.map(safeProduct);

  if(
   new Set(normalized.map(p=>p.codigo)).size!==normalized.length
  ){
   throw new HttpsError(
    'invalid-argument',
    'Códigos duplicados no TXT'
   );
  }

  await db.runTransaction(async tx=>{
   const l=await tx.get(ref);

   if(!l.exists||l.data().status!=='draft'){
    throw new HttpsError(
     'failed-precondition',
     'Importação permitida somente em lives não iniciadas'
    );
   }

   if(l.data().productsImported){
    throw new HttpsError(
     'already-exists',
     'Essa live já recebeu um arquivo TXT'
    );
   }

   tx.update(ref,{
    productsImported:true,
    productCount:normalized.length
   });

   normalized.forEach(p=>{
    tx.create(
     ref.collection('products').doc(p.codigo),
     {...p,createdAt:FV.serverTimestamp()}
    );
   });
  });

  return {count:normalized.length};
 }

 // INICIAR LIVE
 if(action==='start'){
  await db.runTransaction(async tx=>{
   const [c,l]=await Promise.all([
    tx.get(controlRef),
    tx.get(ref)
   ]);

   if(
    !l.exists||
    l.data().status!=='draft'||
    !l.data().productsImported
   ){
    throw new HttpsError(
     'failed-precondition',
     'Importe as peças antes de iniciar'
    );
   }

   if(c.data()?.activeLiveId){
    throw new HttpsError(
     'failed-precondition',
     'Já existe uma live ativa'
    );
   }

   tx.set(controlRef,{
    activeLiveId:liveId,
    updatedAt:FV.serverTimestamp()
   },{merge:true});

   tx.update(ref,{
    status:'active',
    salesClosed:false,
    startedAtMs:Date.now()
   });
  });

  return {ok:true};
 }

 // FECHAR VENDAS
 if(action==='closeSales'){
  await db.runTransaction(async tx=>{
   const [c,l]=await Promise.all([
    tx.get(controlRef),
    tx.get(ref)
   ]);

   if(
    c.data()?.activeLiveId!==liveId||
    !l.exists||
    l.data().status!=='active'
   ){
    throw new HttpsError(
     'failed-precondition',
     'Live não está ativa'
    );
   }

   if(!l.data().salesClosed){
    tx.update(ref,{
     salesClosed:true,
     salesClosedAtMs:Date.now()
    });
   }
  });

  return {ok:true};
 }

 // ENVIO AUTOMÁTICO DESATIVADO
 if(action==='sendNext'){
  throw new HttpsError(
   'invalid-argument',
   'O envio de DMs pelo Instagram foi desativado'
  );
 }

 // ENCERRAR LIVE
 if(action==='end'){
  const end=Date.now();

  await db.runTransaction(async tx=>{
   const [c,l]=await Promise.all([
    tx.get(controlRef),
    tx.get(ref)
   ]);

   if(
    c.data()?.activeLiveId!==liveId||
    !l.exists||
    l.data().status!=='active'
   ){
    throw new HttpsError(
     'failed-precondition',
     'Live não está ativa'
    );
   }

   if(!l.data().salesClosed){
    throw new HttpsError(
     'failed-precondition',
     'Feche as vendas antes de encerrar'
    );
   }

   tx.update(controlRef,{
    activeLiveId:null,
    updatedAt:FV.serverTimestamp()
   });

   tx.update(ref,{
    status:'ended',
    endedAtMs:end,
    hasPendingReservations:true
   });
  });

  return {
   ok:true,
   paymentDeadlineMs:end+TWO_HOURS
  };
 }

 // CONFIRMAR PAGAMENTO
 if(action==='markSold'){
  const reservationId=String(req.data?.reservationId||'');

  if(!reservationId||reservationId.length>200){
   throw new HttpsError(
    'invalid-argument',
    'Reserva inválida'
   );
  }

  const rref=ref.collection('reservations').doc(reservationId);

  await db.runTransaction(async tx=>{
   const [l,r]=await Promise.all([
    tx.get(ref),
    tx.get(rref)
   ]);

   if(
    !l.exists||
    l.data().status!=='ended'||
    !r.exists||
    r.data().state!=='reserved'
   ){
    throw new HttpsError(
     'failed-precondition',
     'Reserva não disponível para confirmação'
    );
   }

   const p=ref.collection('products').doc(r.data().codigo);
   const ps=await tx.get(p);

   if(
    !ps.exists||
    ps.data().activeReservationId!==reservationId
   ){
    throw new HttpsError(
     'failed-precondition',
     'Reserva não é a atual'
    );
   }

   tx.update(rref,{
    state:'sold',
    soldAtMs:Date.now(),
    confirmedManually:true
   });

   tx.update(p,{
    status:'vendido',
    activeReservationId:null
   });
  });

  return {ok:true};
 }

 throw new HttpsError(
  'invalid-argument',
  'Ação desconhecida'
 );
});

// ============================================================
// CADASTRO PERMANENTE E ATENDIMENTO MANUAL
// ============================================================

exports.adminCustomer=onCall({
 region:REGION,
 secrets:[ADMIN_UID]
},async req=>{

 adminOnly(req);

 const {
  action,
  liveId,
  customerKey:key
 }=req.data||{};

 if(
  !validId(liveId)||
  typeof key!=='string'||
  !/^[a-f0-9]{40}$/.test(key)
 ){
  throw new HttpsError(
   'invalid-argument',
   'Cliente ou live inválidos'
  );
 }

 const ref=liveRef(liveId);
 const customerRef=ref.collection('customers').doc(key);

 // SALVAR TELEFONE
 if(action==='savePhone'){
  const whatsapp=normalizePhone(req.data?.whatsapp);
  const optIn=req.data?.whatsappOptIn===true;

  await db.runTransaction(async tx=>{
   const c=await tx.get(customerRef);

   if(!c.exists){
    throw new HttpsError(
     'not-found',
     'Cliente não encontrada'
    );
   }

   const data=c.data();
   const globalRef=directoryRef(key);
   const aliasRef=data.username?
    handleRef(data.username):null;

   const [global,alias]=await Promise.all([
    tx.get(globalRef),
    aliasRef?tx.get(aliasRef):Promise.resolve(null)
   ]);

   if(
    global.exists&&
    global.data().userId&&
    data.userId&&
    global.data().userId!==data.userId
   ){
    throw new HttpsError(
     'failed-precondition',
     'Conflito de identidade do Instagram'
    );
   }

   const now=Date.now();

   tx.update(customerRef,{
    whatsapp,
    whatsappOptIn:optIn,
    phoneUpdatedAtMs:now,
    directoryKey:key
   });

   tx.set(globalRef,{
    instagramUsername:data.username||'',
    userId:data.userId||'',
    username:data.username||'',
    whatsapp,
    whatsappOptIn:optIn,
    updatedAtMs:now
   },{merge:true});

   if(
    aliasRef&&(
     !alias.exists||
     !alias.data().userId||
     alias.data().userId===data.userId
    )
   ){
    tx.set(aliasRef,{
     directoryKey:key,
     userId:data.userId||'',
     username:(data.username||'').toLowerCase(),
     updatedAtMs:now
    },{merge:true});
   }
  });

  return {ok:true};
 }

 // SALVAR RASCUNHO
 if(action==='saveDraft'){
  const draft=String(req.data?.draft||'');

  if(!draft.trim()||draft.length>12000){
   throw new HttpsError(
    'invalid-argument',
    'Mensagem deve ter entre 1 e 12000 caracteres'
   );
  }

  await db.runTransaction(async tx=>{
   const c=await tx.get(customerRef);

   if(!c.exists){
    throw new HttpsError(
     'not-found',
     'Cliente não encontrada'
    );
   }

   if(c.data().sendStatus==='sent'){
    throw new HttpsError(
     'failed-precondition',
     'Cliente já marcada como contatada'
    );
   }

   tx.update(customerRef,{
    messageDraft:draft,
    draftUpdatedAtMs:Date.now()
   });
  });

  return {ok:true};
 }

 // MARCAR MENSAGEM ENVIADA
 if(action==='markSent'){
  await db.runTransaction(async tx=>{
   const [c,g]=await Promise.all([
    tx.get(customerRef),
    tx.get(directoryRef(key))
   ]);

   if(!c.exists){
    throw new HttpsError(
     'not-found',
     'Cliente não encontrada'
    );
   }

   if(
    !c.data().whatsapp&&
    !g.data()?.whatsapp
   ){
    throw new HttpsError(
     'failed-precondition',
     'Cadastre o WhatsApp antes'
    );
   }

   if(c.data().sendStatus==='sent')return;

   tx.update(customerRef,{
    sendStatus:'sent',
    sentAtMs:Date.now(),
    contactMethod:'manual_whatsapp'
   });
  });

  return {ok:true};
 }

 // REABRIR ATENDIMENTO
 if(action==='reopen'){
  await db.runTransaction(async tx=>{
   const c=await tx.get(customerRef);

   if(!c.exists){
    throw new HttpsError(
     'not-found',
     'Cliente não encontrada'
    );
   }

   tx.update(customerRef,{
    sendStatus:'pending',
    sentAtMs:FV.delete()
   });
  });

  return {ok:true};
 }

 // PRÉVIA DA MENSAGEM
 if(action==='summary'){
  const [live,customer,global]=await Promise.all([
   ref.get(),
   customerRef.get(),
   directoryRef(key).get()
  ]);

  if(!live.exists||!customer.exists){
   throw new HttpsError(
    'not-found',
    'Live ou cliente não encontrado'
   );
  }

  const rows=await summaryRows(ref,key);

  if(!rows.length){
   throw new HttpsError(
    'failed-precondition',
    'Cliente sem reservas elegíveis'
   );
  }

  const deadline=live.data().endedAtMs?
   live.data().endedAtMs+TWO_HOURS:null;

  return {
   text:
    customer.data().messageDraft||
    formatSummary(rows,deadline),

   whatsapp:
    global.data()?.whatsapp||
    customer.data().whatsapp||
    '',

   whatsappOptIn:
    global.exists?
     global.data().whatsappOptIn===true:
     customer.data().whatsappOptIn===true,

   sendStatus:
    customer.data().sendStatus||'pending',

   deadlineMs:deadline
  };
 }

 throw new HttpsError(
  'invalid-argument',
  'Ação desconhecida'
 );
});

// ============================================================
// DESATIVAR DM AUTOMÁTICA DO INSTAGRAM
// ============================================================

exports.adminSendSummary=onCall({
 region:REGION,
 secrets:[ADMIN_UID]
},async req=>{
 adminOnly(req);

 throw new HttpsError(
  'failed-precondition',
  'Envio de DMs desativado. Utilize o atendimento manual pelo WhatsApp.'
 );
});

// ============================================================
// CONSULTAR RESERVAS
// ============================================================

exports.adminReservations=onCall({
 region:REGION,
 secrets:[ADMIN_UID]
},async req=>{
 adminOnly(req);

 const id=req.data?.liveId;

 if(!validId(id)){
  throw new HttpsError(
   'invalid-argument',
   'Informe a live'
  );
 }

 const s=await liveRef(id)
  .collection('reservations')
  .orderBy('createdAtMs','desc')
  .limit(500)
  .get();

 return {items:s.docs.map(info)};
});

// ============================================================
// EXPIRAÇÃO DAS RESERVAS E FILA DE ESPERA
// ============================================================

exports.expireReservations=onSchedule({
 schedule:'every 1 minutes',
 region:REGION
},async()=>{

 const now=Date.now();

 const ended=await db.collection('lives')
  .where('status','==','ended')
  .limit(100)
  .get();

 for(const live of ended.docs){
  if(
   !live.data().endedAtMs||
   live.data().endedAtMs+TWO_HOURS>now
  )continue;

  const products=await live.ref
   .collection('products')
   .limit(400)
   .get();

  for(const p of products.docs){
   if(!p.data().activeReservationId)continue;

   const current=live.ref
    .collection('reservations')
    .doc(p.data().activeReservationId);

   const queue=await live.ref
    .collection('reservations')
    .where('codigo','==',p.id)
    .limit(400)
    .get();

   const waiting=queue.docs
    .filter(s=>s.data().state==='waiting')
    .sort((a,b)=>
     a.data().createdAtMs-b.data().createdAtMs
    );

   await db.runTransaction(async tx=>{
    const [ps,rs,...ws]=await Promise.all([
     tx.get(p.ref),
     tx.get(current),
     ...waiting.slice(0,1).map(x=>tx.get(x.ref))
    ]);

    if(
     !ps.exists||
     ps.data().activeReservationId!==current.id||
     !rs.exists||
     rs.data().state!=='reserved'
    )return;

    const deadline=rs.data().promotedAtMs?
     rs.data().promotedAtMs+TWO_HOURS:
     live.data().endedAtMs+TWO_HOURS;

    if(deadline>Date.now())return;

    tx.update(current,{
     state:'expired',
     expiresAtMs:deadline
    });

    const next=ws[0];

    if(next?.exists&&next.data().state==='waiting'){
     const time=Date.now();

     tx.update(next.ref,{
      state:'reserved',
      promotedAtMs:time,
      expiresAtMs:time+TWO_HOURS,
      requiresManualContact:true
     });

     tx.update(p.ref,{
      activeReservationId:next.id,
      status:'reservado'
     });
    }else{
     tx.update(p.ref,{
      activeReservationId:null,
      status:'disponivel'
     });
    }
   });
  }
 }
});
