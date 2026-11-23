import { currentMember, login, logoutCookie, hashPassword } from '../../lib/auth.js';
import { fetchConditions } from '../../lib/conditions.js';
import { ensureSchema } from '../../lib/schema.js';

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const err = (code, status = 400) => json({ error: code }, status);
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const clampRating = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.min(5, Math.round(Number(v)))));
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const VIDEO_FIELDS = ['surfer_email', 'surfer_name', 'board_id', 'spot_id', 'recorded_at', 'wave_rating', 'surf_rating',
  'duration', 'width', 'height', 'size_bytes', 'subject_ratio', 'flags', 'highlight_at'];

function cleanVideoInput(body) {
  const v = {};
  for (const f of VIDEO_FIELDS) if (f in body) v[f] = body[f];
  if ('wave_rating' in v) v.wave_rating = clampRating(v.wave_rating);
  if ('surf_rating' in v) v.surf_rating = clampRating(v.surf_rating);
  if ('flags' in v) v.flags = JSON.stringify(Array.isArray(v.flags) ? v.flags.slice(0, 10) : []);
  if ('recorded_at' in v && v.recorded_at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v.recorded_at)) delete v.recorded_at;
  if (typeof v.surfer_name === 'string') v.surfer_name = v.surfer_name.slice(0, 80);
  for (const k of Object.keys(v)) if (v[k] === '') v[k] = null;
  return v;
}

// ---------- permisos ----------
// El dueño de un video es el surfista (o quien lo subió, si el surfista no es miembro).
const ownerOf = (v) => v.surfer_email || v.uploader_email;
const canEdit = (me, v) => v.uploader_email === me.email || v.surfer_email === me.email;
async function grant(env, owner, viewer) {
  if (owner === viewer) return { can_view: 1, can_interact: 1 };
  return (await env.DB.prepare('SELECT can_view, can_interact FROM friends WHERE owner_email = ? AND friend_email = ?').bind(owner, viewer).first()) || { can_view: 0, can_interact: 0 };
}
async function access(env, me, v) {
  if (canEdit(me, v)) return { view: true, interact: true, edit: true };
  const g = await grant(env, ownerOf(v), me.email);
  return { view: !!g.can_view, interact: !!(g.can_view && g.can_interact), edit: false };
}
const VISIBLE_SQL = `(v.uploader_email = ?1 OR v.surfer_email = ?1 OR EXISTS (SELECT 1 FROM friends f WHERE f.owner_email = COALESCE(v.surfer_email, v.uploader_email) AND f.friend_email = ?1 AND f.can_view = 1))`;

async function loadSpot(env, id) {
  return id ? env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(id).first() : null;
}
async function refreshConditions(env, videoId) {
  const v = await env.DB.prepare('SELECT spot_id, recorded_at FROM videos WHERE id = ?').bind(videoId).first();
  if (!v || !v.spot_id || !v.recorded_at) return null;
  const spot = await loadSpot(env, v.spot_id);
  if (!spot) return null;
  try {
    const c = await fetchConditions(spot, v.recorded_at);
    await env.DB.prepare('UPDATE videos SET conditions = ? WHERE id = ?').bind(JSON.stringify(c), videoId).run();
    return c;
  } catch { return null; }
}
function parseVideo(row) {
  if (!row) return row;
  return { ...row, flags: JSON.parse(row.flags || '[]'), conditions: row.conditions ? JSON.parse(row.conditions) : null };
}

const VIDEO_SELECT = `SELECT v.*, s.name AS spot_name, b.name AS board_name, b.photo_key AS board_photo,
  mm.name AS surfer_member_name, mm.avatar_key AS surfer_avatar,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.kind = 'general') AS n_general,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.kind = 'rec') AS n_rec,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.kind = 'note') AS n_note,
  (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id) AS n_likes,
  EXISTS (SELECT 1 FROM likes l WHERE l.video_id = v.id AND l.email = ?1) AS liked
  FROM videos v LEFT JOIN spots s ON s.id = v.spot_id LEFT JOIN boards b ON b.id = v.board_id
  LEFT JOIN members mm ON mm.email = v.surfer_email`;

