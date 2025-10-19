// Sistema de Alerta de Enchentes
require('dotenv').config();

/* -------------------- Pacotes -------------------- */
const express    = require('express');
const mysql      = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors       = require('cors');
const path       = require('path');
const axios      = require('axios');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');

/* -------------------- App -------------------- */
const app  = express();
const PORT = process.env.PORT || 3000;

/* -------------------- Banco de Dados -------------------- */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME || '',
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONN_LIMIT || '10', 10),
  queueLimit: 0,
  connectTimeout: 10000
});

pool.getConnection()
  .then(c => { console.log('✅ Conectado ao banco de dados com sucesso!'); c.release(); })
  .catch(err => { console.error('❌ Erro ao conectar ao banco:', err.message); process.exit(1); });

/* -------------------- Integrações Externas -------------------- */
// ClickSend
const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3';
const CLICKSEND_AUTH = {
  username: process.env.CLICKSEND_USER,
  password: process.env.CLICKSEND_KEY
};

// E-mail (SMTP)
const mailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: Number(process.env.EMAIL_PORT || 465),
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

async function enviarEmail({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  await mailTransporter.sendMail({
    from,
    to,
    subject,
    text: text || html?.replace(/<[^>]+>/g, ' '),
    html
  });
}

/* -------------------- Middlewares -------------------- */
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Atrás de proxy (Railway/Render/etc.)
app.set('trust proxy', 1);

// Sessões
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-bem-grande-aqui',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true, 
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // cookie seguro em produção
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dias
  }
}));

/* -------------------- Assets estáticos (somente arquivos, não HTML) -------------------- */
// NÃO usar app.use(express.static('public')) para não expor index.html
app.use('/img',        express.static(path.join(__dirname, 'public', 'img')));
app.use('/style.css',  express.static(path.join(__dirname, 'public', 'style.css')));
app.use('/inform.css', express.static(path.join(__dirname, 'public', 'inform.css')));
app.use('/relatos.css',express.static(path.join(__dirname, 'public', 'relatos.css')));
app.use('/sobre.css',  express.static(path.join(__dirname, 'public', 'sobre.css')));
app.use('/script.js',  express.static(path.join(__dirname, 'public', 'script.js')));
app.use('/relatos.js', express.static(path.join(__dirname, 'public', 'relatos.js')));
app.use('/reader.js',  express.static(path.join(__dirname, 'public', 'reader.js')));

/* -------------------- Proteção -------------------- */
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect('/login.html');
}

/* -------------------- Helpers -------------------- */
const cacheEnvioAlerta   = new Map();
const cacheEnvioCadastro = new Map();

function podeEnviar(celular, tipo){
  const agora  = Date.now();
  const cache  = tipo === 'alerta' ? cacheEnvioAlerta : cacheEnvioCadastro;
  const limite = tipo === 'alerta' ? 5*3600000 : 1*3600000; // 5h / 1h
  const ultima = cache.get(celular);
  if (!ultima || agora - ultima >= limite){ cache.set(celular,agora); return true; }
  return false;
}

async function enviarSms(destinatario, mensagem){
  try{
    const {data} = await axios.post(
      `${CLICKSEND_API_URL}/sms/send`,
      { messages: [{ source:'nodejs', body:mensagem, to:destinatario, from:'Alertas' }] },
      { auth: CLICKSEND_AUTH, headers:{'Content-Type':'application/json'} }
    );
    console.log('✅ SMS enviado:', data.data?.messages?.[0]?.status);
    return true;
  }catch(err){
    console.error('❌ Erro ao enviar SMS:', err.response?.data || err.message);
    return false;
  }
}

function normEmail(e){ return String(e || '').trim().toLowerCase(); }
function normCel(c){ return String(c || '').replace(/\D/g, '').slice(-11); }

function validarDadosCadastro({nome,celular,email,senha}){
  if (!nome || nome.trim().length<3) return {valido:false, mensagem:'Nome deve ter pelo menos 3 caracteres'};
  if (!/^\d{11}$/.test((celular||'').trim())) return {valido:false, mensagem:'Celular deve ter 11 dígitos (ex: 11999999999)'};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email||'').trim())) return {valido:false, mensagem:'E-mail inválido'};
  if (senha !== undefined && String(senha).length < 6) return {valido:false, mensagem:'Senha deve ter pelo menos 6 caracteres'};
  return {valido:true};
}

