// Login simple con usuario y clave (fase de prueba).
// Claves guardadas con PBKDF2 + sal; sesión en una cookie firmada con HMAC.
// El secreto de firma se genera solo la primera vez y vive en la tabla settings.

const enc = new TextEncoder();
const COOKIE = 'sc_session';
const SESSION_DAYS = 60;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

function sameBytes(a, b) {
  a = new Uint8Array(a); b = new Uint8Array(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await pbkdf2(password, salt, 100000);
  return `pbkdf2$100000$${b64(salt)}$${b64(h)}`;
}

async function verifyPassword(password, stored) {
  const [alg, it, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2') return false;
  return sameBytes(await pbkdf2(password, unb64(salt), Number(it)), unb64(hash));
}

async function secretKey(env) {
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  if (!row) {
    const v = b64(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").bind(v).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  }
  return crypto.subtle.importKey('raw', unb64(row.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await secretKey(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const fromUrl = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const ok = await crypto.subtle.verify('HMAC', await secretKey(env), fromUrl(sig), enc.encode(body));
  if (!ok) return null;
  const p = JSON.parse(new TextDecoder().decode(fromUrl(body)));
  return p.exp > Date.now() ? p : null;
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function login(request, env) {
  const { username, password } = await request.json().catch(() => ({}));
  const u = String(username || '').trim().toLowerCase();
  const m = u && (await env.DB.prepare('SELECT email, pass_hash FROM members WHERE lower(username) = ?').bind(u).first());
  if (!m || !(await verifyPassword(String(password || ''), m.pass_hash))) {
    await new Promise((r) => setTimeout(r, 600)); // frena intentos por fuerza bruta
    return null;
  }
  const token = await sign(env, { email: m.email, exp: Date.now() + SESSION_DAYS * 86400000 });
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export const logoutCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function currentMember(request, env) {
  let email = null;
  if (env.DEV_USER) email = env.DEV_USER.toLowerCase(); // solo desarrollo local (.dev.vars)
  else {
    const p = await verifyToken(env, readCookie(request.headers.get('Cookie'), COOKIE)).catch(() => null);
    email = p?.email || null;
  }
  if (!email) return { error: 'unauthenticated' };
  const member = await env.DB.prepare('SELECT email, name, role, lang, username FROM members WHERE email = ?').bind(email).first();
  if (!member) return { error: 'unauthenticated' };
  return { member };
}
