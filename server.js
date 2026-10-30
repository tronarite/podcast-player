// Servidor del reproductor de podcasts. Sin dependencias: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./lib/auth');
const { ROOT, AUDIO_EXT, publicLibrary, coverFor, chaptersFor } = require('./lib/library');

const PORT = Number(process.env.PORT) || 48213;
const AUTH = process.env.AUTH === 'on'; // login desactivado por defecto; AUTH=on lo activa
const HOST = process.env.HOST || '127.0.0.1'; // HOST=0.0.0.0 para abrirlo a tu red local
// Nombres de host aceptados (contra DNS rebinding). Vacío = cualquiera. Ej.: ALLOWED_HOSTS=100.64.0.1:48213,localhost:48213
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const PUBLIC = path.join(__dirname, 'public');
const PROGRESS_FILE = path.join(__dirname, 'data', 'progress.json');
const USERDATA_FILE = path.join(__dirname, 'data', 'userdata.json');
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/style.css', '/favicon.svg']);
const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// ---- Datos por usuario guardados en disco con escritura diferida ----
function jsonStore(file) {
  let data = {}, dirty = false;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primera vez */ }
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(file + '.tmp', JSON.stringify(data), (err) => {
      if (err) { dirty = true; return; }
      fs.rename(file + '.tmp', file, () => {});
    });
  };
  setInterval(flush, 2000).unref();
  return { data, touch() { dirty = true; }, flushSync() { dirty && fs.writeFileSync(file, JSON.stringify(data)); } };
}
const progressStore = jsonStore(PROGRESS_FILE), progress = progressStore.data;
const userStore = jsonStore(USERDATA_FILE), userdata = userStore.data;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { progressStore.flushSync(); userStore.flushSync(); process.exit(0); });

function mergeProgress(user, entries) {
  const mine = (progress[user] ||= {});
  let n = 0;
  for (const [id, e] of Object.entries(entries)) {
    if (++n > 500) break;
    if (id.length > 600 || !e || typeof e !== 'object') continue;
    const t = Number(e.t), d = Number(e.d);
    if (!Number.isFinite(t) || !Number.isFinite(d) || t < 0 || d < 0) continue;
    if (!(id in mine) && Object.keys(mine).length >= 20000) continue;
    mine[id] = { t, d, done: !!e.done, u: Date.now() };
    progressStore.touch();
  }
}

// Segundos escuchados por día, sumados desde todos los dispositivos.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function addListened(user, listened) {
  const stats = ((userdata[user] ||= {}).stats ||= { secs: 0, days: {} });
  for (const [day, v] of Object.entries(listened).slice(0, 10)) {
    const secs = Number(v);
    if (!DAY.test(day) || !Number.isFinite(secs) || secs <= 0 || secs > 3600) continue;
    stats.days[day] = Math.min(86400, (stats.days[day] || 0) + secs);
    stats.secs += secs;
    userStore.touch();
  }
  const days = Object.keys(stats.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 400))) delete stats.days[d];
}

// Cola, favoritos, marcadores y ajustes: se validan y se guardan enteros.
function cleanUserData(b) {
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const ids = (a, max) => (Array.isArray(a) ? [...new Set(a.filter((x) => str(x, 600)))].slice(0, max) : []);
  const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  const out = { queue: ids(b.queue, 500), stars: ids(b.stars, 5000), bookmarks: {}, series: {}, settings: {} };
  for (const [id, list] of Object.entries(obj(b.bookmarks)).slice(0, 2000)) {
    if (!str(id, 600) || !Array.isArray(list)) continue;
    const marks = list.filter((m) => m && num(m.t, 0, 1e6)).slice(0, 100)
      .map((m) => ({ t: m.t, note: str(m.note, 200) ? m.note : '' }));
    if (marks.length) out.bookmarks[id] = marks;
  }
  for (const [name, p] of Object.entries(obj(b.series)).slice(0, 1000)) {
    if (!str(name, 300) || !p || typeof p !== 'object') continue;
    out.series[name] = { speed: num(p.speed, 0.5, 3) ? p.speed : 0, intro: num(p.intro, 0, 900) ? p.intro : 0, outro: num(p.outro, 0, 900) ? p.outro : 0 };
  }
  const s = obj(b.settings);
  out.settings = { back: num(s.back, 5, 120) ? s.back : 15, fwd: num(s.fwd, 5, 180) ? s.fwd : 30, autoplay: s.autoplay !== false };
  return out;
}

// ---- Utilidades HTTP ----
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj, headers) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Peticiones que cambian estado: solo JSON y, si hay Origin, del mismo sitio.
function sameSiteJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  return !origin || new URL(origin).host === req.headers.host;
}

function sendFile(req, res, filePath, extra = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'No encontrado');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra };
    let start = 0, end = stat.size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else start = Math.max(stat.size - Number(range[2]), 0);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

