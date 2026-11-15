
'use strict';
const auth=firebase.auth(),fn=firebase.app().functions('us-central1');
const adminLive=fn.httpsCallable('adminLive'),adminCustomer=fn.httpsCallable('adminCustomer');
const el=id=>document.getElementById(id),brl=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);
let items=[],lives=[],selected=null,activeId=null,detail=null,busy=false,refreshing=false,pollTimer=null,editorKey=null,editorDirty=false,editorBusy=false;
function msg(value,error=false){el('message').textContent=value;el('message').className=error?'error':'ok';}
function showError(e){msg(e?.message||String(e),true);}
function parseTXT(txt){const blocks=txt.replace(/\r/g,'').replace(/^\uFEFF/,'').trim().split(/\n\s*\n/),seen=new Set(),result=[],issues=[];for(const [i,block] of blocks.entries()){if(!block.trim())continue;const lines=block.split('\n');const get=key=>{const line=lines.find(l=>l.trim().toLowerCase().startsWith(key+':'));return line?line.slice(line.indexOf(':')+1).trim():'';};const codigo=get('código')||get('codigo'),descricao=get('descrição')||get('descricao'),raw=get('preço')||get('preco'),preco=Number(raw.replace(/R\$|\s|\./gi,'').replace(',','.'));if(!/^\d{1,10}$/.test(codigo)||!descricao||!raw||!Number.isFinite(preco)||preco<=0){issues.push('Bloco '+(i+1)+' inválido');continue;}if(seen.has(codigo)){issues.push('Código repetido: '+codigo);continue;}seen.add(codigo);result.push({codigo,descricao,preco});}return {result,issues};}
function line(container,title,sub,right){const row=document.createElement('div');row.className='row';const a=document.createElement('div'),b=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=title;small.textContent=sub;a.append(strong,small);b.textContent=right||'';b.className='price';row.append(a,b);container.append(row);return row;}
function render(){
 const live=lives.find(l=>l.id===selected),status=detail?.live?.status||live?.status||'',closed=!!detail?.live?.salesClosed;
 el('liveStatus').textContent=live?`Live de ${live.date} · ${status==='draft'?'Preparação':status==='active'?'AO VIVO':'Encerrada'}${closed?' · VENDAS FECHADAS':''}`:'Crie ou selecione uma live';
 el('startLive').disabled=busy||status!=='draft'||!live?.productsImported||!!activeId;
 el('closeSales').disabled=busy||status!=='active'||closed||activeId!==selected;
 const customers=detail?.customers||[],pending=customers.filter(c=>c.sendStatus!=='sent'),sent=customers.filter(c=>c.sendStatus==='sent');
 el('sendReservations').disabled=busy||!closed||!customers.length;
 el('endLive').disabled=busy||status!=='active'||!closed||activeId!==selected;
 el('file').disabled=busy||status!=='draft'||!!live?.productsImported;
 el('save').disabled=busy||!items.length||status!=='draft'||!!live?.productsImported;
 el('count').textContent=items.length+' peças no arquivo';el('total').textContent=brl(items.reduce((n,p)=>n+p.preco,0));
 el('preview').replaceChildren();items.forEach(p=>line(el('preview'),`${p.codigo} · ${p.descricao}`,'Quantidade: 1',brl(p.preco)));
 el('importNote').textContent=live?.productsImported?`Peças já importadas nesta live (${live.productCount||0}). Para outro TXT, crie outra live.`:'';
 const reservations=detail?.reservations||[];
 el('stats').textContent=`${customers.length} clientes · ${reservations.filter(r=>r.state==='reserved').length} reservadas · ${reservations.filter(r=>r.state==='waiting').length} na fila · ${brl(reservations.filter(r=>r.state==='reserved').reduce((s,r)=>s+r.preco,0))} reservados`;
 el('sendProgress').textContent=`WhatsApp manual: ${sent.length} marcadas como enviadas · ${pending.length} pendentes`;
 el('reservations').replaceChildren();reservations.forEach(r=>{const labels={reserved:'Reservada',waiting:'Na fila',expired:'Expirada',sold:'Vendida'};const row=line(el('reservations'),`${r.codigo} · @${r.username||'perfil'}`,`${r.descricao} · ${labels[r.state]||r.state}`,brl(r.preco));if(r.state==='reserved'&&status==='ended'){const button=document.createElement('button');button.className='mini';button.textContent='Confirmar vendida';button.onclick=async()=>{if(!confirm('Confirmou o pagamento desta reserva por fora do aplicativo?'))return;await execute(async()=>{await adminLive({action:'markSold',liveId:selected,reservationId:r.id});await loadDetail();msg('Peça marcada como vendida.');});};row.append(button);}});
 el('customers').replaceChildren();customers.forEach(c=>{const label=c.sendStatus==='sent'?'Contatada':c.sendStatus==='review'?'Revisar':'Pendente';const row=line(el('customers'),`@${c.username||'perfil'}`,`${label} · ${c.whatsapp||'WhatsApp não cadastrado'}`,'');const button=document.createElement('button');button.className='mini';button.textContent='Revisar mensagem';button.onclick=()=>openEditor(c.id);row.append(button);});
 if(editorKey){const c=customers.find(x=>x.id===editorKey);if(!c){editorKey=null;el('editorCard').classList.add('hidden');}else{el('editorTitle').textContent=`Mensagem para @${c.username||'perfil'}`;el('editorNote').textContent=c.sendStatus==='sent'?'Marcada como enviada':`Status: ${c.sendStatus||'pending'}`;el('markContacted').disabled=editorBusy||c.sendStatus==='sent'||!c.whatsapp;el('reopenCustomer').disabled=editorBusy||c.sendStatus!=='sent';}}
}
async function execute(callback){if(busy)return;busy=true;render();try{await callback();}catch(e){showError(e);}finally{busy=false;render();}}
async function loadLives(keep=true){const res=(await adminLive({action:'list'})).data;lives=res.lives||[];activeId=res.activeLiveId;if(!keep||!lives.some(x=>x.id===selected))selected=activeId||lives[0]?.id||null;el('liveSelect').replaceChildren();lives.forEach(l=>{const o=document.createElement('option');o.value=l.id;o.textContent=`${l.date} · ${l.status==='active'?'AO VIVO':l.status==='draft'?'Preparação':'Encerrada'} · ${l.id.slice(0,6)}`;el('liveSelect').append(o);});el('liveSelect').value=selected||'';render();}
async function loadDetail(){if(!selected){detail=null;render();return;}const id=selected,data=(await adminLive({action:'detail',liveId:id})).data;if(selected!==id)return;detail=data;render();}
async function poll(){if(refreshing||busy||editorBusy||!auth.currentUser||!selected)return;refreshing=true;try{await loadDetail();}catch(e){console.warn('Atualização do painel:',e);}finally{refreshing=false;}}
function startPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(poll,3000);}
async function openEditor(key){if(editorDirty&&!confirm('Descartar alterações não salvas da mensagem?'))return;const liveId=selected;editorKey=key;editorDirty=false;el('editorCard').classList.remove('hidden');el('editorStatus').textContent='Carregando resumo...';try{const result=(await adminCustomer({action:'summary',liveId,customerKey:key})).data;if(selected!==liveId||editorKey!==key)return;el('customerPhone').value=result.whatsapp||'';el('customerOptIn').checked=result.whatsappOptIn;el('customerMessage').value=result.text;el('editorStatus').textContent=result.deadlineMs?`Prazo de pagamento: ${new Date(result.deadlineMs).toLocaleString('pt-BR')}`:'Prazo de pagamento começa ao encerrar a live.';render();el('editorCard').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){showError(e);el('editorStatus').textContent='Não foi possível preparar o resumo.';}}
function editorArgs(action,extra={}){return {action,liveId:selected,customerKey:editorKey,...extra};}
async function editorAction(callback){if(editorBusy||!editorKey)return;editorBusy=true;render();try{await callback();}catch(e){showError(e);}finally{editorBusy=false;render();}}
el('customerMessage').addEventListener('input',()=>{editorDirty=true;});
el('savePhone').onclick=()=>editorAction(async()=>{const whatsapp=el('customerPhone').value,whatsappOptIn=el('customerOptIn').checked;await adminCustomer(editorArgs('savePhone',{whatsapp,whatsappOptIn}));await loadDetail();msg('WhatsApp salvo no cadastro permanente. Será reutilizado nas próximas lives.');});
el('saveDraft').onclick=()=>editorAction(async()=>{await adminCustomer(editorArgs('saveDraft',{draft:el('customerMessage').value}));editorDirty=false;msg('Mensagem salva.');});
el('openWhatsapp').onclick=async()=>{
 if(!editorKey||editorBusy)return;
 const phone=el('customerPhone').value.replace(/\D/g,''),text=el('customerMessage').value;
 if(!/^55\d{10,13}$/.test(phone)){msg('Cadastre e salve um WhatsApp válido com DDI 55.',true);return;}
 const customer=detail?.customers?.find(c=>c.id===editorKey);
 if(customer?.whatsapp!==phone){msg('Salve o telefone antes de abrir o WhatsApp.',true);return;}
 if(!el('customerOptIn').checked||customer?.whatsappOptIn!==true){msg('Registre e salve a autorização de contato da cliente antes de abrir o WhatsApp.',true);return;}
 if(!text.trim()){msg('A mensagem está vazia.',true);return;}
 // Abrir na interação do clique evita bloqueio de pop-up em navegadores móveis.
 const url=`https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
 const opened=window.open(url,'_blank','noopener,noreferrer');if(!opened)window.location.href=url;
 msg('Conversa aberta. Depois de enviar no WhatsApp, volte e marque como enviada.');
};
el('markContacted').onclick=()=>editorAction(async()=>{if(!confirm('Você já apertou ENVIAR no WhatsApp? O painel não consegue verificar isso automaticamente.'))return;await adminCustomer(editorArgs('markSent'));await loadDetail();msg('Cliente marcada como contatada.');});
el('reopenCustomer').onclick=()=>editorAction(async()=>{if(!confirm('Reabrir atendimento desta cliente?'))return;await adminCustomer(editorArgs('reopen'));await loadDetail();msg('Atendimento reaberto.');});
el('login').onclick=()=>execute(async()=>{await auth.signInWithEmailAndPassword(el('email').value.trim(),el('password').value);msg('Login realizado');});
el('logout').onclick=()=>auth.signOut();
auth.onAuthStateChanged(async user=>{el('loginCard').classList.toggle('hidden',!!user);el('appCard').classList.toggle('hidden',!user);el('userLabel').textContent=user?.email||'';if(pollTimer)clearInterval(pollTimer);if(user){await execute(async()=>{await loadLives(false);await loadDetail();});startPolling();}else{lives=[];selected=null;activeId=null;detail=null;editorKey=null;editorDirty=false;el('editorCard').classList.add('hidden');}});
const d=new Date();el('liveDate').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
el('createLive').onclick=()=>execute(async()=>{const r=(await adminLive({action:'create',date:el('liveDate').value})).data;selected=r.id;editorKey=null;editorDirty=false;el('editorCard').classList.add('hidden');items=[];el('file').value='';await loadLives();await loadDetail();msg('Nova live criada! Agora importe seu TXT.');});
el('liveSelect').onchange=()=>execute(async()=>{if(editorDirty&&!confirm('Descartar alterações não salvas?')){el('liveSelect').value=selected;return;}selected=el('liveSelect').value;editorKey=null;editorDirty=false;el('editorCard').classList.add('hidden');items=[];el('file').value='';await loadDetail();});
el('refresh').onclick=()=>execute(async()=>{await loadLives();await loadDetail();msg('Atualizado');});
el('file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const {result,issues}=parseTXT(await f.text());items=issues.length?[]:result;render();msg(issues.length?'Corrija antes de importar:\n'+issues.join('\n'):'TXT lido. Confira e clique em Cadastrar peças.',!!issues.length);}catch(e){items=[];render();showError(e);}};
el('clear').onclick=()=>{items=[];el('file').value='';render();msg('Seleção limpa');};
el('save').onclick=()=>execute(async()=>{await adminLive({action:'import',liveId:selected,products:items});items=[];el('file').value='';await loadLives();await loadDetail();msg('Peças cadastradas exclusivamente nesta live!');});
el('startLive').onclick=()=>execute(async()=>{if(!confirm('Iniciar monitoramento dos comentários desta live?'))return;await adminLive({action:'start',liveId:selected});await loadLives();await loadDetail();msg('Monitoramento ATIVO. Reservas aparecerão automaticamente.');});
el('closeSales').onclick=()=>execute(async()=>{if(!confirm('Fechar vendas? Novos códigos deixarão de ser aceitos.'))return;await adminLive({action:'closeSales',liveId:selected});await loadDetail();msg('Vendas fechadas. Você já pode encerrar a live e revisar as mensagens.');});
el('sendReservations').onclick=()=>{if(!detail?.customers?.length)return;el('customers').scrollIntoView({behavior:'smooth',block:'start'});msg('Selecione uma cliente em Resumos por cliente para preparar a mensagem.');};
el('endLive').onclick=()=>execute(async()=>{if(!confirm('Encerrar esta live? O prazo de pagamento de duas horas começa agora, mesmo para clientes ainda não contatadas.'))return;await adminLive({action:'end',liveId:selected});await loadLives();await loadDetail();msg('Live encerrada. Prazo de pagamento iniciado.');});