function validarConteudoRelato(texto=''){
  const proibidas=['porra','caralho','vai se fuder','vai tomar no cu','merda','fudida'];
  const t=texto.toLowerCase();
  for(const p of proibidas){ if(t.includes(p)) return {valido:false,palavra:p}; }
  return {valido:true};
}

/* -------------------- Tarefas automáticas -------------------- */
async function verificarAlertasOficiais(){
  try{
    if (!process.env.WEATHER_API_KEY) {
      console.warn('⚠️ WEATHER_API_KEY ausente; pulando verificação de alertas.');
      return;
    }

    const {data} = await axios.get('http://api.weatherapi.com/v1/forecast.json', {
      params:{ key:process.env.WEATHER_API_KEY, q:'Santa Isabel,Sao Paulo,Brazil', days:1, alerts:'yes', aqi:'no' }
    });

    const alertas = data.alerts?.alert || [];
    if (alertas.length === 0) return;

    const [usuarios] = await pool.query('SELECT nome, celular, email FROM usuarios');

    for (const u of usuarios){
      // SMS
      if (/^\d{11}$/.test(String(u.celular||'')) && podeEnviar(u.celular,'alerta')){
        for (const a of alertas){
          const msg =
`⚠️ ALERTA OFICIAL
${a.headline}

${a.desc}

— Alerta de Enchentes (Projeto).
Para cancelar SMS, responda STOP.`;
          try {
            await enviarSms('+55'+String(u.celular).trim(), msg);
          } catch(e) {
            console.error('❌ Falha SMS p/ ', u.celular, e.message);
          }
        }
      }

      // E-mail
      if (u.email){
        for (const a of alertas){
          const subject = '⚠️ Alerta de Enchentes — Santa Isabel';
          const html = `
            <div style="font-family:Arial,sans-serif">
              <h2>⚠️ ALERTA OFICIAL</h2>
              <p><strong>${a.headline}</strong></p>
              <p>${a.desc}</p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
              <p style="color:#666">— Sistema Alerta de Enchentes</p>
            </div>
          `;
          try {
            await enviarEmail({ to: u.email, subject, html });
            console.log('📧 E-mail enviado para', u.email);
          } catch(e) {
            console.error('❌ Falha e-mail p/ ', u.email, e.message);
          }
        }
      }
    }
  }catch(err){
    console.error('❌ Erro na verificação do clima:', err.message);
  }
}

// Agendadores
setInterval(verificarAlertasOficiais, 60*60*1000); // 1h
setInterval(() => {
  if (!process.env.WEATHER_API_KEY) return;
  axios.get('http://api.weatherapi.com/v1/current.json', {
    params:{ key:process.env.WEATHER_API_KEY, q:'Santa Isabel,Sao Paulo,Brazil', aqi:'no' }
  })
  .then(r=>console.log('🌤️ Clima atual:', r.data.current?.condition?.text))
  .catch(e=>console.error('Erro ao buscar clima atual:', e.message));
}, 15*60*1000);

/* -------------------- Rotas de Autenticação -------------------- */

// Solicitar código (esqueci minha senha)
app.post('/auth/forgot', async (req, res) => {
  try {
    let email = normEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ sucesso:false, mensagem:'Informe seu e-mail.' });
    }

    const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE email = ?', [email]);

    // Resposta idempotente
    if (!rows.length) {
      return res.json({
        sucesso: true,
        mensagem: 'Se o e-mail existir em nossa base, você receberá um código em até 15 minutos. Verifique também a caixa de spam.'
      });
    }
    const user = rows[0];

    const code = String(Math.floor(100000 + Math.random()*900000));
    const expires = new Date(Date.now() + 15*60*1000);

    await pool.query(
      'UPDATE usuarios SET reset_code = ?, reset_expires = ? WHERE id = ?',
      [code, expires, user.id]
    );
   
    // E-mail com código
    const subject = 'Código para redefinição de senha — Alerta de Enchentes';
    const html = `
      <div style="font-family:Arial,sans-serif">
        <p>Olá, ${user.nome}!</p>
        <p>Você solicitou redefinição de senha. Use o código abaixo (válido por 15 minutos):</p>
        <p style="font-size:20px;font-weight:bold;letter-spacing:2px">${code}</p>
        <p>Se não foi você, ignore este e-mail.</p>
        <p style="color:#666">— Alerta de Enchentes (Projeto)</p>
      </div>
    `;
    await enviarEmail({ to: user.email, subject, html });

    return res.json({ sucesso:true, mensagem:'Código enviado por e-mail (válido por 15 min).' });
  } catch (err) {
    console.error('❌ /auth/forgot:', err);
    res.status(500).json({ sucesso:false, mensagem:'Erro ao gerar código.' });
  }
});