// Resuelve una ruta relativa dentro de base sin permitir salirse de ella.
function safeJoin(base, rel) {
  const full = path.resolve(base, rel);
  return full.startsWith(path.resolve(base) + path.sep) ? full : null;
}
// Igual, pero resolviendo enlaces simbólicos: el destino real también debe quedar dentro de base.
function safeRealJoin(base, rel) {
  const full = safeJoin(base, rel);
  if (!full) return null;
  try {
    const real = fs.realpathSync(full), root = fs.realpathSync(base);
    return real.startsWith(root + path.sep) ? real : null;
  } catch { return full; } // no existe: sendFile responderá 404
}

// ---- Rutas ----
async function login(req, res) {
  if (!sameSiteJson(req)) return json(res, 400, { error: 'Petición no válida' });
  const ip = auth.clientIp(req);
  const wait = auth.lockedFor('ip:' + ip);
  if (wait) return json(res, 429, { error: `Demasiados intentos. Espera ${wait} s.` }, { 'Retry-After': wait });
  let body;
  try { body = await readBody(req, 4096); } catch { return json(res, 400, { error: 'Petición no válida' }); }
  const username = String(body.username ?? '').slice(0, 64), password = String(body.password ?? '').slice(0, 256);
  const user = auth.verifyLogin(username, password);
  if (!user) {
    auth.registerFailure('ip:' + ip, 5);
    return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  auth.clearFailures('ip:' + ip);
  json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(user, req) });
}

async function handle(req, res) {
  if (ALLOWED_HOSTS.size && !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, 'Host no permitido');
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return send(res, 400, ''); }

  if (pathname === '/api/login' && req.method === 'POST') return login(req, res);

  const user = AUTH ? auth.userFromRequest(req) : 'local';

  if (PUBLIC_FILES.has(pathname)) {
    if (pathname === '/login.html' && user) return send(res, 302, '', { Location: '/' });
    return sendFile(req, res, path.join(PUBLIC, pathname.slice(1)), { 'Cache-Control': 'no-cache' });
  }

  if (!user) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/audio/')) return json(res, 401, { error: 'No autenticado' });
    return send(res, 302, '', { Location: '/login.html' });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    if (!sameSiteJson(req)) return json(res, 400, { error: 'Petición no válida' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
  }
  if (pathname === '/api/me') return json(res, 200, { user, auth: AUTH });

  if (pathname === '/api/library') {
    try { return json(res, 200, publicLibrary()); }
    catch (e) { console.error(`No se pudo leer ${ROOT}:`, e.message); return json(res, 500, { error: 'No se pudo leer la biblioteca' }); }
  }

  if (pathname.startsWith('/api/cover/')) {
    const cover = coverFor(pathname.slice('/api/cover/'.length));
    if (!cover) return send(res, 404, '');
    return send(res, 200, cover.data, { 'Content-Type': cover.mime, 'Cache-Control': 'private, max-age=604800' });
  }

  if (pathname === '/api/progress') {
    if (req.method === 'GET') return json(res, 200, progress[user] || {});
    if (req.method === 'PUT') {
      if (!sameSiteJson(req)) return json(res, 400, { error: 'Petición no válida' });
      try {
        const body = await readBody(req);
        mergeProgress(user, body.entries || {});
        if (body.listened && typeof body.listened === 'object') addListened(user, body.listened);
      } catch { return json(res, 400, { error: 'Petición no válida' }); }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  }

  if (pathname === '/api/userdata') {
    const mine = userdata[user] || {};
    if (req.method === 'GET') return json(res, 200, { ...cleanUserData(mine), stats: mine.stats || { secs: 0, days: {} } });
    if (req.method === 'PUT') {
      if (!sameSiteJson(req)) return json(res, 400, { error: 'Petición no válida' });
      try { userdata[user] = { ...cleanUserData(await readBody(req, 512 * 1024)), stats: mine.stats }; } catch { return json(res, 400, { error: 'Petición no válida' }); }
      userStore.touch();
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  }

  if (pathname === '/api/chapters') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    return json(res, 200, chaptersFor(id), { 'Cache-Control': 'private, max-age=3600' });
  }

  // Lo que queda son ficheros: solo lectura.
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });

  if (pathname.startsWith('/audio/')) {
    const file = safeRealJoin(ROOT, pathname.slice(7));
    if (!file || !AUDIO_EXT.has(path.extname(file).toLowerCase())) return send(res, 403, '');
    return sendFile(req, res, file, { 'Cache-Control': 'private, max-age=3600' });
  }

  const file = safeRealJoin(PUBLIC, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file) return send(res, 403, '');
  sendFile(req, res, file, { 'Cache-Control': 'no-cache' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Error interno'); else res.destroy(); });
}).listen(PORT, HOST, () => {
  console.log(`Reproductor listo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Biblioteca: ${ROOT}`);
  console.log(AUTH ? 'Login: activado' : 'Login: DESACTIVADO (cualquiera con acceso a la red puede escuchar). Actívalo con AUTH=on');
  if (AUTH && !Object.keys(auth.loadUsers()).length) console.log('Aún no hay usuarios: ejecuta  node manage-users.js add <usuario>');
});
