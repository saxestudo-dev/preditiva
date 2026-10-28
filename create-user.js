import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
const { Pool } = pg;
const [emailArg, nameArg, roleArg='requisitante'] = process.argv.slice(2);
const email=(emailArg||'').trim().toLowerCase();
const name=(nameArg||'').trim();
const role=roleArg;
const password=process.env.NEW_USER_PASSWORD;
if(!email || !name || !['requisitante','ordenador','admin'].includes(role) || !password || password.length<14) {
  console.error('Uso: NEW_USER_PASSWORD="senha-longa" npm run create-user -- usuario@instituicao.gov.br "Nome" requisitante|ordenador|admin');
  console.error('A senha deve ter pelo menos 14 caracteres. Execute em ambiente seguro; não compartilhe a senha no chat.');
  process.exit(1);
}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
  const hash=await bcrypt.hash(password,12);
  await pool.query('INSERT INTO app_users(email,display_name,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,active=true',[email,name,hash,role]);
  console.log(`Usuário criado/atualizado: ${email} (${role}).`);
} finally { await pool.end(); }
