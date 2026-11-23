import { currentMember } from '../../lib/auth.js';
import { fetchConditions } from '../../lib/conditions.js';
import { ensureSchema } from '../../lib/schema.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (code, status = 400) => json({ error: code }, status);
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const clampRating = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.min(5, Math.round(Number(v)))));

const VIDEO_FIELDS = ['surfer_email', 'surfer_name', 'board_id', 'spot_id', 'recorded_at', 'source', 'wave_rating', 'surf_rating',
  'title', 'notes', 'duration', 'width', 'height', 'size_bytes', 'subject_ratio', 'flags', 'highlight_at'];

function cleanVideoInput(body) {
  const v = {};
  for (const f of VIDEO_FIELDS) if (f in body) v[f] = body[f];
  if ('wave_rating' in v) v.wave_rating = clampRating(v.wave_rating);
  if ('surf_rating' in v) v.surf_rating = clampRating(v.surf_rating);
  if ('flags' in v) v.flags = JSON.stringify(Array.isArray(v.flags) ? v.flags.slice(0, 10) : []);
  if ('source' in v && !['camera', 'phone', 'unknown'].includes(v.source)) v.source = 'unknown';
  if ('recorded_at' in v && v.recorded_at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v.recorded_at)) delete v.recorded_at;
  for (const k of ['title', 'notes', 'surfer_name']) if (typeof v[k] === 'string') v[k] = v[k].slice(0, k === 'notes' ? 4000 : 200);
  for (const k of Object.keys(v)) if (v[k] === '') v[k] = null;
  return v;
}

async function loadSpot(env, id) {
  return id ? env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(id).first() : null;
}

async function refreshConditions(env, videoId) {
  const v = await env.DB.prepare('SELECT spot_id, recorded_at FROM videos WHERE id = ?').bind(videoId).first();
  if (!v || !v.spot_id || !v.recorded_at) return null;
  const spot = await loadSpot(env, v.spot_id);
  try {
    const c = await fetchConditions(spot, v.recorded_at);
    await env.DB.prepare('UPDATE videos SET conditions = ? WHERE id = ?').bind(JSON.stringify(c), videoId).run();
    return c;
  } catch (e) {
    return null;
  }
}

function parseVideo(row) {
  if (!row) return row;
  return { ...row, flags: JSON.parse(row.flags || '[]'), conditions: row.conditions ? JSON.parse(row.conditions) : null };
}

const canEdit = (me, video) => me.role === 'admin' || video.uploader_email === me.email || video.surfer_email === me.email;

// ---------- media (con soporte de Range para que el video se pueda adelantar) ----------
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

