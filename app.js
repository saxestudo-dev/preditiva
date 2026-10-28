const $ = id => document.getElementById(id);
let currentUser = null, notes = [], users = [], deferredInstall = null, selectedAttachmentNote = null;
const today = () => new Date().toISOString().slice(0,10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');setTimeout(()=>$('toast').classList.add('hidden'),3200)}
async function api(url, options={}) {
  const opts={credentials:'same-origin',...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(options.headers||{})}};
  const res=await fetch(url,opts);
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||`Erro ${res.status}`);
  return data;
}
function datePt(d){if(!d)return '—';const s=String(d).slice(0,10);const [y,m,day]=s.split('-');return `${day}/${m}/${y}`}
function statusOf(n){
  if(n.delivered_date)return {key:'done',label:'Entregue / arquivado',cls:'b-green'};
  if(!n.communication_date && today()>String(n.communication_due).slice(0,10))return {key:'comm',label:'Comunicação pendente',cls:'b-red'};
  if(!n.communication_date)return {key:'active',label:'Aguardando comunicação',cls:'b-amber'};
  if(n.delivery_due && today()>String(n.delivery_due).slice(0,10))return {key:'late',label:'Entrega atrasada',cls:'b-red'};
  if(n.delivery_due && (new Date(n.delivery_due+'T12:00:00Z')-new Date(today()+'T12:00:00Z'))/86400000<=5)return {key:'soon',label:'Entrega próxima',cls:'b-amber'};
  return {key:'active',label:'No prazo',cls:'b-green'};
}
function canManage(){return ['ordenador','admin'].includes(currentUser?.role)}
async function loadUsers(){
  const data=await api('/api/users');users=data.users;
  const own=$('owner');own.innerHTML='';
  const selectable=canManage()?users:users.filter(u=>Number(u.id)===Number(currentUser.id));
  selectable.forEach(u=>own.add(new Option(`${u.display_name} (${u.email})`,u.id)));
  if(!canManage()){own.value=String(currentUser.id);own.disabled=true;}else own.disabled=false;
}
async function loadNotes(){
  const data=await api('/api/notes');notes=data.notes;renderNotes();renderStats();
}
function renderStats(){
  const states=notes.map(n=>statusOf(n));
  $('openCount').textContent=states.filter(s=>s.key!=='done').length;
  $('commCount').textContent=states.filter(s=>s.key==='comm').length;
  $('soonCount').textContent=states.filter(s=>s.key==='soon').length;
  $('lateCount').textContent=states.filter(s=>s.key==='late').length;
}
function renderNotes(){
  const q=$('search').value.trim().toLowerCase(), filter=$('statusFilter').value;
  const arr=notes.filter(n=>{
    const hay=[n.ne_number,n.ug,n.supplier,n.object_description,n.owner_name].join(' ').toLowerCase();
    return (!q||hay.includes(q))&&(!filter||statusOf(n).key===filter);
  });
  if(!arr.length){$('notesList').innerHTML='<div class="empty">Nenhum empenho encontrado.</div>';return}
  $('notesList').innerHTML=`<div class="tablewrap"><table><thead><tr><th>NE / Fornecedor</th><th>Responsável</th><th>Comunicação</th><th>Entrega</th><th>Situação</th><th>Ações</th></tr></thead><tbody>${arr.map(n=>{
    const s=statusOf(n);
    return `<tr><td><b>${esc(n.ne_number)}</b><br>${esc(n.supplier)}<br><span class="muted">${esc(n.object_description)}</span></td><td>${esc(n.owner_name)}</td><td>${datePt(n.communication_date)}<br><span class="muted">Limite: ${datePt(n.communication_due)}</span></td><td>${datePt(n.delivery_due)}<br><span class="muted">${n.delivery_days} dias corridos</span></td><td><span class="badge ${s.cls}">${s.label}</span></td><td><div class="stack"><button data-edit="${n.id}">Editar</button><button data-files="${n.id}">Comprovantes</button><button data-history="${n.id}">Histórico</button>${n.delivered_date?`<button data-reopen="${n.id}">Reabrir</button>`:`<button data-deliver="${n.id}">Registrar entrega</button>`}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
  $('notesList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editNote(b.dataset.edit));
  $('notesList').querySelectorAll('[data-files]').forEach(b=>b.onclick=()=>selectAttachments(b.dataset.files));
  $('notesList').querySelectorAll('[data-history]').forEach(b=>b.onclick=()=>showHistory(b.dataset.history));
  $('notesList').querySelectorAll('[data-deliver]').forEach(b=>b.onclick=()=>deliverNote(b.dataset.deliver));
  $('notesList').querySelectorAll('[data-reopen]').forEach(b=>b.onclick=()=>reopenNote(b.dataset.reopen));
}
function resetForm(){
  $('noteForm').reset();$('noteId').value='';$('formTitle').textContent='＋ Registrar empenho';
  $('cancelEdit').classList.add('hidden');$('owner').disabled=!canManage();if(!canManage())$('owner').value=String(currentUser.id);
}
function editNote(id){
  const n=notes.find(x=>String(x.id)===String(id));if(!n)return;
  $('noteId').value=n.id;$('ne').value=n.ne_number;$('ug').value=n.ug;$('supplier').value=n.supplier;
  $('object').value=n.object_description;$('owner').value=n.owner_user_id;$('issued').value=String(n.issued_date).slice(0,10);
  $('communication').value=n.communication_date?String(n.communication_date).slice(0,10):'';
  $('days').value=n.delivery_days;$('reference').value=n.communication_reference;$('notes').value=n.notes;
  $('formTitle').textContent='Editar empenho';$('cancelEdit').classList.remove('hidden');window.scrollTo({top:0,behavior:'smooth'});
}
$('noteForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const body={ne_number:$('ne').value,ug:$('ug').value,supplier:$('supplier').value,object_description:$('object').value,
      owner_user_id:Number($('owner').value),issued_date:$('issued').value,communication_date:$('communication').value||null,
      delivery_days:Number($('days').value),communication_reference:$('reference').value,notes:$('notes').value};
    const id=$('noteId').value;
    await api(id?`/api/notes/${id}`:'/api/notes',{method:id?'PATCH':'POST',body:JSON.stringify(body)});
    resetForm();await loadNotes();toast('Empenho salvo no banco central.');
  }catch(err){toast(err.message)}
});
$('cancelEdit').onclick=resetForm;
$('refreshBtn').onclick=async()=>{try{await loadNotes();toast('Dados atualizados.')}catch(e){toast(e.message)}};
$('search').addEventListener('input',renderNotes);$('statusFilter').addEventListener('change',renderNotes);
$('uploadForm').addEventListener('submit',async e=>{
  e.preventDefault();const id=$('uploadNoteId').value,files=$('proofFiles').files;
  if(!id)return toast('Selecione “Comprovantes” em um empenho primeiro.');
  if(!files.length)return toast('Escolha pelo menos um PDF ou imagem.');
  const fd=new FormData();for(const f of files)fd.append('files',f);
  try{const r=await api(`/api/notes/${id}/attachments`,{method:'POST',body:fd});$('proofFiles').value='';toast(`${r.attachments.length} arquivo(s) enviados.`);await selectAttachments(id)}catch(e){toast(e.message)}
});
async function selectAttachments(id){
  selectedAttachmentNote=id;$('uploadNoteId').value=id;
  try{
    const r=await api(`/api/notes/${id}/attachments`);
    $('attachmentList').innerHTML=r.attachments.length?r.attachments.map(a=>`<div class="row"><span>${esc(a.original_name)} <span class="muted">(${Math.round(a.size_bytes/1024)} KB)</span></span><a href="/api/attachments/${a.id}/download">Baixar</a></div>`).join(''):'Nenhum comprovante anexado.';
  }catch(e){toast(e.message)}
}
async function showHistory(id){
  try{const r=await api(`/api/notes/${id}/history`);$('historyList').innerHTML=r.history.length?r.history.map(h=>`<div class="panel"><b>${esc(h.action)}</b> · ${esc(h.display_name||'Sistema')}<p>${new Date(h.created_at).toLocaleString('pt-BR')}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(h.detail,null,2))}</pre></div>`).join(''):'Sem registros de histórico.';document.querySelector('#historyList').scrollIntoView({behavior:'smooth'})}catch(e){toast(e.message)}
}
async function deliverNote(id){
  const n=notes.find(x=>String(x.id)===String(id));if(!n)return;
  const date=prompt(`Data da entrega para ${n.ne_number} (AAAA-MM-DD):`,today());if(!date)return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return toast('Use o formato AAAA-MM-DD.');
  const reference=prompt('Referência do recebimento (opcional):','')||'';
  const obs=prompt('Observações (opcional):','')||'';
  try{await api(`/api/notes/${id}`,{method:'PATCH',body:JSON.stringify({delivered_date:date,delivery_reference:reference,delivery_observations:obs})});await loadNotes();toast('Entrega registrada.')}catch(e){toast(e.message)}
}
async function reopenNote(id){
  if(!confirm('Reabrir este processo?'))return;
  try{await api(`/api/notes/${id}`,{method:'PATCH',body:JSON.stringify({delivered_date:null})});await loadNotes();toast('Processo reaberto.')}catch(e){toast(e.message)}
}
async function setupPush(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window))return toast('Este navegador não oferece push para esta instalação.');
  try{
    const perm=await Notification.requestPermission();if(perm!=='granted')return toast('Permissão de notificações não concedida.');
    const reg=await navigator.serviceWorker.ready;const {key}=await api('/api/push/public-key');
    if(!key)return toast('A TI ainda não configurou as chaves VAPID para push.');
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key)});
    await api('/api/push/subscribe',{method:'POST',body:JSON.stringify(sub)});
    toast('Notificações push ativadas neste aparelho.');
  }catch(e){toast(`Não foi possível ativar push: ${e.message}`)}
}
function urlBase64ToUint8Array(base64String){const padding='='.repeat((4-base64String.length%4)%4);const raw=atob((base64String+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
$('pushBtn').onclick=setupPush;$('logoutBtn').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'})}catch{}currentUser=null;showLogin()};
function showLogin(){$('loginView').classList.remove('hidden');$('appView').classList.add('hidden')}
async function showApp(user){
  currentUser=user;$('loginView').classList.add('hidden');$('appView').classList.remove('hidden');
  $('welcome').textContent=`Olá, ${user.display_name} · Perfil: ${user.role}`;
  try{await loadUsers();await loadNotes()}catch(e){toast(e.message)}
}
$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();$('loginError').classList.add('hidden');
  try{const r=await api('/api/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});$('password').value='';await showApp(r.user)}
  catch(err){$('loginError').textContent=err.message;$('loginError').classList.remove('hidden')}
});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$('installBtn').classList.remove('hidden')});
$('installBtn').onclick=async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$('installBtn').classList.add('hidden')};
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('SW indisponível',e));
(async()=>{try{const r=await api('/api/me');await showApp(r.user)}catch{showLogin()}})();