// Redefinir senha
app.post('/auth/reset', async (req, res) => {
  try {
    let email     = normEmail(req.body.email);
    let code      = String(req.body.code || '').trim();
    let novaSenha = String(req.body.novaSenha || '');

    if (!email || !code || novaSenha.length < 6) {
      return res.status(400).json({ sucesso:false, mensagem:'E-mail, código e nova senha (mín. 6) são obrigatórios.' });
    }

    const [rows] = await pool.query(
      'SELECT id, nome FROM usuarios WHERE email = ? AND reset_code = ? AND reset_expires > NOW()',
      [email, code]
    );

    if (!rows.length) {
      return res.status(400).json({ sucesso:false, mensagem:'Código inválido ou expirado.' });
    }

    const user = rows[0];
    const hash = await bcrypt.hash(novaSenha, 10);

    await pool.query(
      'UPDATE usuarios SET senha_hash = ?, reset_code = NULL, reset_expires = NULL WHERE id = ?',
      [hash, user.id]
    );

    // E-mail de confirmação
    try {
      await enviarEmail({
        to: email,
        subject: 'Senha redefinida com sucesso — Alerta de Enchentes',
        html: `
          <div style="font-family:Arial,sans-serif">
            <p>Olá, ${user.nome}!</p>
            <p>Sua senha foi atualizada com sucesso.</p>
            <p style="color:#666">— Alerta de Enchentes (Projeto)</p>
          </div>
        `
      });
    } catch (e) {
      console.warn('Aviso: falha ao enviar e-mail de confirmação de reset:', e.message);
    }

    return res.json({ sucesso:true, mensagem:'Senha atualizada com sucesso. Faça login.' });
  } catch (err) {
    console.error('❌ /auth/reset:', err);
    res.status(500).json({ sucesso:false, mensagem:'Erro ao redefinir senha.' });
  }
});

// Registro
app.post('/auth/register', async (req, res) => {
  try {
    let { nome, celular, email, senha, termos_aceitos } = req.body;

    if (!termos_aceitos) {
      return res.status(400).json({ sucesso: false, mensagem: 'Você precisa aceitar os Termos de Privacidade.' });
    }

    const emailNorm   = normEmail(email);
    const celularNorm = normCel(celular);

    const v = validarDadosCadastro({ nome, celular: celularNorm, email: emailNorm, senha });
    if (!v.valido) return res.status(400).json({ sucesso: false, mensagem: v.mensagem });

    const [existeEmail] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailNorm]);
    if (existeEmail.length) return res.status(409).json({ sucesso: false, mensagem: 'E-mail já cadastrado' });

    const [existeCel] = await pool.query('SELECT id FROM usuarios WHERE celular = ?', [celularNorm]);
    if (existeCel.length) return res.status(409).json({ sucesso: false, mensagem: 'Celular já cadastrado' });

    const hash = await bcrypt.hash(String(senha || ''), 10);

    await pool.query(
      'INSERT INTO usuarios (nome, celular, email, senha_hash, termos_aceitos) VALUES (?,?,?,?,?)',
      [String(nome || '').trim(), celularNorm, emailNorm, hash, 1]
    );

    // E-mail de boas-vindas
    try {
      await enviarEmail({
        to: emailNorm,
        subject: 'Cadastro confirmado — Alerta de Enchentes',
        html: `
          <div style="font-family:Arial,sans-serif">
            <p>Olá, ${String(nome || '').trim()}!</p>
            <p>Seu cadastro no <strong>Alerta de Enchentes</strong> foi confirmado com sucesso.</p>
            <p>Agora você já pode acessar o sistema com seu e-mail e senha.</p>
            <p style="color:#666">— Alerta de Enchentes (Projeto)</p>
          </div>
        `
      });
    } catch (e) {
      console.warn('Aviso: falha ao enviar e-mail de confirmação de cadastro:', e.message);
    }

    return res.status(201).json({ sucesso: true, mensagem: 'Usuário cadastrado! Faça login.' });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ sucesso:false, mensagem: 'E-mail ou celular já cadastrado.' });
    }
    console.error('❌ /auth/register:', err);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário' });
  }
});

