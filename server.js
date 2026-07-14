const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function readJSON(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      const def = { adminPassword: 'admin123' };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(def));
      return def;
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return { adminPassword: 'admin123' }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function requireAdmin(req, res, next) {
  const cfg = readConfig();
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${cfg.adminPassword}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const rooms = new Map();
const roomCodes = new Set();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 9; i++) code += Math.floor(Math.random() * 10).toString();
  } while (roomCodes.has(code));
  roomCodes.add(code);
  return code;
}

const pendingMessages = new Map();

function getPending(role, code) {
  const key = `${role}:${code}`;
  if (!pendingMessages.has(key)) pendingMessages.set(key, []);
  return pendingMessages.get(key);
}

function addMessage(role, code, msg) {
  const arr = getPending(role, code);
  arr.push(msg);
}

app.post('/register', (req, res) => {
  const code = generateCode();
  rooms.set(code, { host: null, viewers: [] });
  const sessions = readJSON('sessions.json');
  sessions.push({ id: crypto.randomUUID(), code, employee: null, employeeName: null, startTime: new Date().toISOString(), endTime: null, duration: null, durationSeconds: null });
  writeJSON('sessions.json', sessions);
  addMessage('host', code, { type: 'code', code });
  res.json({ type: 'code', code });
});

app.post('/join', (req, res) => {
  const { code } = req.body;
  if (!code || !rooms.has(code)) return res.json({ type: 'error', msg: 'Неверный код' });
  addMessage('host', code, { type: 'viewer-joined' });
  res.json({ type: 'ok' });
});

app.post('/signal', (req, res) => {
  const { code, type, sdp, candidate, role } = req.body;
  if (!code || !rooms.has(code)) return res.json({ type: 'error', msg: 'Invalid room' });
  addMessage(role === 'host' ? 'viewer' : 'host', code, { type, sdp, candidate, role });
  res.json({ type: 'ok' });
});

app.get('/poll/:role/:code', (req, res) => {
  const { role, code } = req.params;
  const msgs = getPending(role, code);
  if (msgs.length > 0) return res.json(msgs.shift());
  const key = `${role}:${code}`;
  let waited = 0;
  const interval = setInterval(() => {
    waited += 1000;
    if (pendingMessages.has(key) && pendingMessages.get(key).length > 0) {
      clearInterval(interval);
      res.json(pendingMessages.get(key).shift());
    } else if (waited >= 25000) {
      clearInterval(interval);
      res.json({ type: 'timeout' });
    }
  }, 1000);
  req.on('close', () => clearInterval(interval));
});

app.post('/disconnect', (req, res) => {
  const { code } = req.body;
  if (code && rooms.has(code)) {
    addMessage('viewer', code, { type: 'host-disconnected' });
    addMessage('host', code, { type: 'host-disconnected' });
    rooms.delete(code);
    roomCodes.delete(code);
    const sessions = readJSON('sessions.json');
    const session = sessions.find(s => s.code === code && !s.endTime);
    if (session) {
      session.endTime = new Date().toISOString();
      const diffMs = new Date(session.endTime).getTime() - new Date(session.startTime).getTime();
      session.durationSeconds = Math.round(diffMs / 1000);
      session.duration = Math.round(diffMs / 60000);
      writeJSON('sessions.json', sessions);
    }
  }
  res.json({ type: 'ok' });
});

app.post('/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.json({ type: 'error', msg: 'Введите логин и пароль' });
  const employees = readJSON('employees.json');
  const emp = employees.find(e => e.login === login && e.password === password && e.active !== false);
  if (!emp) return res.json({ type: 'error', msg: 'Неверный логин или пароль' });
  res.json({ type: 'ok', employee: { login: emp.login, name: emp.name } });
});

// Admin API
app.post('/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = readConfig();
  if (currentPassword !== cfg.adminPassword) return res.json({ type: 'error', msg: 'Текущий пароль неверен' });
  if (!newPassword || newPassword.length < 4) return res.json({ type: 'error', msg: 'Новый пароль должен быть минимум 4 символа' });
  cfg.adminPassword = newPassword;
  writeConfig(cfg);
  res.json({ type: 'ok', msg: 'Пароль изменён' });
});

app.get('/admin/employees', requireAdmin, (req, res) => {
  res.json(readJSON('employees.json'));
});

app.post('/admin/employees', requireAdmin, (req, res) => {
  const { login, password, name } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const employees = readJSON('employees.json');
  if (employees.find(e => e.login === login)) return res.status(400).json({ error: 'Login already exists' });
  employees.push({ login, password, name: name || login, active: true, createdAt: new Date().toISOString() });
  writeJSON('employees.json', employees);
  res.json({ type: 'ok' });
});

