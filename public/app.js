'use strict';
const auth=firebase.auth();
const fn=firebase.app().functions('us-central1');
const adminLive=fn.httpsCallable('adminLive');
const el=id=>document.getElementById(id);
const brl=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n);
let items=[],lives=[],selected=null,activeId=null,detail=null,busy=false;
function msg(value,error=false){el('message').textContent=value;el('message').className=error?'error':'ok';}
function showError(e){msg(e?.message||String(e),true);}
function parseTXT(txt){
 const blocks=txt.replace(/\r/g,'').replace(/^\uFEFF/,'').trim().split(/\n\s*\n/);
 const seen=new Set(),result=[],issues=[];
 for(const [i,block] of blocks.entries()){
  if(!block.trim())continue;
  const lines=block.split('\n');
  const get=key=>{const line=lines.find(l=>l.trim().toLowerCase().startsWith(key+':'));return line?line.slice(line.indexOf(':')+1).trim():'';};
  const codigo=get('código')||get('codigo'),descricao=get('descrição')||get('descricao'),raw=get('preço')||get('preco');
  const preco=Number(raw.replace(/R\$|\s|\./gi,'').replace(',','.'));
  if(!/^\d{1,10}$/.test(codigo)||!descricao||!raw||!Number.isFinite(preco)||preco<=0){issues.push('Bloco '+(i+1)+' inválido');continue;}
  if(seen.has(codigo)){issues.push('Código repetido: '+codigo);continue;}
  seen.add(codigo);result.push({codigo,descricao,preco});
 }
 return {result,issues};
}
function line(container,title,sub,right){
 const row=document.createElement('div');row.className='row';
 const a=document.createElement('div'),b=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');
 strong.textContent=title;small.textContent=sub;a.append(strong,small);b.textContent=right||'';b.className='price';row.append(a,b);container.append(row);return row;
}
function render(){
 const live=lives.find(l=>l.id===selected);const status=live?.status||'';
 el('liveStatus').textContent=live?`Live de ${live.date} · ${status==='draft'?'Preparação':status==='active'?'AO VIVO':'Encerrada'}`:'Crie ou selecione uma live';
 el('startLive').disabled=busy||status!=='draft'||!live?.productsImported||!!activeId;
 el('endLive').disabled=busy||status!=='active'||activeId!==selected;
 el('file').disabled=busy||status!=='draft'||!!live?.productsImported;
 el('save').disabled=busy||!items.length||status!=='draft'||!!live?.productsImported;
 el('count').textContent=items.length+' peças no arquivo';
 el('total').textContent=brl(items.reduce((n,p)=>n+p.preco,0));
 el('preview').replaceChildren();items.forEach(p=>line(el('preview'),`${p.codigo} · ${p.descricao}`,'Quantidade: 1',brl(p.preco)));
 el('importNote').textContent=live?.productsImported?`Peças já importadas nesta live (${live.productCount||0}). Para outro TXT, crie outra live.`:'';
 el('reservations').replaceChildren();
 (detail?.reservations||[]).forEach(r=>{
  const labels={reserved:'Reservada',waiting:'Na fila',expired:'Expirada',sold:'Vendida'};
  const row=line(el('reservations'),`${r.codigo} · @${r.username||'perfil'}`,`${r.descricao} · ${labels[r.state]||r.state}`,brl(r.preco));
  if(r.state==='reserved'&&status==='ended'){
   const button=document.createElement('button');button.className='mini';button.textContent='Confirmar vendida';
   button.onclick=async()=>{
    if(!confirm('Confirmou o pagamento desta reserva por fora do aplicativo?'))return;
    await execute(async()=>{await adminLive({action:'markSold',liveId:selected,reservationId:r.id});await loadDetail();msg('Peça marcada como vendida.');});
   };row.append(button);
  }
 });
}
async function execute(callback){if(busy)return;busy=true;render();try{await callback();}catch(e){showError(e);}finally{busy=false;render();}}
async function loadLives(keep=true){
 const res=(await adminLive({action:'list'})).data;lives=res.lives||[];activeId=res.activeLiveId;
 if(!keep||!lives.some(x=>x.id===selected))selected=activeId||lives[0]?.id||null;
 el('liveSelect').replaceChildren();lives.forEach(l=>{const o=document.createElement('option');o.value=l.id;o.textContent=`${l.date} · ${l.status==='active'?'AO VIVO':l.status==='draft'?'Preparação':'Encerrada'} · ${l.id.slice(0,6)}`;el('liveSelect').append(o);});
 el('liveSelect').value=selected||'';render();
}
async function loadDetail(){if(!selected){detail=null;render();return;}detail=(await adminLive({action:'detail',liveId:selected})).data;render();}
el('login').onclick=()=>execute(async()=>{await auth.signInWithEmailAndPassword(el('email').value.trim(),el('password').value);msg('Login realizado');});
el('logout').onclick=()=>auth.signOut();
auth.onAuthStateChanged(async user=>{
 el('loginCard').classList.toggle('hidden',!!user);el('appCard').classList.toggle('hidden',!user);el('userLabel').textContent=user?.email||'';
 if(user){await execute(async()=>{await loadLives(false);await loadDetail();});}else{lives=[];selected=null;activeId=null;detail=null;}
});
// Data local, sem deslocamento UTC
const d=new Date();el('liveDate').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
el('createLive').onclick=()=>execute(async()=>{const r=(await adminLive({action:'create',date:el('liveDate').value})).data;selected=r.id;items=[];el('file').value='';await loadLives();await loadDetail();msg('Nova live criada! Agora importe seu TXT.');});
el('liveSelect').onchange=()=>execute(async()=>{selected=el('liveSelect').value;items=[];el('file').value='';await loadDetail();});
el('refresh').onclick=()=>execute(async()=>{await loadLives();await loadDetail();msg('Atualizado');});
el('file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const {result,issues}=parseTXT(await f.text());items=issues.length?[]:result;render();msg(issues.length?'Corrija antes de importar:\n'+issues.join('\n'):'TXT lido. Confira e clique em Cadastrar peças.',!!issues.length);}catch(e){items=[];render();showError(e);}};
el('clear').onclick=()=>{items=[];el('file').value='';render();msg('Seleção limpa');};
el('save').onclick=()=>execute(async()=>{await adminLive({action:'import',liveId:selected,products:items});items=[];el('file').value='';await loadLives();await loadDetail();msg('Peças cadastradas exclusivamente nesta live!');});
el('startLive').onclick=()=>execute(async()=>{if(!confirm('Iniciar monitoramento dos comentários desta live?'))return;await adminLive({action:'start',liveId:selected});await loadLives();await loadDetail();msg('Monitoramento ATIVO. Comentários serão associados a esta live.');});
el('endLive').onclick=()=>execute(async()=>{if(!confirm('Encerrar esta live? Novos comentários serão ignorados e começa o prazo de pagamento de duas horas.'))return;await adminLive({action:'end',liveId:selected});await loadLives();await loadDetail();msg('Live encerrada. Prazo de pagamento iniciado.');});