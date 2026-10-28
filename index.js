import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PgSession = connectPgSimple(session);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(root, 'private_uploads'));
fs.mkdirSync(uploadDir, { recursive: true });
const maxBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 10)) * 1024 * 1024;

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'preditiva.sid',
  secret: process.env.SESSION_SECRET || 'unsafe-development-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAuthenticated = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Faça login para continuar.' });
const isManager = (req, res, next) => ['ordenador','admin'].includes(req.session?.user?.role) ? next() : res.status(403).json({ error: 'Permissão insuficiente.' });

function audit(actorId, noteId, action, detail = {}) {
  return pool.query(
    'INSERT INTO audit_log(actor_user_id,note_id,action,detail) VALUES($1,$2,$3,$4)',
    [actorId || null, noteId || null, action, JSON.stringify(detail)]
  );
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addCalendarDays(dateString, n) {
  const d = new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
function addBusinessDays(dateString, n) {
  const d = new Date(`${dateString}T12:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) added++;
  }
  return isoDate(d);
}
function dueDates(note) {
  const communicationDue = addBusinessDays(String(note.issued_date).slice(0,10), 3);
  const deliveryDue = note.communication_date
    ? addCalendarDays(String(note.communication_date).slice(0,10), Number(note.delivery_days))
    : null;
  return { communication_due: communicationDue, delivery_due: deliveryDue };
}
function visibleNoteFilter(user, paramOffset = 1) {
  return user.role === 'ordenador' || user.role === 'admin'
    ? { sql: '', params: [] }
    : { sql: ` AND n.owner_user_id = $${paramOffset}`, params: [user.id] };
}
function safeUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name, role: u.role };
}
function validNote(body, manager, currentUserId) {
  const ne_number = String(body.ne_number || '').trim();
  const supplier = String(body.supplier || '').trim();
  const object_description = String(body.object_description || '').trim();
  const issued_date = String(body.issued_date || '');
  const delivery_days = Number(body.delivery_days);
  const owner_user_id = manager ? Number(body.owner_user_id || currentUserId) : currentUserId;
  if (!ne_number || !supplier || !object_description || !/^\d{4}-\d{2}-\d{2}$/.test(issued_date) || ![30,45].includes(delivery_days)) {
    const e = new Error('Preencha NE, fornecedor, objeto, data de emissão e prazo de 30 ou 45 dias.');
    e.status = 400; throw e;
  }
  return {
    ne_number, ug: String(body.ug || '').trim().slice(0,100), supplier, object_description,
    owner_user_id, issued_date,
    communication_date: body.communication_date || null,
    delivery_days,
    communication_reference: String(body.communication_reference || '').trim().slice(0,500),
    notes: String(body.notes || '').trim().slice(0,5000)
  };
}

app.get('/api/health', (_req,res) => res.json({ status: 'ok', app: 'Preditiva & Alertas Antecipados' }));
app.post('/api/login', asyncRoute(async (req,res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await pool.query('SELECT * FROM app_users WHERE lower(email)=lower($1) AND active=true', [email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }
  req.session.user = safeUser(user);
  await audit(user.id, null, 'login', {});
  res.json({ user: req.session.user });
}));
app.post('/api/logout', isAuthenticated, asyncRoute(async (req,res) => {
  await audit(req.session.user.id, null, 'logout', {});
  req.session.destroy(() => res.json({ ok: true }));
}));
app.get('/api/me', (req,res) => req.session?.user ? res.json({ user: req.session.user }) : res.status(401).json({ error: 'Não autenticado.' }));

app.get('/api/users', isAuthenticated, asyncRoute(async (req,res) => {
  const result = await pool.query("SELECT id,email,display_name,role FROM app_users WHERE active=true ORDER BY display_name");
  res.json({ users: result.rows });
}));
app.get('/api/notes', isAuthenticated, asyncRoute(async (req,res) => {
  const f = visibleNoteFilter(req.session.user);
  const result = await pool.query(
    `SELECT n.*, u.display_name AS owner_name, u.email AS owner_email,
      (SELECT count(*) FROM attachments a WHERE a.note_id=n.id) AS attachment_count
     FROM notes n JOIN app_users u ON u.id=n.owner_user_id
     WHERE 1=1 ${f.sql} ORDER BY n.issued_date DESC, n.id DESC`, f.params
  );
  res.json({ notes: result.rows.map(n => ({ ...n, ...dueDates(n) })) });
}));
app.post('/api/notes', isAuthenticated, asyncRoute(async (req,res) => {
  const manager = ['ordenador','admin'].includes(req.session.user.role);
  const n = validNote(req.body, manager, req.session.user.id);
  if (!manager && n.owner_user_id !== req.session.user.id) return res.status(403).json({error:'Não autorizado.'});
  const r = await pool.query(
    `INSERT INTO notes(ne_number,ug,supplier,object_description,owner_user_id,issued_date,communication_date,delivery_days,communication_reference,notes,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [n.ne_number,n.ug,n.supplier,n.object_description,n.owner_user_id,n.issued_date,n.communication_date,n.delivery_days,n.communication_reference,n.notes,req.session.user.id]
  );
  await audit(req.session.user.id, r.rows[0].id, 'note_created', { ne_number:n.ne_number });
  res.status(201).json({ note: { ...r.rows[0], ...dueDates(r.rows[0]) } });
}));
app.patch('/api/notes/:id', isAuthenticated, asyncRoute(async (req,res) => {
  const current = await pool.query('SELECT * FROM notes WHERE id=$1', [req.params.id]);
  if (!current.rowCount) return res.status(404).json({error:'Empenho não encontrado.'});
  const old = current.rows[0], user = req.session.user;
  const manager = ['ordenador','admin'].includes(user.role);
  if (!manager && Number(old.owner_user_id) !== Number(user.id)) return res.status(403).json({error:'Você só pode alterar empenhos atribuídos a você.'});
  const n = validNote({ ...old, ...req.body }, manager, user.id);
  const delivered_date = req.body.delivered_date === undefined ? old.delivered_date : (req.body.delivered_date || null);
  const delivery_reference = req.body.delivery_reference === undefined ? old.delivery_reference : String(req.body.delivery_reference).trim().slice(0,500);
  const delivery_observations = req.body.delivery_observations === undefined ? old.delivery_observations : String(req.body.delivery_observations).trim().slice(0,5000);
  const r = await pool.query(
    `UPDATE notes SET ne_number=$1,ug=$2,supplier=$3,object_description=$4,owner_user_id=$5,issued_date=$6,communication_date=$7,delivery_days=$8,communication_reference=$9,notes=$10,delivered_date=$11,delivery_reference=$12,delivery_observations=$13,archived=($11 IS NOT NULL),updated_at=NOW()
     WHERE id=$14 RETURNING *`,
    [n.ne_number,n.ug,n.supplier,n.object_description,n.owner_user_id,n.issued_date,n.communication_date,n.delivery_days,n.communication_reference,n.notes,delivered_date,delivery_reference,delivery_observations,req.params.id]
  );
  await audit(user.id, r.rows[0].id, 'note_updated', { changed_fields:Object.keys(req.body) });
  res.json({ note: { ...r.rows[0], ...dueDates(r.rows[0]) } });
}));
app.post('/api/notes/:id/occurrences', isAuthenticated, asyncRoute(async (req,res) => {
  const note = await pool.query('SELECT * FROM notes WHERE id=$1', [req.params.id]);
  if (!note.rowCount) return res.status(404).json({error:'Empenho não encontrado.'});
  const user = req.session.user;
  if (!['ordenador','admin'].includes(user.role) && Number(note.rows[0].owner_user_id)!==Number(user.id)) return res.status(403).json({error:'Não autorizado.'});
  const description = String(req.body.description || '').trim();
  const type = String(req.body.type || 'Ocorrência').trim().slice(0,150);
  if (!description) return res.status(400).json({error:'Descreva a ocorrência.'});
  await audit(user.id, note.rows[0].id, 'occurrence', { type, description, date: req.body.date || new Date().toISOString().slice(0,10) });
  res.status(201).json({ok:true});
}));
app.get('/api/notes/:id/history', isAuthenticated, asyncRoute(async (req,res) => {
  const note = await pool.query('SELECT * FROM notes WHERE id=$1', [req.params.id]);
  if (!note.rowCount) return res.status(404).json({error:'Empenho não encontrado.'});
  const user=req.session.user;
  if (!['ordenador','admin'].includes(user.role) && Number(note.rows[0].owner_user_id)!==Number(user.id)) return res.status(403).json({error:'Não autorizado.'});
  const rows = await pool.query('SELECT a.*,u.display_name FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_user_id WHERE a.note_id=$1 ORDER BY a.created_at DESC', [req.params.id]);
  res.json({history:rows.rows});
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req,_file,cb) => cb(null,uploadDir),
    filename: (_req,file,cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0,10)}`)
  }),
  limits: { fileSize: maxBytes, files: 5 },
  fileFilter: (_req,file,cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Formato não permitido. Use PDF, JPG, PNG ou WEBP.'), allowed.includes(file.mimetype));
  }
});
app.post('/api/notes/:id/attachments', isAuthenticated, upload.array('files',5), asyncRoute(async (req,res) => {
  const note=await pool.query('SELECT * FROM notes WHERE id=$1',[req.params.id]);
  if(!note.rowCount){ for(const f of req.files||[])fs.unlinkSync(f.path); return res.status(404).json({error:'Empenho não encontrado.'}); }
  const user=req.session.user;
  if(!['ordenador','admin'].includes(user.role) && Number(note.rows[0].owner_user_id)!==Number(user.id)){ for(const f of req.files||[])fs.unlinkSync(f.path); return res.status(403).json({error:'Não autorizado.'}); }
  const added=[];
  for(const f of req.files||[]){
    const r=await pool.query('INSERT INTO attachments(note_id,original_name,stored_name,mime_type,size_bytes,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,original_name,mime_type,size_bytes,created_at',[req.params.id,f.originalname.slice(0,255),path.basename(f.path),f.mimetype,f.size,user.id]);
    added.push(r.rows[0]);
  }
  await audit(user.id,req.params.id,'attachments_uploaded',{count:added.length});
  res.status(201).json({attachments:added});
}));
app.get('/api/notes/:id/attachments', isAuthenticated, asyncRoute(async (req,res) => {
  const n=await pool.query('SELECT * FROM notes WHERE id=$1',[req.params.id]);
  if(!n.rowCount)return res.status(404).json({error:'Empenho não encontrado.'});
  const u=req.session.user;
  if(!['ordenador','admin'].includes(u.role)&&Number(n.rows[0].owner_user_id)!==Number(u.id))return res.status(403).json({error:'Não autorizado.'});
  const a=await pool.query('SELECT id,original_name,mime_type,size_bytes,created_at FROM attachments WHERE note_id=$1 ORDER BY id DESC',[req.params.id]);
  res.json({attachments:a.rows});
}));
app.get('/api/attachments/:id/download', isAuthenticated, asyncRoute(async (req,res) => {
  const r=await pool.query('SELECT a.*,n.owner_user_id FROM attachments a JOIN notes n ON n.id=a.note_id WHERE a.id=$1',[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Arquivo não encontrado.'});
  const a=r.rows[0],u=req.session.user;
  if(!['ordenador','admin'].includes(u.role)&&Number(a.owner_user_id)!==Number(u.id))return res.status(403).json({error:'Não autorizado.'});
  const file=path.join(uploadDir,path.basename(a.stored_name));
  if(!fs.existsSync(file))return res.status(404).json({error:'Arquivo não está disponível.'});
  await audit(u.id,a.note_id,'attachment_downloaded',{attachment_id:a.id});
  res.download(file,a.original_name);
}));

app.post('/api/push/subscribe', isAuthenticated, asyncRoute(async (req,res) => {
  const sub=req.body;
  if(!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)return res.status(400).json({error:'Assinatura push inválida.'});
  await pool.query(`INSERT INTO push_subscriptions(user_id,endpoint,subscription) VALUES($1,$2,$3)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,subscription=EXCLUDED.subscription`,
    [req.session.user.id,sub.endpoint,JSON.stringify(sub)]);
  res.json({ok:true});
}));
app.get('/api/push/public-key', isAuthenticated, (_req,res)=>res.json({key:process.env.VAPID_PUBLIC_KEY||''}));

async function sendEmail(to, subject, text) {
  if(!process.env.SMTP_HOST || !process.env.SMTP_FROM) return false;
  const transporter=nodemailer.createTransport({
    host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),
    secure:process.env.SMTP_SECURE==='true',
    auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined
  });
  await transporter.sendMail({from:process.env.SMTP_FROM,to,subject,text});
  return true;
}
async function dispatchAlert(note, user, type, message, date) {
  for (const channel of ['email','push']) {
    const seen=await pool.query('SELECT 1 FROM notification_log WHERE note_id=$1 AND user_id=$2 AND alert_type=$3 AND alert_date=$4 AND channel=$5',[note.id,user.id,type,date,channel]);
    if(seen.rowCount)continue;
    try {
      let sent=false;
      if(channel==='email') sent=await sendEmail(user.email,`Preditiva: ${type}`,message);
      else if(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT||`mailto:${user.email}`,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
        const subs=await pool.query('SELECT * FROM push_subscriptions WHERE user_id=$1',[user.id]);
        for(const s of subs.rows) {
          try { await webpush.sendNotification(s.subscription,JSON.stringify({title:`Preditiva: ${type}`,body:message,url:'/'})); sent=true; }
          catch(e){ if(e.statusCode===404||e.statusCode===410) await pool.query('DELETE FROM push_subscriptions WHERE id=$1',[s.id]); }
        }
      }
      if(sent) await pool.query('INSERT INTO notification_log(note_id,user_id,alert_type,alert_date,channel) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[note.id,user.id,type,date,channel]);
    } catch(err) { console.error('Falha ao enviar alerta:',channel,err.message); }
  }
}
async function runAlertJob() {
  const today=isoDate(new Date());
  const result=await pool.query(`SELECT n.*,u.id AS uid,u.email,u.display_name FROM notes n JOIN app_users u ON u.id=n.owner_user_id
    WHERE n.delivered_date IS NULL AND u.active=true`);
  for(const n of result.rows) {
    const communicationDue=addBusinessDays(String(n.issued_date).slice(0,10),3);
    const deliveryDue=n.communication_date?addCalendarDays(String(n.communication_date).slice(0,10),Number(n.delivery_days)):null;
    let type='', message='';
    if(!n.communication_date && today>communicationDue){ type='Comunicação pendente'; message=`NE ${n.ne_number}: registre a comunicação oficial ao fornecedor. Prazo de comunicação: ${communicationDue}.`; }
    else if(deliveryDue) {
      const diff=Math.round((new Date(`${deliveryDue}T12:00:00Z`)-new Date(`${today}T12:00:00Z`))/86400000);
      if(diff<0){type='Entrega atrasada';message=`NE ${n.ne_number}: prazo de entrega vencido em ${deliveryDue}.`;}
      else if(diff<=5){type='Entrega próxima do vencimento';message=`NE ${n.ne_number}: entrega prevista para ${deliveryDue} (faltam ${diff} dia(s)).`;}
    }
    if(type) await dispatchAlert(n,{id:n.uid,email:n.email},type,message,today);
  }
}
cron.schedule('0 8 * * 1-5', () => runAlertJob().catch(e=>console.error('Job de alertas falhou:',e)), { timezone:'America/Sao_Paulo' });

app.use(express.static(path.join(root,'public'), { index:'index.html' }));
app.get('*', (req,res,next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(root,'public','index.html')));
app.use((err,req,res,_next) => {
  console.error(err);
  const status=err.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({error:status===500?'Erro interno. Consulte o registro do servidor.':err.message});
});
const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(`Preditiva ouvindo na porta ${port}`));
