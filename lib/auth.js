// Autenticación: usuarios con scrypt, sesión firmada con HMAC en cookie HttpOnly y límite de intentos.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA, 'users.json');
const SECRET_FILE = path.join(DATA, 'secret.key');
const SESSION_DAYS = 30;
const COOKIE = 'session';
const SCRYPT = { N: 16384, r: 8, p: 1 };

fs.mkdirSync(DATA, { recursive: true });

const secret = (() => {
  try { return fs.readFileSync(SECRET_FILE); }
  catch {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
})();

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function checkHash(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, expected);
}

// Hash de relleno para que un usuario inexistente tarde lo mismo que uno real.
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));

function verifyLogin(username, password) {
  const user = Object.hasOwn(loadUsers(), username) ? loadUsers()[username] : null;
  const ok = checkHash(password, user ? user.hash : DUMMY);
  return user && ok ? username : null;
}

function setPassword(username, password) {
  const users = loadUsers();
  users[username] = { hash: hashPassword(password), sv: (users[username]?.sv || 0) + 1 };
  saveUsers(users);
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');

function makeToken(username) {
  const user = loadUsers()[username];
  const payload = b64(JSON.stringify({ u: username, sv: user.sv, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return payload + '.' + sign(payload);
}

function userFromRequest(req) {
  const raw = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  if (!raw) return null;
  const [payload, mac] = raw[1].split('.');
  if (!payload || !mac) return null;
  const want = Buffer.from(sign(payload)), have = Buffer.from(mac);
  if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const user = loadUsers()[t.u];
    return user && user.sv === t.sv && t.exp > Date.now() ? t.u : null;
  } catch { return null; }
}

function cookie(value, req, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' && process.env.TRUST_PROXY;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const sessionCookie = (username, req) => cookie(makeToken(username), req, SESSION_DAYS * 86400);
const clearCookie = (req) => cookie('', req, 0);

// Límite de intentos fallidos con espera creciente.
const attempts = new Map();
const WINDOW = 15 * 60e3;
function lockedFor(key) {
  const a = attempts.get(key);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function registerFailure(key, max) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now - a.first > WINDOW) a = { count: 0, first: now, until: 0 };
  a.count++;
  if (a.count >= max) a.until = now + Math.min(30e3 * 2 ** (a.count - max), WINDOW);
  attempts.set(key, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (now - v.first > WINDOW) attempts.delete(k);
}
const clearFailures = (key) => attempts.delete(key);

function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const xf = (req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress;
}

module.exports = {
  loadUsers, saveUsers, setPassword, verifyLogin, userFromRequest,
  sessionCookie, clearCookie, lockedFor, registerFailure, clearFailures, clientIp,
};