// ---------- media ----------
const MEDIA_RE = /^(videos\/([a-f0-9]{16})\/(original|preview|poster)\.[a-z0-9]{2,5}|avatars\/[a-f0-9]{16}\.jpg|boards\/[a-f0-9]{16}\.jpg)$/;
async function serveMedia(request, env, key) {
  const obj = await env.VIDEOS.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=86400');
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  if (obj.range && request.headers.get('range')) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
async function assertUploadKey(env, me, key) {
  const m = /^videos\/([a-f0-9]{16})\/(original|preview|poster)\.[a-z0-9]{2,5}$/.exec(key || '');
  if (!m) return null;
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(m[1]).first();
  if (!v || !canEdit(me, v)) return null;
  return { video: v, part: m[2] };
}
async function putImage(env, request, prefix, oldKey) {
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 3 * 1024 * 1024) return null;
  const key = `${prefix}/${uid()}.jpg`;
  await env.VIDEOS.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  if (oldKey) await env.VIDEOS.delete(oldKey).catch(() => {});
  return key;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join('/');
  const method = request.method;
  const url = new URL(request.url);

  await ensureSchema(env.DB);

  if (path === 'login' && method === 'POST') {
    const cookie = await login(request, env);
    if (!cookie) return err('bad_login', 401);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  if (path === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': logoutCookie() });

  const auth = await currentMember(request, env);
  if (auth.error) return json(auth, 401);
  const me = auth.member;
  let m;

  try {
    // ================= sesión y perfil =================
    if (path === 'me' && method === 'GET') {
      const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
      const [members, spots, favs, boards, myGrants, grantsToMe] = await Promise.all([
        q('SELECT email, name, role, username, avatar_key FROM members ORDER BY name'),
        q('SELECT * FROM spots ORDER BY sort, name'),
        q('SELECT spot_id FROM favorite_spots WHERE email = ?', me.email),
        q('SELECT * FROM boards WHERE active = 1 ORDER BY owner_email, created_at'),
        q('SELECT friend_email, can_view, can_interact, favorite FROM friends WHERE owner_email = ?', me.email),
        q('SELECT owner_email, can_view, can_interact FROM friends WHERE friend_email = ?', me.email),
      ]);
      const meFull = await env.DB.prepare('SELECT email, name, role, lang, username, avatar_key FROM members WHERE email = ?').bind(me.email).first();
      return json({ me: meFull, members, spots, favorite_spots: favs.map((f) => f.spot_id), boards, my_grants: myGrants, grants_to_me: grantsToMe });
    }
    if (path === 'me' && method === 'PATCH') {
      const b = await request.json();
      if (b.lang && ['es', 'en', 'pt'].includes(b.lang)) await env.DB.prepare('UPDATE members SET lang = ? WHERE email = ?').bind(b.lang, me.email).run();
      if (b.name) await env.DB.prepare('UPDATE members SET name = ? WHERE email = ?').bind(String(b.name).slice(0, 60), me.email).run();
      if (b.password) {
        if (String(b.password).length < 6) return err('short_password');
        await env.DB.prepare('UPDATE members SET pass_hash = ? WHERE email = ?').bind(await hashPassword(String(b.password)), me.email).run();
      }
      return json({ ok: true });
    }
    if (path === 'me/avatar' && method === 'PUT') {
      const row = await env.DB.prepare('SELECT avatar_key FROM members WHERE email = ?').bind(me.email).first();
      const key = await putImage(env, request, 'avatars', row?.avatar_key);
      if (!key) return err('bad_image');
      await env.DB.prepare('UPDATE members SET avatar_key = ? WHERE email = ?').bind(key, me.email).run();
      return json({ avatar_key: key });
    }

    // ================= usuarios (admin) =================
    if (path === 'members' && method === 'POST') {
      if (me.role !== 'admin') return err('forbidden', 403);
      const b = await request.json();
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,30}$/.test(username)) return err('bad_username');
      if (String(b.password || '').length < 6) return err('short_password');
      const email = String(b.email || '').trim().toLowerCase() || `${username}@surfclub.local`;
      const role = ['member', 'coach', 'admin'].includes(b.role) ? b.role : 'member';
      await env.DB.prepare('INSERT INTO members (email, name, role, username, pass_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, username = excluded.username, pass_hash = excluded.pass_hash')
        .bind(email, String(b.name || username).slice(0, 60), role, username, await hashPassword(String(b.password))).run();
      return json({ ok: true });
    }

    // ================= amigos =================
    if ((m = /^friends\/(.+)$/.exec(path))) {
      const friend = decodeURIComponent(m[1]).toLowerCase();
      if (friend === me.email) return err('self');
      if (method === 'PUT') {
        const b = await request.json().catch(() => ({}));
        const exists = await env.DB.prepare('SELECT 1 FROM members WHERE email = ?').bind(friend).first();
        if (!exists) return err('not_found', 404);
        const cur = (await env.DB.prepare('SELECT * FROM friends WHERE owner_email = ? AND friend_email = ?').bind(me.email, friend).first()) || { can_view: 1, can_interact: 1, favorite: 0 };
        const val = (k) => (k in b ? (b[k] ? 1 : 0) : cur[k]);
        await env.DB.prepare(`INSERT INTO friends (owner_email, friend_email, can_view, can_interact, favorite) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_email, friend_email) DO UPDATE SET can_view = excluded.can_view, can_interact = excluded.can_interact, favorite = excluded.favorite`)
          .bind(me.email, friend, val('can_view'), val('can_interact'), val('favorite')).run();
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM friends WHERE owner_email = ? AND friend_email = ?').bind(me.email, friend).run();
        return json({ ok: true });
      }
    }

    // ================= picos =================
    if (path === 'spots' && method === 'POST') {
      const b = await request.json();
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return err('name_required');
      let lat = Number(b.lat), lon = Number(b.lon);
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon);
      if (!hasCoords) { lat = -6.23; lon = -35.044; } // por defecto: Pipa
      const id = (slug(name) || 'pico') + '-' + uid().slice(0, 4);
      // el modelo de oleaje necesita un punto en el mar: en Pipa la costa mira al este
      const fcLat = hasCoords ? lat : -6.23, fcLon = hasCoords ? lon : -34.98;
      await env.DB.prepare('INSERT INTO spots (id, name, lat, lon, fc_lat, fc_lon, sort, created_by) VALUES (?, ?, ?, ?, ?, ?, 50, ?)')
        .bind(id, name, lat, lon, fcLat, fcLon, me.email).run();
      await env.DB.prepare('INSERT OR IGNORE INTO favorite_spots (email, spot_id) VALUES (?, ?)').bind(me.email, id).run();
      return json(await loadSpot(env, id));
    }
    if ((m = /^spots\/([a-z0-9-]+)\/favorite$/.exec(path)) && method === 'PUT') {
      const { favorite } = await request.json();
      if (favorite) await env.DB.prepare('INSERT OR IGNORE INTO favorite_spots (email, spot_id) VALUES (?, ?)').bind(me.email, m[1]).run();
      else await env.DB.prepare('DELETE FROM favorite_spots WHERE email = ? AND spot_id = ?').bind(me.email, m[1]).run();
      return json({ ok: true });
    }

    // ================= tablas =================
    if (path === 'boards' && method === 'POST') {
      const b = await request.json();
      if (!b.name) return err('name_required');
      const owner = b.owner_email && (b.owner_email === me.email || me.role === 'admin') ? b.owner_email : me.email;
      const id = uid();
      await env.DB.prepare('INSERT INTO boards (id, owner_email, name, details) VALUES (?, ?, ?, ?)')
        .bind(id, owner, String(b.name).slice(0, 80), b.details ? String(b.details).slice(0, 300) : null).run();
      return json(await env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(id).first());
    }
    if ((m = /^boards\/([a-f0-9]{16})(\/photo)?$/.exec(path))) {
      const board = await env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(m[1]).first();
      if (!board) return err('not_found', 404);
      if (board.owner_email !== me.email && me.role !== 'admin') return err('forbidden', 403);
      if (m[2] && method === 'PUT') {
        const key = await putImage(env, request, 'boards', board.photo_key);
        if (!key) return err('bad_image');
        await env.DB.prepare('UPDATE boards SET photo_key = ? WHERE id = ?').bind(key, board.id).run();
        return json({ photo_key: key });
      }
      if (!m[2] && method === 'PATCH') {
        const b = await request.json();
        await env.DB.prepare('UPDATE boards SET name = COALESCE(?, name), details = COALESCE(?, details), active = COALESCE(?, active) WHERE id = ?')
          .bind(b.name ?? null, b.details ?? null, b.active ?? null, board.id).run();
        return json({ ok: true });
      }
    }

    // ================= condiciones =================
    if (path === 'conditions' && method === 'GET') {
      const spot = await loadSpot(env, url.searchParams.get('spot'));
      const at = url.searchParams.get('at');
      if (!spot || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at || '')) return err('bad_params');
      return json(await fetchConditions(spot, at));
    }

    // ================= videos =================
    if (path === 'videos' && method === 'GET') {
      const where = ["v.status = 'ready'", VISIBLE_SQL], binds = [me.email];
      const surfer = url.searchParams.get('surfer');
      if (surfer) { where.push(`COALESCE(v.surfer_email, v.uploader_email) = ?${binds.length + 1}`); binds.push(surfer); }
      const rows = await env.DB.prepare(`${VIDEO_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.recorded_at DESC, v.created_at DESC LIMIT 500`).bind(...binds).all();
      return json(rows.results.map(parseVideo));
    }
    if (path === 'videos' && method === 'POST') {
      const raw = await request.json();
      const b = cleanVideoInput(raw);
      const id = uid();
      const ext = String(request.headers.get('x-ext') || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 5) || 'mp4';
      if (!b.surfer_email && !b.surfer_name) b.surfer_email = me.email;
      const cols = ['id', 'uploader_email', ...Object.keys(b)];
      await env.DB.prepare(`INSERT INTO videos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(id, me.email, ...Object.values(b)).run();
      if (raw.note && String(raw.note).trim()) {
        await env.DB.prepare("INSERT INTO comments (id, video_id, author_email, kind, body) VALUES (?, ?, ?, 'note', ?)").bind(uid(), id, me.email, String(raw.note).trim().slice(0, 2000)).run();
      }
      await refreshConditions(env, id);
      return json({ id, keys: { original: `videos/${id}/original.${ext}`, poster: `videos/${id}/poster.jpg` } });
    }

    if ((m = /^videos\/([a-f0-9]{16})(\/like|\/comments)?$/.exec(path))) {
      const id = m[1];
      const video = await env.DB.prepare(`${VIDEO_SELECT} WHERE v.id = ?2`).bind(me.email, id).first();
      if (!video) return err('not_found', 404);
      const acc = await access(env, me, video);
      if (!acc.view) return err('forbidden', 403);

      if (m[2] === '/like' && method === 'POST') {
        if (!acc.interact) return err('forbidden', 403);
        const had = await env.DB.prepare('SELECT 1 FROM likes WHERE video_id = ? AND email = ?').bind(id, me.email).first();
        if (had) await env.DB.prepare('DELETE FROM likes WHERE video_id = ? AND email = ?').bind(id, me.email).run();
        else await env.DB.prepare('INSERT INTO likes (video_id, email) VALUES (?, ?)').bind(id, me.email).run();
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE video_id = ?').bind(id).first();
        return json({ liked: !had, n_likes: n.n });
      }
      if (m[2] === '/comments' && method === 'POST') {
        const b = await request.json();
        const body = String(b.body || '').trim().slice(0, 4000);
        if (!body) return err('empty');
        const kind = ['general', 'rec', 'note'].includes(b.kind) ? b.kind : 'general';
        if (kind === 'note' ? !acc.edit : !acc.interact) return err('forbidden', 403);
        const at = b.at_seconds == null || b.at_seconds === '' ? null : Math.max(0, Number(b.at_seconds));
        const cid = uid();
        await env.DB.prepare('INSERT INTO comments (id, video_id, author_email, kind, body, at_seconds) VALUES (?, ?, ?, ?, ?, ?)').bind(cid, id, me.email, kind, body, at).run();
        return json({ id: cid });
      }
      if (!m[2] && method === 'GET') {
        const [comments, likers] = await Promise.all([
          env.DB.prepare(`SELECT c.*, mm.name AS author_name, mm.avatar_key AS author_avatar FROM comments c
            LEFT JOIN members mm ON mm.email = c.author_email WHERE c.video_id = ? ORDER BY c.created_at`).bind(id).all(),
          env.DB.prepare('SELECT mm.name, mm.avatar_key FROM likes l JOIN members mm ON mm.email = l.email WHERE l.video_id = ? ORDER BY l.created_at').bind(id).all(),
        ]);
        return json({ ...parseVideo(video), comments: comments.results, likers: likers.results, can_edit: acc.edit, can_interact: acc.interact });
      }
      if (!m[2] && method === 'PATCH') {
        if (!acc.edit) return err('forbidden', 403);
        const raw = await request.json();
        const b = cleanVideoInput(raw);
        if (raw.status === 'ready') b.status = 'ready';
        for (const k of ['original_key', 'preview_key', 'poster_key']) if (raw[k] && String(raw[k]).startsWith(`videos/${id}/`)) b[k] = raw[k];
        const keys = Object.keys(b);
        if (keys.length) await env.DB.prepare(`UPDATE videos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(b), id).run();
        if ('spot_id' in b || 'recorded_at' in b || raw.refresh_conditions) await refreshConditions(env, id);
        return json({ ok: true });
      }
      if (!m[2] && method === 'DELETE') {
        if (!acc.edit) return err('forbidden', 403);
        const listed = await env.VIDEOS.list({ prefix: `videos/${id}/` });
        if (listed.objects.length) await env.VIDEOS.delete(listed.objects.map((o) => o.key));
        await env.DB.batch([
          env.DB.prepare('DELETE FROM comments WHERE video_id = ?').bind(id),
          env.DB.prepare('DELETE FROM likes WHERE video_id = ?').bind(id),
          env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
    }

    if ((m = /^comments\/([a-f0-9]{16})$/.exec(path)) && method === 'DELETE') {
      const c = await env.DB.prepare('SELECT c.*, v.uploader_email, v.surfer_email FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = ?').bind(m[1]).first();
      if (!c) return err('not_found', 404);
      // borra el autor, o el dueño del video
      if (c.author_email !== me.email && c.surfer_email !== me.email && c.uploader_email !== me.email) return err('forbidden', 403);
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(m[1]).run();
      return json({ ok: true });
    }

    // ================= subida a R2 =================
    if (path === 'upload/put' && method === 'PUT') {
      const key = url.searchParams.get('key');
      const ok = await assertUploadKey(env, me, key);
      if (!ok || ok.part === 'original') return err('bad_key', 403);
      await env.VIDEOS.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
      return json({ ok: true });
    }
    if (path === 'upload/create' && method === 'POST') {
      const { key, contentType } = await request.json();
      if (!(await assertUploadKey(env, me, key))) return err('bad_key', 403);
      const up = await env.VIDEOS.createMultipartUpload(key, { httpMetadata: { contentType: contentType || 'video/mp4' } });
      return json({ uploadId: up.uploadId });
    }
    if (path === 'upload/part' && method === 'PUT') {
      const key = url.searchParams.get('key');
      const uploadId = url.searchParams.get('uploadId');
      const n = Number(url.searchParams.get('part'));
      if (!(await assertUploadKey(env, me, key)) || !uploadId || !(n >= 1 && n <= 10000)) return err('bad_params', 403);
      const part = await env.VIDEOS.resumeMultipartUpload(key, uploadId).uploadPart(n, await request.arrayBuffer());
      return json(part);
    }
    if (path === 'upload/complete' && method === 'POST') {
      const { key, uploadId, parts } = await request.json();
      if (!(await assertUploadKey(env, me, key))) return err('bad_key', 403);
      const obj = await env.VIDEOS.resumeMultipartUpload(key, uploadId).complete(parts);
      return json({ ok: true, size: obj.size });
    }
    if (path === 'upload/abort' && method === 'POST') {
      const { key, uploadId } = await request.json();
      if (!(await assertUploadKey(env, me, key))) return err('bad_key', 403);
      await env.VIDEOS.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }

    // ================= servir archivos =================
    if (path.startsWith('media/') && (method === 'GET' || method === 'HEAD')) {
      const key = path.slice('media/'.length);
      const mm = MEDIA_RE.exec(key);
      if (!mm) return err('bad_key', 404);
      if (mm[2]) { // video: respetar permisos
        const v = await env.DB.prepare('SELECT uploader_email, surfer_email FROM videos WHERE id = ?').bind(mm[2]).first();
        if (!v || !(await access(env, me, v)).view) return err('forbidden', 403);
      }
      return serveMedia(request, env, key);
    }

    return err('not_found', 404);
  } catch (e) {
    return json({ error: 'server_error', detail: String((e && e.message) || e) }, 500);
  }
}