app.delete('/admin/employees/:login', requireAdmin, (req, res) => {
  let employees = readJSON('employees.json');
  employees = employees.filter(e => e.login !== req.params.login);
  writeJSON('employees.json', employees);
  res.json({ type: 'ok' });
});

app.get('/admin/sessions', requireAdmin, (req, res) => {
  let sessions = readJSON('sessions.json');
  const { employee } = req.query;
  if (employee) sessions = sessions.filter(s => s.employeeName === employee || s.employee === employee);
  res.json(sessions);
});

app.get('/admin/sessions/:id/screenshots', requireAdmin, (req, res) => {
  const sessionId = req.params.id;
  const dir = path.join(SCREENSHOTS_DIR, sessionId);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
  res.json(files.map(f => ({ filename: f, url: `/screenshots/${sessionId}/${f}`, time: f.replace('.jpg', '') })));
});

app.use('/screenshots', express.static(SCREENSHOTS_DIR));

app.post('/screenshot', (req, res) => {
  const { sessionId, image, timestamp } = req.body;
  if (!sessionId || !image) return res.json({ type: 'error' });
  const dir = path.join(SCREENSHOTS_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${timestamp || Date.now()}.jpg`), image.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  res.json({ type: 'ok' });
});

// Admin web page
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RemoteDeskPBX Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; padding: 20px; background: #f0f2f5; }
    h1 { color: #1a73e8; margin-bottom: 20px; font-size: 24px; }
    h2 { color: #333; font-size: 18px; margin-bottom: 15px; }
    .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #1a73e8; color: white; }
    .btn-danger { background: #ea4335; color: white; }
    .btn-success { background: #34a853; color: white; }
    .btn-warning { background: #fbbc04; color: #333; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    input { padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 14px; outline: none; }
    input:focus { border-color: #1a73e8; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover td { background: #f5f8ff; }
    .login-form { max-width: 320px; margin: 120px auto; }
    .login-form h2 { text-align: center; margin-bottom: 25px; }
    .login-form input { width: 100%; margin-bottom: 12px; }
    .login-form .btn { width: 100%; padding: 12px; font-size: 16px; }
    .error { color: #ea4335; background: #fce8e6; padding: 10px 14px; border-radius: 6px; margin-bottom: 15px; font-size: 13px; }
    .success { color: #34a853; background: #e6f4ea; padding: 10px 14px; border-radius: 6px; margin-bottom: 15px; font-size: 13px; }
    .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid #e0e0e0; }
    .tab { padding: 12px 24px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; font-weight: 500; color: #666; }
    .tab.active { color: #1a73e8; border-bottom-color: #1a73e8; }
    .inline-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 15px; }
    .inline-form input { flex: 1; min-width: 120px; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 1000; justify-content: center; align-items: center; cursor: zoom-out; }
    .modal-overlay.active { display: flex; }
    .modal-overlay img { max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; cursor: zoom-out; }
    .modal-overlay .nav-btn { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); color: white; border: none; border-radius: 50%; width: 50px; height: 50px; font-size: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .modal-overlay .nav-btn:hover { background: rgba(255,255,255,0.3); }
    .modal-overlay .nav-prev { left: 20px; }
    .modal-overlay .nav-next { right: 20px; }
    .modal-overlay .close-btn { position: absolute; top: 15px; right: 25px; font-size: 40px; color: white; cursor: pointer; font-weight: bold; opacity: 0.7; }
    .modal-overlay .close-btn:hover { opacity: 1; }
    .gallery { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .gallery-item { width: 150px; height: 100px; overflow: hidden; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
    .gallery-item:hover { border-color: #1a73e8; }
    .gallery-item img { width: 100%; height: 100%; object-fit: cover; }
    .gallery-item-wrap { position: relative; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-active { background: #e6f4ea; color: #34a853; }
    .badge-inactive { background: #fce8e6; color: #ea4335; }
    .duration-format { font-family: monospace; font-size: 12px; color: #555; }
    .employee-link { color: #1a73e8; cursor: pointer; text-decoration: none; }
    .employee-link:hover { text-decoration: underline; }
    .empty-state { text-align: center; padding: 40px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="modal" class="modal-overlay">
    <span class="close-btn" onclick="closeModal()">&times;</span>
    <button class="nav-btn nav-prev" onclick="navModal(-1)">&#8249;</button>
    <img id="modal-img" src="" onclick="closeModal()" alt="screenshot">
    <button class="nav-btn nav-next" onclick="navModal(1)">&#8250;</button>
  </div>
  <script>
    let token = '', employees = [], sessions = [], screenshots = [], currentScreenshotIndex = 0, currentTab = 'employees', filterEmployee = '';

    function fmt(s) { if (!s && s!==0) return '...'; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), s2=s%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s2).padStart(2,'0'); }
    function dt(iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : '-'; }

    function showPage() { document.getElementById('app').innerHTML = '<div class="login-form card"><h2>🔐 RemoteDeskPBX Админ-панель</h2><div id="login-error" class="error" style="display:none"></div><input type="password" id="admin-pass" placeholder="Пароль администратора" onkeydown="if(event.key===\\'Enter\\') login()"><button class="btn btn-primary" onclick="login()">Войти</button></div>'; }

    async function login() {
      const pass = document.getElementById('admin-pass').value;
      if (!pass) { document.getElementById('login-error').innerHTML='Введите пароль'; document.getElementById('login-error').style.display='block'; return; }
      token = 'Bearer ' + pass;
      try {
        const empRes = await fetch('/admin/employees', { headers: { Authorization: token } });
        if (empRes.status === 401) { document.getElementById('login-error').textContent='Неверный пароль'; document.getElementById('login-error').style.display='block'; return; }
        employees = await empRes.json();
        sessions = await (await fetch('/admin/sessions', { headers: { Authorization: token } })).json();
        showDashboard();
      } catch(e) { document.getElementById('login-error').innerHTML='Ошибка: '+e.message; document.getElementById('login-error').style.display='block'; }
    }

    function showDashboard() {
      document.getElementById('app').innerHTML = '<h1>🛠️ RemoteDeskPBX Админ-панель</h1><div class="tabs"><div class="tab '+(currentTab==='employees'?'active':'')+'" onclick="switchTab(\\'employees\\')">👥 Сотрудники</div><div class="tab '+(currentTab==='sessions'?'active':'')+'" onclick="switchTab(\\'sessions\\')">📊 Сессии</div><div class="tab '+(currentTab==='settings'?'active':'')+'" onclick="switchTab(\\'settings\\')">⚙️ Настройки</div></div><div id="tab-content"></div>';
      renderTab();
    }

    function switchTab(t) { currentTab=t; showDashboard(); }

    function renderTab() {
      const c = document.getElementById('tab-content');
      if (currentTab==='employees') renderEmployees(c);
      else if (currentTab==='sessions') renderSessions(c);
      else renderSettings(c);
    }

    function renderEmployees(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>👥 Сотрудники ('+employees.length+')</h2></div><div class="inline-form"><input id="new-login" placeholder="Логин"><input id="new-pass" type="password" placeholder="Пароль"><input id="new-name" placeholder="Имя"><button class="btn btn-success" onclick="addEmployee()">➕ Добавить</button></div><table><thead><tr><th>Логин</th><th>Имя</th><th>Статус</th><th>Создан</th><th>Сессии</th><th></th></tr></thead><tbody>'+employees.map(e=>{const es=sessions.filter(s=>s.employeeName===e.login); return '<tr><td>'+e.login+'</td><td>'+(e.name||e.login)+'</td><td><span class="badge '+(e.active!==false?'badge-active':'badge-inactive')+'">'+(e.active!==false?'Активен':'Неактивен')+'</span></td><td>'+(e.createdAt?dt(e.createdAt):'-')+'</td><td><a class="employee-link" onclick="filterByEmployee(\\''+(e.name||e.login)+'\\')">'+es.length+' сессий &rarr;</a></td><td><button class="btn btn-danger btn-sm" onclick="deleteEmployee(\\''+e.login+'\\')">Удалить</button></td></tr>';}).join('')+(employees.length===0?'<tr><td colspan="6" class="empty-state">Нет сотрудников</td></tr>':'')+'</tbody></table></div>';
    }

    function renderSessions(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>📊 Сессии'+(filterEmployee?' сотрудника "'+filterEmployee+'"':'')+' ('+sessions.length+')</h2><div>'+(filterEmployee?'<button class="btn btn-warning btn-sm" onclick="clearFilter()">✕ Сбросить</button>':'')+'</div></div><table><thead><tr><th>Код</th><th>Сотрудник</th><th>Начало</th><th>Конец</th><th>Длительность</th><th>Скриншоты</th></tr></thead><tbody>'+sessions.slice().reverse().map(s=>{const d=s.durationSeconds!==null?fmt(s.durationSeconds):(s.endTime?'-':'🟢 Активна'); return '<tr><td style="font-family:monospace">'+(s.code||'-')+'</td><td>'+(s.employeeName||s.employee||'-')+'</td><td>'+dt(s.startTime)+'</td><td>'+dt(s.endTime)+'</td><td><span class="duration-format">'+d+'</span></td><td><button class="btn btn-primary btn-sm" onclick="loadScreenshots(\\''+s.id+'\\')">📸 Смотреть</button></td></tr>';}).join('')+(sessions.length===0?'<tr><td colspan="6" class="empty-state">Нет сессий</td></tr>':'')+'</tbody></table></div><div id="screenshots-section"></div>';
    }

    function renderSettings(c) {
      c.innerHTML = '<div class="card"><div class="card-header"><h2>⚙️ Настройки</h2></div><div id="settings-msg"></div><div style="max-width:400px"><label style="font-weight:500;display:block;margin-bottom:8px;color:#555">Смена пароля администратора</label><div style="display:flex;flex-direction:column;gap:10px"><input id="cur-pass" type="password" placeholder="Текущий пароль"><input id="new-pass-admin" type="password" placeholder="Новый пароль (мин. 4 символа)"><button class="btn btn-primary" onclick="changePassword()">Сменить пароль</button></div></div></div>';
    }

    function filterByEmployee(n) { filterEmployee=n; currentTab='sessions'; loadData(); }
    function clearFilter() { filterEmployee=''; loadData(); }

    async function loadData() {
      const r = await fetch('/admin/sessions'+(filterEmployee?'?employee='+encodeURIComponent(filterEmployee):''), { headers: { Authorization: token } });
      sessions = await r.json();
      showDashboard();
    }

    async function addEmployee() {
      const login = document.getElementById('new-login').value.trim(), password = document.getElementById('new-pass').value.trim(), name = document.getElementById('new-name').value.trim()||login;
      if (!login||!password) { alert('Заполните логин и пароль'); return; }
      const r = await fetch('/admin/employees', { method:'POST', headers: { 'Content-Type':'application/json', Authorization: token }, body: JSON.stringify({login,password,name}) });
      if (!r.ok) { const d=await r.json(); alert(d.error||'Ошибка'); return; }
      document.getElementById('new-login').value=''; document.getElementById('new-pass').value=''; document.getElementById('new-name').value='';
      employees = await (await fetch('/admin/employees', {headers:{Authorization:token}})).json();
      renderTab();
    }

    async function deleteEmployee(login) {
      if (!confirm('Удалить сотрудника '+login+'?')) return;
      await fetch('/admin/employees/'+login, { method:'DELETE', headers:{Authorization:token} });
      employees = await (await fetch('/admin/employees', {headers:{Authorization:token}})).json();
      renderTab();
    }

    async function changePassword() {
      const a=document.getElementById('cur-pass').value, b=document.getElementById('new-pass-admin').value;
      if (!a||!b) { alert('Заполните оба поля'); return; }
      const r=await (await fetch('/admin/change-password', { method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body:JSON.stringify({currentPassword:a,newPassword:b}) })).json();
      document.getElementById('settings-msg').innerHTML=r.type==='ok'?'<div class="success">✅ Пароль изменён</div>':'<div class="error">❌ '+(r.msg||'Ошибка')+'</div>';
      if (r.type==='ok') { token='Bearer '+b; document.getElementById('cur-pass').value=''; document.getElementById('new-pass-admin').value=''; }
    }

    async function loadScreenshots(id) {
      if (!id) return;
      screenshots = await (await fetch('/admin/sessions/'+id+'/screenshots', {headers:{Authorization:token}})).json();
      const sec = document.getElementById('screenshots-section');
      if (!screenshots.length) { sec.innerHTML='<div class="card"><p style="color:#999">Нет скриншотов</p></div>'; return; }
      sec.innerHTML = '<div class="card"><div class="card-header"><h2>📸 Скриншоты ('+screenshots.length+')</h2></div><div class="gallery">'+screenshots.map((s,i)=>'<div class="gallery-item-wrap"><div class="gallery-item" onclick="openModal('+i+')"><img src="'+s.url+'" loading="lazy"></div><div style="font-size:10px;color:#999;margin-top:2px;text-align:center">'+new Date(parseInt(s.time)).toLocaleString('ru-RU',{hour:'2-digit',minute:'2-digit'})+'</div></div>').join('')+'</div></div>';
    }

    function openModal(i) { currentScreenshotIndex=i; document.getElementById('modal-img').src=screenshots[i].url; document.getElementById('modal').classList.add('active'); document.body.style.overflow='hidden'; }
    function closeModal() { document.getElementById('modal').classList.remove('active'); document.body.style.overflow=''; }
    function navModal(d) { const n=currentScreenshotIndex+d; if (n<0||n>=screenshots.length) return; openModal(n); }
    document.addEventListener('keydown',e=>{ const m=document.getElementById('modal'); if(!m.classList.contains('active')) return; if(e.key==='Escape') closeModal(); if(e.key==='ArrowLeft') navModal(-1); if(e.key==='ArrowRight') navModal(1); });
    document.getElementById('modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal(); });
    showPage();
  </script>
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.json({ ok: true, time: Date.now(), uptime: process.uptime(), server: 'express-v2' });
});

['sessions.json', 'employees.json'].forEach(f => {
  const p = path.join(DATA_DIR, f);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
});

readConfig();
app.listen(PORT, '0.0.0.0', () => { console.log('  RemoteDeskPBX SERVER v2 (Express) on port '+PORT+' /admin'); });