// la llave debe pertenecer a un video que el usuario está subiendo
async function assertUploadKey(env, me, key) {
  const m = /^videos\/([a-f0-9]{16})\/(original|preview|poster)\.[a-z0-9]{2,5}$/.exec(key || '');
  if (!m) return null;
  const v = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(m[1]).first();
  if (!v || !canEdit(me, v)) return null;
  return { video: v, part: m[2] };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join('/');
  const method = request.method;
  const url = new URL(request.url);

  await ensureSchema(env.DB);
  const auth = await currentMember(request, env);
  if (auth.error) return json(auth, 401);
  const me = auth.member;

  try {
    // ---------- sesión ----------
    if (path === 'me' && method === 'GET') {
      const [members, spots, boards] = await Promise.all([
        env.DB.prepare('SELECT email, name, role FROM members ORDER BY name').all(),
        env.DB.prepare('SELECT * FROM spots ORDER BY sort').all(),
        env.DB.prepare('SELECT * FROM boards WHERE active = 1 ORDER BY owner_email, name').all(),
      ]);
      return json({ me, members: members.results, spots: spots.results, boards: boards.results });
    }
    if (path === 'me' && method === 'PATCH') {
      const b = await request.json();
      if (b.lang && ['es', 'en', 'pt'].includes(b.lang)) await env.DB.prepare('UPDATE members SET lang = ? WHERE email = ?').bind(b.lang, me.email).run();
      if (b.name) await env.DB.prepare('UPDATE members SET name = ? WHERE email = ?').bind(String(b.name).slice(0, 60), me.email).run();
      return json({ ok: true });
    }

    // ---------- miembros (solo admin) ----------
    if (path === 'members' && method === 'POST') {
      if (me.role !== 'admin') return err('forbidden', 403);
      const b = await request.json();
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('bad_email');
      const role = ['member', 'coach', 'admin'].includes(b.role) ? b.role : 'member';
      await env.DB.prepare('INSERT INTO members (email, name, role) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role')
        .bind(email, String(b.name || email.split('@')[0]).slice(0, 60), role).run();
      return json({ ok: true });
    }

    // ---------- tablas ----------
    if (path === 'boards' && method === 'POST') {
      const b = await request.json();
      if (!b.name) return err('name_required');
      const owner = me.role === 'admin' && b.owner_email ? b.owner_email : me.email;
      const id = uid();
      await env.DB.prepare('INSERT INTO boards (id, owner_email, name, details) VALUES (?, ?, ?, ?)')
        .bind(id, owner, String(b.name).slice(0, 80), b.details ? String(b.details).slice(0, 300) : null).run();
      return json(await env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(id).first());
    }
    let m;
    if ((m = /^boards\/([a-f0-9]{16})$/.exec(path))) {
      const board = await env.DB.prepare('SELECT * FROM boards WHERE id = ?').bind(m[1]).first();
      if (!board) return err('not_found', 404);
      if (board.owner_email !== me.email && me.role !== 'admin') return err('forbidden', 403);
      if (method === 'PATCH') {
        const b = await request.json();
        await env.DB.prepare('UPDATE boards SET name = COALESCE(?, name), details = COALESCE(?, details), active = COALESCE(?, active) WHERE id = ?')
          .bind(b.name ?? null, b.details ?? null, b.active ?? null, m[1]).run();
        return json({ ok: true });
      }
    }

    // ---------- condiciones (vista previa en el formulario) ----------
    if (path === 'conditions' && method === 'GET') {
      const spot = await loadSpot(env, url.searchParams.get('spot'));
      const at = url.searchParams.get('at');
      if (!spot || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at || '')) return err('bad_params');
      return json(await fetchConditions(spot, at));
    }

    // ---------- videos ----------
    if (path === 'videos' && method === 'GET') {
      const where = ["v.status = 'ready'"], binds = [];
      for (const [p, col] of [['surfer', 'v.surfer_email'], ['spot', 'v.spot_id'], ['board', 'v.board_id']]) {
        const val = url.searchParams.get(p);
        if (val) { where.push(`${col} = ?`); binds.push(val); }
      }
      const rows = await env.DB.prepare(
        `SELECT v.*, s.name AS spot_name, b.name AS board_name, mm.name AS surfer_member_name,
          (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.kind = 'general') AS n_general,
          (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.kind = 'coach') AS n_coach
         FROM videos v LEFT JOIN spots s ON s.id = v.spot_id LEFT JOIN boards b ON b.id = v.board_id
         LEFT JOIN members mm ON mm.email = v.surfer_email
         WHERE ${where.join(' AND ')} ORDER BY v.recorded_at DESC, v.created_at DESC LIMIT 500`
      ).bind(...binds).all();
      return json(rows.results.map(parseVideo));
    }

    if (path === 'videos' && method === 'POST') {
      const b = cleanVideoInput(await request.json());
      const id = uid();
      const ext = (await request.headers.get('x-ext')) || 'mp4';
      const cols = ['id', 'uploader_email', ...Object.keys(b)];
      const vals = [id, me.email, ...Object.values(b)];
      if (!b.surfer_email && !b.surfer_name) { cols.push('surfer_email'); vals.push(me.email); }
      await env.DB.prepare(`INSERT INTO videos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...vals).run();
      await refreshConditions(env, id);
      return json({ id, keys: { original: `videos/${id}/original.${ext.replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4'}`, preview: `videos/${id}/preview.mp4`, poster: `videos/${id}/poster.jpg` } });
    }

    if ((m = /^videos\/([a-f0-9]{16})$/.exec(path))) {
      const id = m[1];
      const video = await env.DB.prepare(
        `SELECT v.*, s.name AS spot_name, b.name AS board_name, mm.name AS surfer_member_name
         FROM videos v LEFT JOIN spots s ON s.id = v.spot_id LEFT JOIN boards b ON b.id = v.board_id
         LEFT JOIN members mm ON mm.email = v.surfer_email WHERE v.id = ?`).bind(id).first();
      if (!video) return err('not_found', 404);

      if (method === 'GET') {
        const comments = await env.DB.prepare(
          `SELECT c.*, mm.name AS author_name, mm.role AS author_role FROM comments c
           LEFT JOIN members mm ON mm.email = c.author_email WHERE c.video_id = ? ORDER BY c.created_at`).bind(id).all();
        return json({ ...parseVideo(video), comments: comments.results, can_edit: canEdit(me, video) });
      }
      if (!canEdit(me, video)) return err('forbidden', 403);

      if (method === 'PATCH') {
        const raw = await request.json();
        const b = cleanVideoInput(raw);
        if (raw.status === 'ready') b.status = 'ready';
        if (raw.original_key) b.original_key = raw.original_key;
        if (raw.preview_key) b.preview_key = raw.preview_key;
        if (raw.poster_key) b.poster_key = raw.poster_key;
        const keys = Object.keys(b);
        if (keys.length) {
          await env.DB.prepare(`UPDATE videos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(b), id).run();
        }
        if ('spot_id' in b || 'recorded_at' in b || raw.refresh_conditions) await refreshConditions(env, id);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        const listed = await env.VIDEOS.list({ prefix: `videos/${id}/` });
        if (listed.objects.length) await env.VIDEOS.delete(listed.objects.map((o) => o.key));
        await env.DB.prepare('DELETE FROM comments WHERE video_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
    }

    // ---------- comentarios ----------
    if ((m = /^videos\/([a-f0-9]{16})\/comments$/.exec(path)) && method === 'POST') {
      const b = await request.json();
      const body = String(b.body || '').trim().slice(0, 4000);
      if (!body) return err('empty');
      const kind = b.kind === 'coach' ? 'coach' : 'general';
      const at = b.at_seconds == null || b.at_seconds === '' ? null : Math.max(0, Number(b.at_seconds));
      const id = uid();
      await env.DB.prepare('INSERT INTO comments (id, video_id, author_email, kind, body, at_seconds) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, m[1], me.email, kind, body, at).run();
      return json({ id });
    }
    if ((m = /^comments\/([a-f0-9]{16})$/.exec(path)) && method === 'DELETE') {
      const c = await env.DB.prepare('SELECT * FROM comments WHERE id = ?').bind(m[1]).first();
      if (!c) return err('not_found', 404);
      if (c.author_email !== me.email && me.role !== 'admin') return err('forbidden', 403);
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(m[1]).run();
      return json({ ok: true });
    }

    // ---------- subida a R2 ----------
    if (path === 'upload/put' && method === 'PUT') {
      // archivos chicos (preview y poster)
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
      const up = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      const part = await up.uploadPart(n, await request.arrayBuffer());
      return json(part);
    }
    if (path === 'upload/complete' && method === 'POST') {
      const { key, uploadId, parts } = await request.json();
      if (!(await assertUploadKey(env, me, key))) return err('bad_key', 403);
      const up = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      const obj = await up.complete(parts);
      return json({ ok: true, size: obj.size });
    }
    if (path === 'upload/abort' && method === 'POST') {
      const { key, uploadId } = await request.json();
      if (!(await assertUploadKey(env, me, key))) return err('bad_key', 403);
      await env.VIDEOS.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }

    // ---------- servir video / preview / poster ----------
    if (path.startsWith('media/') && (method === 'GET' || method === 'HEAD')) {
      const key = path.slice('media/'.length);
      if (!/^videos\/[a-f0-9]{16}\/(original|preview|poster)\.[a-z0-9]{2,5}$/.test(key)) return err('bad_key', 404);
      return serveMedia(request, env, key);
    }

    return err('not_found', 404);
  } catch (e) {
    return json({ error: 'server_error', detail: String(e && e.message || e) }, 500);
  }
}
