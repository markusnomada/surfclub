// Autenticación con Cloudflare Access.
// Access pone delante de la app un login por correo (código de un solo uso).
// Aquí verificamos la firma del JWT que Access agrega a cada request y
// comprobamos que el correo sea miembro del club.

let jwksCache = { at: 0, keys: null, domain: null };

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKeys(domain) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.domain === domain && now - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('No se pudieron leer las llaves de Access');
  const { keys } = await res.json();
  jwksCache = { at: now, keys, domain };
  return keys;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function verifyAccessJwt(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request.headers.get('Cookie'), 'CF_Authorization');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  const keys = await getKeys(env.ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return (payload.email || '').toLowerCase() || null;
}

export async function currentMember(request, env) {
  let email = null;
  if (env.DEV_USER) {
    email = env.DEV_USER.toLowerCase(); // solo desarrollo local (.dev.vars)
  } else if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    email = await verifyAccessJwt(request, env);
  }
  if (!email) return { error: 'unauthenticated' };
  const member = await env.DB.prepare('SELECT email, name, role, lang FROM members WHERE email = ?').bind(email).first();
  if (!member) return { error: 'not_member', email };
  return { member };
}
