
'use strict';
const auth=firebase.auth(),fn=firebase.app().functions('us-central1');
const adminLive=fn.httpsCallable('adminLive'),adminSendSummary=fn.httpsCallable('adminSendSummary');
const el=id=>document.getElementById(id),brl=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);
let items=[],lives=[],selected=null,activeId=null,detail=null,busy=false,sending=false,refreshing=false,pollTimer=null;
function msg(value,error=false){el('message').textContent=value;el('message').className=error?'error':'ok';}
function showError(e){msg(e?.message||String(e),true);}
function parseTXT(txt){const blocks=txt.replace(/\r/g,'').replace(/^\uFEFF/,'').trim().split(/\n\s*\n/),seen=new Set(),result=[],issues=[];for(const [i,block] of blocks.entries()){if(!block.trim())continue;const lines=block.split('\n');const get=key=>{const line=lines.find(l=>l.trim().toLowerCase().startsWith(key+':'));return line?line.slice(line.indexOf(':')+1).trim():'';};const codigo=get('código')||get('codigo'),descricao=get('descrição')||get('descricao'),raw=get('preço')||get('preco'),preco=Number(raw.replace(/R\$|\s|\./gi,'').replace(',','.'));if(!/^\d{1,10}$/.test(codigo)||!descricao||!raw||!Number.isFinite(preco)||preco<=0){issues.push('Bloco '+(i+1)+' inválido');continue;}if(seen.has(codigo)){issues.push('Código repetido: '+codigo);continue;}seen.add(codigo);result.push({codigo,descricao,preco});}return {result,issues};}
function line(container,title,sub,right){const row=document.createElement('div');row.className='row';const a=document.createElement('div'),b=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=title;small.textContent=sub;a.append(strong,small);b.textContent=right||'';b.className='price';row.append(a,b);container.append(row);return row;}
function render(){
 const live=lives.find(l=>l.id===selected),status=detail?.live?.status||live?.status||'',closed=!!detail?.live?.salesClosed;
 el('liveStatus').textContent=live?`Live de ${live.date} · ${status==='draft'?'Preparação':status==='active'?'AO VIVO':'Encerrada'}${closed?' · VENDAS FECHADAS':''}`:'Crie ou selecione uma live';
 el('startLive').disabled=busy||sending||status!=='draft'||!live?.productsImported||!!activeId;
 el('closeSales').disabled=busy||sending||status!=='active'||closed||activeId!==selected;
 const customers=detail?.customers||[],pending=customers.filter(c=>c.sendStatus==='pending'),review=customers.filter(c=>c.sendStatus==='review');
 el('sendReservations').disabled=busy||sending||status!=='active'||!closed||!pending.length;
 el('endLive').disabled=busy||sending||status!=='active'||!closed||activeId!==selected||pending.length>0||customers.some(c=>c.sendStatus==='sending');
 el('file').disabled=busy||status!=='draft'||!!live?.productsImported;
 el('save').disabled=busy||!items.length||status!=='draft'||!!live?.productsImported;
 el('count').textContent=items.length+' peças no arquivo';el('total').textContent=brl(items.reduce((n,p)=>n+p.preco,0));
 el('preview').replaceChildren();items.forEach(p=>line(el('preview'),`${p.codigo} · ${p.descricao}`,'Quantidade: 1',brl(p.preco)));
 el('importNote').textContent=live?.productsImported?`Peças já importadas nesta live (${live.productCount||0}). Para outro TXT, crie outra live.`:'';
 const reservations=detail?.reservations||[];
 el('stats').textContent=`${customers.length} clientes · ${reservations.filter(r=>r.state==='reserved').length} reservadas · ${reservations.filter(r=>r.state==='waiting').length} na fila · ${brl(reservations.filter(r=>r.state==='reserved').reduce((s,r)=>s+r.preco,0))} reservados`;
 el('sendProgress').textContent=`Resumos: ${customers.filter(c=>c.sendStatus==='sent').length} enviados · ${pending.length} pendentes · ${review.length} exigem revisão`;
 el('reservations').replaceChildren();reservations.forEach(r=>{const labels={reserved:'Reservada',waiting:'Na fila',expired:'Expirada',sold:'Vendida'};const row=line(el('reservations'),`${r.codigo} · @${r.username||'perfil'}`,`${r.descricao} · ${labels[r.state]||r.state}`,brl(r.preco));if(r.state==='reserved'&&status==='ended'){const button=document.createElement('button');button.className='mini';button.textContent='Confirmar vendida';button.onclick=async()=>{if(!confirm('Confirmou o pagamento desta reserva por fora do aplicativo?'))return;await execute(async()=>{await adminLive({action:'markSold',liveId:selected,reservationId:r.id});await loadDetail();msg('Peça marcada como vendida.');});};row.append(button);}});
 el('customers').replaceChildren();customers.forEach(c=>{const label={pending:'Aguardando envio',sending:'Enviando',sent:'Enviado',review:'Revisar falha'};line(el('customers'),`@${c.username||'perfil'}`,label[c.sendStatus]||'Pendente','');});
}
async function execute(callback){if(busy)return;busy=true;render();try{await callback();}catch(e){showError(e);}finally{busy=false;render();}}
async function loadLives(keep=true){const res=(await adminLive({action:'list'})).data;lives=res.lives||[];activeId=res.activeLiveId;if(!keep||!lives.some(x=>x.id===selected))selected=activeId||lives[0]?.id||null;el('liveSelect').replaceChildren();lives.forEach(l=>{const o=document.createElement('option');o.value=l.id;o.textContent=`${l.date} · ${l.status==='active'?'AO VIVO':l.status==='draft'?'Preparação':'Encerrada'} · ${l.id.slice(0,6)}`;el('liveSelect').append(o);});el('liveSelect').value=selected||'';render();}
async function loadDetail(){if(!selected){detail=null;render();return;}const id=selected,data=(await adminLive({action:'detail',liveId:id})).data;if(selected!==id)return;detail=data;render();}
async function poll(){if(refreshing||busy||sending||!auth.currentUser||!selected)return;refreshing=true;try{await loadDetail();}catch(e){console.warn('Atualização do painel:',e);}finally{refreshing=false;}}
function startPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(poll,3000);}
el('login').onclick=()=>execute(async()=>{await auth.signInWithEmailAndPassword(el('email').value.trim(),el('password').value);msg('Login realizado');});
el('logout').onclick=()=>auth.signOut();
auth.onAuthStateChanged(async user=>{el('loginCard').classList.toggle('hidden',!!user);el('appCard').classList.toggle('hidden',!user);el('userLabel').textContent=user?.email||'';if(pollTimer)clearInterval(pollTimer);if(user){await execute(async()=>{await loadLives(false);await loadDetail();});startPolling();}else{lives=[];selected=null;activeId=null;detail=null;}});
const d=new Date();el('liveDate').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
el('createLive').onclick=()=>execute(async()=>{const r=(await adminLive({action:'create',date:el('liveDate').value})).data;selected=r.id;items=[];el('file').value='';await loadLives();await loadDetail();msg('Nova live criada! Agora importe seu TXT.');});
el('liveSelect').onchange=()=>execute(async()=>{selected=el('liveSelect').value;items=[];el('file').value='';await loadDetail();});
el('refresh').onclick=()=>execute(async()=>{await loadLives();await loadDetail();msg('Atualizado');});
el('file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const {result,issues}=parseTXT(await f.text());items=issues.length?[]:result;render();msg(issues.length?'Corrija antes de importar:\n'+issues.join('\n'):'TXT lido. Confira e clique em Cadastrar peças.',!!issues.length);}catch(e){items=[];render();showError(e);}};
el('clear').onclick=()=>{items=[];el('file').value='';render();msg('Seleção limpa');};
el('save').onclick=()=>execute(async()=>{await adminLive({action:'import',liveId:selected,products:items});items=[];el('file').value='';await loadLives();await loadDetail();msg('Peças cadastradas exclusivamente nesta live!');});
el('startLive').onclick=()=>execute(async()=>{if(!confirm('Iniciar monitoramento dos comentários desta live?'))return;await adminLive({action:'start',liveId:selected});await loadLives();await loadDetail();msg('Monitoramento ATIVO. Reservas aparecerão automaticamente.');});
el('closeSales').onclick=()=>execute(async()=>{if(!confirm('Fechar vendas? Novos códigos deixarão de ser aceitos. Mantenha a transmissão do Instagram ativa para enviar os resumos.'))return;await adminLive({action:'closeSales',liveId:selected});await loadDetail();msg('Vendas fechadas. Agora clique em Enviar reservas, com a live ainda no ar.');});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
el('sendReservations').onclick=async()=>{
 if(busy||sending||!selected||!detail?.live?.salesClosed)return;
 if(!confirm('Enviar um resumo por cliente agora? Mantenha a live do Instagram ativa até concluir os envios.'))return;
 sending=true;render();const id=selected;
 try{
  // Snapshot dos destinatários. Cada chamada faz claim atômico; não reenvia status sent/review.
  const customers=(detail?.customers||[]).filter(c=>c.sendStatus==='pending');let sent=0,failed=0;
  for(const c of customers){
   if(!auth.currentUser)break;
   try{const r=(await adminSendSummary({liveId:id,customerKey:c.id})).data;if(r.ok)sent++;else if(r.needsReview)failed++;}catch(e){failed++;console.error('Envio de resumo:',e);}
   msg(`Enviando reservas: ${sent+failed} de ${customers.length} processadas · ${sent} aceitas · ${failed} para revisar`);
   await loadDetail();await sleep(1000);
  }
  await loadDetail();msg(`Envio concluído: ${sent} aceitas pela Meta, ${failed} para revisão.${failed?' Não reenvie automaticamente as falhas.':''}`,!!failed);
 }catch(e){showError(e);}finally{sending=false;render();}
};
el('endLive').onclick=()=>execute(async()=>{if(!confirm('Encerrar esta live? Confira os resumos e mantenha a live do Instagram ativa até terminar os envios. Começa o prazo de pagamento de duas horas.'))return;await adminLive({action:'end',liveId:selected});await loadLives();await loadDetail();msg('Live encerrada. Prazo de pagamento iniciado.');});