// Login
app.post('/auth/login', async (req,res)=>{
  try{
    const emailNorm = normEmail(req.body.email);
    const senha     = String(req.body.senha || '');
    if (!emailNorm || !senha) return res.status(400).json({sucesso:false, mensagem:'Informe e-mail e senha'});

    const [rows] = await pool.query('SELECT id, nome, email, senha_hash FROM usuarios WHERE email = ?', [emailNorm]);
    if (!rows.length || !rows[0].senha_hash) return res.status(401).json({sucesso:false, mensagem:'Credenciais inválidas'});

    const ok = await bcrypt.compare(senha, rows[0].senha_hash);
    if (!ok) return res.status(401).json({sucesso:false, mensagem:'Credenciais inválidas'});

    req.session.user = { id: rows[0].id, nome: rows[0].nome, email: rows[0].email };
    res.json({sucesso:true, user:req.session.user});
  }catch(err){
    console.error('❌ /auth/login:', err);
    res.status(500).json({sucesso:false, mensagem:'Erro no login'});
  }
});

// Quem sou
app.get('/auth/me', (req,res)=> res.json({authenticated: !!req.session?.user, user: req.session?.user || null}));

// Logout
app.post('/auth/logout', (req,res)=>{
  req.session.destroy(()=> res.json({sucesso:true}));
});

/* -------------------- Páginas (HTML) -------------------- */
// Públicas
app.get('/login.html',    (_req,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/cadastro.html', (_req,res)=>res.sendFile(path.join(__dirname,'public','cadastro.html')));
app.get('/termos.html',   (_req,res)=>res.sendFile(path.join(__dirname,'public','termos.html')));
app.get('/esqueci.html',  (_req,res)=>res.sendFile(path.join(__dirname,'public','esqueci.html')));

// Protegidas
app.get('/',                        requireAuth, (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get(['/index','/index.html'],   requireAuth, (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get(['/relatos','/relatos.html'], requireAuth, (_req,res)=>res.sendFile(path.join(__dirname,'public','relatos.html')));
app.get('/inform.html',             requireAuth, (_req,res)=>res.sendFile(path.join(__dirname,'public','inform.html')));
app.get('/sobre.html',              requireAuth, (_req,res)=>res.sendFile(path.join(__dirname,'public','sobre.html')));

/* -------------------- APIs (protegidas) -------------------- */
app.get('/api/clima', requireAuth, async (_req,res)=>{
  try{
    if (!process.env.WEATHER_API_KEY) {
      return res.status(500).json({ sucesso:false, mensagem:'WEATHER_API_KEY não configurada' });
    }

    const {data} = await axios.get('http://api.weatherapi.com/v1/current.json', {
      params:{ key:process.env.WEATHER_API_KEY, q:'Santa Isabel,Sao Paulo,Brazil', aqi:'no' }
    });

    if (!data?.current) {
      console.error('WeatherAPI: resposta inesperada:', data);
      return res.status(502).json({ sucesso:false, mensagem:'Falha ao obter dados de clima' });
    }

    const c = data.current;
    res.json({
      temperatura: c.temp_c,
      descricao:   c.condition?.text || '',
      umidade:     c.humidity,
      vento_kph:   c.wind_kph,
      sensacao:    c.feelslike_c,
      icone:       c.condition?.icon ? `https:${c.condition.icon}` : null
    });
  }catch(e){
    console.error('❌ /api/clima erro:', e.response?.data || e.message);
    res.status(500).json({sucesso:false, mensagem:'Erro ao buscar dados climáticos'});
  }
});

// Descadastro
app.post('/descadastrar', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.query('SELECT id FROM usuarios WHERE id = ?', [userId]);
    if (!rows.length) {
      return res.status(404).json({ sucesso:false, mensagem:'Usuário não encontrado.' });
    }

    await pool.query('DELETE FROM usuarios WHERE id = ?', [userId]);
    req.session.destroy(() => {});
    res.json({ sucesso:true, mensagem:'Conta excluída com sucesso.' });
  } catch (err) {
    console.error('❌ Erro no descadastro:', err);
    res.status(500).json({ sucesso:false, mensagem:'Erro interno ao processar descadastro' });
  }
});

// Relatos (criar)
app.post('/api/relatos', requireAuth, async (req,res)=>{
  const { bairro, texto, data } = req.body;
  if (!bairro?.trim() || !texto?.trim() || !data) {
    return res.status(400).json({ success:false, message:'Bairro, texto e data são obrigatórios!' });
  }

  // Bloquear datas futuras
  const hoje = new Date();
  const dataRelato = new Date(data);
  if (dataRelato > hoje) {
    return res.status(400).json({ success:false, message:'Não é permitido registrar relatos com data futura.' });
  }

  const censura = validarConteudoRelato(texto);
  if (!censura.valido) {
    return res.status(400).json({ success:false, message:`Relato contém linguagem inadequada: "${censura.palavra}"` });
  }

  try{
    const [bairros] = await pool.query('SELECT latitude, longitude FROM bairros WHERE nome = ?', [bairro.trim()]);
    if (!bairros.length) {
      return res.status(404).json({ success:false, message:'Bairro não encontrado na base de coordenadas' });
    }

    const { latitude, longitude } = bairros[0];
    const [result] = await pool.execute(
      'INSERT INTO relatos (bairro, texto, data, latitude, longitude) VALUES (?, ?, ?, ?, ?)',
      [bairro.trim(), texto.trim(), data, latitude, longitude]
    );
    res.status(201).json({ success:true, insertedId: result.insertId });
  }catch(err){
    console.error('Erro ao salvar relato:', err);
    res.status(500).json({ success:false, message:'Erro ao salvar o relato: '+err.message });
  }
});

// Relatos (listar)
app.get('/api/relatos', requireAuth, async (_req,res)=>{
  try{
    const [rows] = await pool.query(`
      SELECT id, bairro, texto,
             DATE_FORMAT(data,'%d/%m/%Y') AS data_formatada,
             data AS data_original,
             latitude, longitude
      FROM relatos
      ORDER BY data DESC
      LIMIT 100
    `);
    res.json(rows);
  }catch(err){
    console.error('Erro ao buscar relatos:', err);
    res.status(500).json({ success:false, message:'Erro ao carregar relatos: '+err.message });
  }
});

// Bairros (listar distintos dos relatos)
app.get('/api/bairros', requireAuth, async (_req,res)=>{
  try{
    const [rows] = await pool.query('SELECT DISTINCT bairro FROM relatos ORDER BY bairro');
    res.json(rows.map(r=>r.bairro));
  }catch(err){
    console.error('Erro ao buscar bairros:', err);
    res.status(500).json({ success:false, message:'Erro ao carregar bairros: '+err.message });
  }
});

/* -------------------- Health Check -------------------- */
app.get('/api/health', async (_req,res)=>{
  try{
    await pool.query('SELECT 1');
    res.json({ status:'online', db_connection:'healthy', timestamp:new Date().toISOString() });
  }catch(err){
    res.status(500).json({ status:'online', db_connection:'unhealthy', error:err.message });
  }
});

/* -------------------- Erros -------------------- */
app.use((err,_req,res,_next)=>{
  console.error('Erro não tratado:', err);
  res.status(500).json({ success:false, message:'Erro interno no servidor' });
});

/* -------------------- Inicialização -------------------- */
app.listen(PORT, ()=>{
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  verificarAlertasOficiais();
});
