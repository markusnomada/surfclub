import { t, setLang, getLang } from './i18n.js';
import { readMp4CreationTime, loadVideo, detectSubject, computeFlags, makePreview, uploadMultipart } from './media.js';

// ---------------- estado y API ----------------
const S = { me: null, members: [], spots: [], boards: [], videos: null, filters: { surfer: '' }, board: { group: 'session', zoom: 220 } };
try { Object.assign(S.board, JSON.parse(localStorage.getItem('sc_board') || '{}')); } catch {}
const saveBoardPrefs = () => { try { localStorage.setItem('sc_board', JSON.stringify(S.board)); } catch {} };

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (raw) { opts.body = raw; opts.headers['content-type'] = raw.type || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch('/api/' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
  return data;
}
const media = (key) => (key ? '/api/media/' + key : '');

// ---------------- helpers de DOM ----------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
// replaceChildren que ignora null/false (permite condicionales inline)
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); };
const $app = () => document.getElementById('app');
const stars = (n) => (n == null ? '–' : '★'.repeat(n) + '☆'.repeat(5 - n));
const memberName = (email) => S.members.find((m) => m.email === email)?.name || email || '';
const surferName = (v) => v.surfer_member_name || v.surfer_name || memberName(v.surfer_email);
function fmtDate(s, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!s) return '–';
  const d = new Date(s.length === 16 ? s + ':00' : s);
  return new Intl.DateTimeFormat({ es: 'es', en: 'en', pt: 'pt-BR' }[getLang()], opts).format(d);
}
const fmtSec = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
const compass = (deg) => (deg == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((deg % 360) / 45)) % 8]);
const arrow = (deg) => (deg == null ? '' : h('span', { class: 'arrow', style: `transform:rotate(${deg + 180}deg)` }, '↑'));

// reproduce solo los clips visibles (ahorra batería y datos)
const io = new IntersectionObserver((entries) => {
  for (const e of entries) { const v = e.target; if (e.isIntersecting) { if (!v.src && v.dataset.src) v.src = v.dataset.src; v.play().catch(() => {}); } else v.pause(); }
}, { rootMargin: '200px' });
function loopVideo(v) {
  const el = h('video', { class: 'loop', muted: true, loop: true, playsInline: true, preload: 'none', poster: media(v.poster_key) });
  el.muted = true; el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
  el.dataset.src = media(v.preview_key);
  io.observe(el);
  return el;
}

function flagChips(flags, withHelp = false) {
  return (flags || []).map((f) => h('span', { class: `chip flag flag-${f}`, title: t(`flag_${f}_help`) }, t(`flag_${f}`), withHelp ? h('small', {}, t(`flag_${f}_help`)) : null));
}

// ---------------- navegación ----------------
function nav(active) {
  const link = (hash, key) => h('a', { href: hash, class: active === key ? 'active' : '' }, t(key));
  return h('header', { class: 'top' },
    h('a', { href: '#/', class: 'brand' }, h('span', { class: 'mark' }, '≈'), t('brand')),
    h('nav', {}, link('#/', 'nav_timeline'), link('#/pizarra', 'nav_board'), link('#/subir', 'nav_upload'), link('#/perfil', 'nav_profile')),
  );
}

async function loadVideos(force = false) {
  if (!S.videos || force) S.videos = await api('videos');
  return S.videos;
}

function surferFilter(onChange) {
  const opts = [{ email: '', name: t('all_surfers') }, ...S.members];
  return h('div', { class: 'chips' }, opts.map((m) =>
    h('button', { class: 'chip' + (S.filters.surfer === m.email ? ' on' : ''), onclick: () => { S.filters.surfer = m.email; onChange(); } }, m.name)));
}
const filtered = () => (S.videos || []).filter((v) => !S.filters.surfer || v.surfer_email === S.filters.surfer);

// ---------------- vista: línea de tiempo ----------------
function evolutionChart(videos) {
  const pts = videos.filter((v) => v.surf_rating != null && v.recorded_at).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  if (pts.length < 2) return null;
  const W = 640, H = 120, P = 18;
  const x0 = Date.parse(pts[0].recorded_at), x1 = Date.parse(pts.at(-1).recorded_at) || x0 + 1;
  const X = (v) => P + ((Date.parse(v.recorded_at) - x0) / Math.max(1, x1 - x0)) * (W - 2 * P);
  const Y = (r) => H - P - (r / 5) * (H - 2 * P);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(v.surf_rating).toFixed(1)}`).join(' ');
  const wave = pts.filter((v) => v.wave_rating != null).map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(v.wave_rating).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="evo"><line x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}" class="axis"/><line x1="${P}" x2="${W - P}" y1="${Y(5)}" y2="${Y(5)}" class="axis"/>
    <path d="${wave}" class="wave"/><path d="${line}" class="surf"/>${pts.map((v) => `<circle cx="${X(v)}" cy="${Y(v.surf_rating)}" r="3.5"/>`).join('')}</svg>`;
  return h('div', { class: 'card evo-card' }, h('div', { class: 'evo-head' }, h('strong', {}, t('evolution')),
    h('span', { class: 'legend' }, h('i', { class: 'l-surf' }), t('surf'), ' ', h('i', { class: 'l-wave' }), t('wave'))), h('div', { html: svg }));
}

function videoCard(v) {
  return h('a', { class: 'vcard', href: `#/v/${v.id}` },
    h('div', { class: 'thumb' }, loopVideo(v), h('div', { class: 'overlay' }, flagChips(v.flags))),
    h('div', { class: 'meta' },
      h('div', { class: 'row1' }, h('strong', {}, v.title || surferName(v)), h('span', { class: 'muted' }, fmtDate(v.recorded_at, { timeStyle: 'short' }))),
      h('div', { class: 'row2' },
        h('span', { title: t('wave') }, t('wave'), ' ', h('b', { class: 'stars' }, stars(v.wave_rating))),
        h('span', { title: t('surf') }, t('surf'), ' ', h('b', { class: 'stars' }, stars(v.surf_rating)))),
      h('div', { class: 'row3 muted' }, [v.board_name, v.conditions?.swell_height != null ? `${v.conditions.swell_height} m · ${v.conditions.swell_period}s` : null, (v.n_general + v.n_coach) ? `✎ ${v.n_general + v.n_coach}` : null].filter(Boolean).join(' · '))));
}

async function viewTimeline() {
  const root = $app(); root.replaceChildren(nav('nav_timeline'), h('main', { class: 'wrap' }, h('p', { class: 'muted' }, t('loading'))));
  await loadVideos();
  const render = () => {
    const vids = filtered();
    const groups = new Map();
    for (const v of vids) {
      const day = (v.recorded_at || v.created_at).slice(0, 10);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(v);
    }
    const main = h('main', { class: 'wrap' },
      surferFilter(render),
      S.filters.surfer ? evolutionChart(vids) : null,
      vids.length ? h('div', { class: 'timeline' }, [...groups].map(([day, list]) =>
        h('section', { class: 'day' },
          h('div', { class: 'dot' }),
          h('h2', {}, h('span', { class: 'cap' }, fmtDate(day + 'T12:00', { dateStyle: 'full' })), h('span', { class: 'muted' }, ' · ', [...new Set(list.map((v) => v.spot_name).filter(Boolean))].join(', '))),
          dayConditions(list),
          h('div', { class: 'cards' }, list.map(videoCard))))) : h('div', { class: 'empty card' }, t('empty'), ' ', h('a', { href: '#/subir' }, t('nav_upload'), ' →')));
    root.replaceChildren(nav('nav_timeline'), main);
  };
  render();
}

function dayConditions(list) {
  const c = list.find((v) => v.conditions && v.conditions.swell_height != null)?.conditions;
  if (!c) return null;
  return h('div', { class: 'daycond muted' },
    `${t('swell')} ${c.swell_height} m · ${c.swell_period}s ${compass(c.swell_direction)} — ${t('wind')} ${c.wind_speed ?? '–'} km/h ${compass(c.wind_direction)} — ${t('tide')} ${c.tide_height ?? '–'} m ${c.tide_trend ? t(c.tide_trend) : ''}`);
}

// ---------------- vista: pizarra ----------------
async function viewBoard() {
  const root = $app(); root.replaceChildren(nav('nav_board'), h('main', { class: 'wrap wide' }, h('p', { class: 'muted' }, t('loading'))));
  await loadVideos();
  const render = () => {
    const vids = filtered();
    const key = { session: (v) => `${(v.recorded_at || '').slice(0, 10)} · ${v.spot_name || ''}`, spot: (v) => v.spot_name || '–', board: (v) => v.board_name || '–', none: () => '' }[S.board.group];
    const groups = new Map();
    for (const v of vids) { const k = key(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
    const zoom = h('input', { type: 'range', min: 120, max: 520, step: 10, value: S.board.zoom, oninput: (e) => { S.board.zoom = +e.target.value; grid.style.setProperty('--z', S.board.zoom + 'px'); saveBoardPrefs(); } });
    const grp = h('select', { onchange: (e) => { S.board.group = e.target.value; saveBoardPrefs(); render(); } },
      ['session', 'spot', 'board', 'none'].map((g) => h('option', { value: g, selected: S.board.group === g }, t('g_' + g))));
    const grid = h('div', { class: 'board', style: `--z:${S.board.zoom}px` }, [...groups].map(([k, list]) => [
      k ? h('h3', { class: 'gh' }, k, h('span', { class: 'muted' }, ` · ${list.length} ${t('videos_n')}`)) : null,
      h('div', { class: 'bgrid' }, list.map((v) => h('a', { class: 'tile', href: `#/v/${v.id}`, title: v.title || '' },
        loopVideo(v),
        h('div', { class: 'tile-meta' }, h('span', {}, surferName(v)), h('span', { class: 'stars' }, stars(v.surf_rating))),
        (v.flags || []).length ? h('div', { class: 'tile-flags' }, flagChips(v.flags)) : null))),
    ]));
    root.replaceChildren(nav('nav_board'), h('main', { class: 'wrap wide' },
      h('div', { class: 'toolbar' }, surferFilter(render), h('label', {}, t('group_by'), ' ', grp), h('label', {}, t('zoom'), ' ', zoom)),
      vids.length ? grid : h('div', { class: 'empty card' }, t('empty'))));
  };
  render();
}

// ---------------- vista: detalle ----------------
function tideCurve(c) {
  if (!c?.tide_curve?.length) return null;
  const W = 260, H = 70, P = 6;
  const vals = c.tide_curve.map(([, v]) => v).filter((v) => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const X = (i) => P + (i / (c.tide_curve.length - 1)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - lo) / Math.max(0.01, hi - lo)) * (H - 2 * P);
  const d = c.tide_curve.map(([, v], i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v ?? lo).toFixed(1)}`).join(' ');
  const [hh, mm] = c.at.slice(11, 16).split(':').map(Number);
  const xi = X((hh + mm / 60) * ((c.tide_curve.length - 1) / 23));
  return h('div', { html: `<svg viewBox="0 0 ${W} ${H}" class="tidecurve"><path d="${d}"/><line x1="${xi}" x2="${xi}" y1="0" y2="${H}"/><circle cx="${xi}" cy="${Y(c.tide_height ?? lo)}" r="4"/></svg>` });
}

function conditionsPanel(c) {
  if (!c || (c.swell_height == null && c.wind_speed == null)) return h('p', { class: 'muted' }, t('no_conditions'));
  const row = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
  return h('div', { class: 'cond' },
    row(t('swell'), h('span', {}, `${c.swell_height ?? '–'} m · ${c.swell_period ?? '–'} s `, arrow(c.swell_direction), ` ${compass(c.swell_direction)} ${c.swell_direction ?? ''}°`)),
    row(t('waves'), `${c.wave_height ?? '–'} m · ${c.wave_period ?? '–'} s`),
    row(t('wind'), h('span', {}, `${c.wind_speed ?? '–'} km/h (${c.wind_gusts ?? '–'}) `, arrow(c.wind_direction), ` ${compass(c.wind_direction)}`)),
    row(t('tide'), `${c.tide_height ?? '–'} m ${c.tide_trend ? '· ' + t(c.tide_trend) : ''}`),
    c.tide_day_min != null ? h('div', { class: 'muted small' }, `${t('tide_range')}: ${c.tide_day_min} → ${c.tide_day_max} m`) : null,
    tideCurve(c),
    c.sea_temp != null ? row(t('sea_temp'), `${c.sea_temp} °C`) : null,
    h('p', { class: 'muted small' }, t('tide_note'), ' Open-Meteo.'));
}

async function viewDetail(id) {
  const root = $app(); root.replaceChildren(nav(''), h('main', { class: 'wrap' }, h('p', { class: 'muted' }, t('loading'))));
  const v = await api('videos/' + id);
  let tab = 'general';
  const player = h('video', { class: 'player', controls: true, playsInline: true, preload: 'metadata', poster: media(v.poster_key), src: media(v.original_key) });

  const commentsBox = h('div', { class: 'comments' });
  const renderComments = () => {
    const list = v.comments.filter((c) => c.kind === tab);
    const ta = h('textarea', { rows: 3, placeholder: t(tab === 'coach' ? 'c_placeholder_coach' : 'c_placeholder_general') });
    const mark = h('input', { type: 'checkbox', checked: tab === 'coach' });
    commentsBox.replaceChildren(
      h('div', { class: 'tabs' }, ['general', 'coach'].map((k) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; renderComments(); } },
        t(k === 'coach' ? 'c_coach' : 'c_general'), ` (${v.comments.filter((c) => c.kind === k).length})`))),
      list.length ? h('ul', { class: 'clist' }, list.map((c) => h('li', { class: 'c ' + c.kind },
        h('div', { class: 'chead' }, h('strong', {}, c.author_name || c.author_email), c.author_role === 'coach' ? h('span', { class: 'chip on' }, 'coach') : null,
          c.at_seconds != null ? h('button', { class: 'ts', onclick: () => { player.currentTime = c.at_seconds; player.play(); } }, '▶ ' + fmtSec(c.at_seconds)) : null,
          h('span', { class: 'muted small' }, fmtDate(c.created_at.replace(' ', 'T') + 'Z')),
          (c.author_email === S.me.email || S.me.role === 'admin') ? h('button', { class: 'link small', onclick: async () => { await api('comments/' + c.id, { method: 'DELETE' }); v.comments = v.comments.filter((x) => x.id !== c.id); renderComments(); } }, t('delete')) : null),
        h('p', {}, c.body)))) : h('p', { class: 'muted' }, t('no_comments')),
      h('form', { class: 'cform', onsubmit: async (e) => {
        e.preventDefault();
        const body = ta.value.trim(); if (!body) return;
        const at = mark.checked ? Math.round(player.currentTime * 10) / 10 : null;
        const { id: cid } = await api(`videos/${v.id}/comments`, { method: 'POST', body: { body, kind: tab, at_seconds: at } });
        v.comments.push({ id: cid, video_id: v.id, author_email: S.me.email, author_name: S.me.name, author_role: S.me.role, kind: tab, body, at_seconds: at, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
        renderComments();
      } }, ta, h('div', { class: 'crow' }, h('label', { class: 'small' }, mark, ' ', t('c_at_time')), h('button', { class: 'btn' }, t('send')))));
  };
  renderComments();

  const side = h('aside', { class: 'side card' });
  const renderSide = () => side.replaceChildren(
    h('h1', {}, v.title || surferName(v)),
    h('div', { class: 'kv' }, h('span', {}, t('surfer')), h('b', {}, surferName(v))),
    h('div', { class: 'kv' }, h('span', {}, t('date')), h('b', {}, fmtDate(v.recorded_at))),
    h('div', { class: 'kv' }, h('span', {}, t('spot')), h('b', {}, v.spot_name || '–')),
    h('div', { class: 'kv' }, h('span', {}, t('board')), h('b', {}, v.board_name || '–')),
    h('div', { class: 'kv' }, h('span', {}, t('source')), h('b', {}, t('src_' + (v.source || 'unknown')))),
    h('div', { class: 'kv' }, h('span', {}, t('wave')), h('b', { class: 'stars' }, stars(v.wave_rating))),
    h('div', { class: 'kv' }, h('span', {}, t('surf')), h('b', { class: 'stars' }, stars(v.surf_rating))),
    v.subject_ratio != null ? h('div', { class: 'kv' }, h('span', {}, t('up_size_ratio')), h('b', {}, Math.round(v.subject_ratio * 100) + '%')) : null,
    (v.flags || []).length ? h('div', { class: 'flags-help' }, flagChips(v.flags, true)) : null,
    v.notes ? h('p', { class: 'notes' }, v.notes) : null,
    h('h3', {}, t('conditions')), conditionsPanel(v.conditions),
    v.can_edit ? h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: () => editForm() }, t('edit')),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm(t('confirm_delete'))) return; await api('videos/' + v.id, { method: 'DELETE' }); S.videos = null; location.hash = '#/'; } }, t('delete'))) : null);

  const editForm = () => {
    const f = metaFields({ ...v });
    side.replaceChildren(h('h3', {}, t('edit')), f.el,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { await api('videos/' + v.id, { method: 'PATCH', body: f.values() }); S.videos = null; viewDetail(v.id); } }, t('save')),
        h('button', { class: 'btn ghost', onclick: renderSide }, t('cancel'))));
  };
  renderSide();

  root.replaceChildren(nav(''), h('main', { class: 'wrap detail' },
    h('a', { href: '#/', class: 'back' }, '← ', t('back')),
    h('div', { class: 'dgrid' }, h('div', {}, player, h('h3', {}, t('comments')), commentsBox), side)));
}

// ---------------- campos de metadatos (subida y edición) ----------------
function ratingInput(value, onChange) {
  const box = h('div', { class: 'rating' });
  const draw = () => box.replaceChildren(...[0, 1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: value === n ? 'on' : '', onclick: () => { value = n; onChange(n); draw(); } }, String(n))));
  draw();
  return box;
}

function metaFields(init = {}) {
  const val = { surfer_email: init.surfer_email ?? S.me.email, surfer_name: init.surfer_name ?? '', recorded_at: init.recorded_at ?? '', spot_id: init.spot_id ?? 'praia-do-amor',
    board_id: init.board_id ?? '', source: init.source ?? 'unknown', wave_rating: init.wave_rating ?? null, surf_rating: init.surf_rating ?? null, title: init.title ?? '', notes: init.notes ?? '' };
  const listeners = [];
  const changed = () => listeners.forEach((f) => f(val));

  const otherName = h('input', { type: 'text', placeholder: t('up_other_name'), value: val.surfer_name, oninput: (e) => (val.surfer_name = e.target.value) });
  const surferSel = h('select', { onchange: (e) => { val.surfer_email = e.target.value; otherName.hidden = !!val.surfer_email; drawBoards(); } },
    S.members.map((m) => h('option', { value: m.email, selected: val.surfer_email === m.email }, m.name)), h('option', { value: '', selected: !val.surfer_email }, t('up_other_surfer')));
  otherName.hidden = !!val.surfer_email;

  const boardSel = h('select', { onchange: async (e) => {
    if (e.target.value === '__new') {
      const name = prompt(t('up_board_name'));
      if (name) { const b = await api('boards', { method: 'POST', body: { name, owner_email: val.surfer_email || S.me.email } }); S.boards.push(b); val.board_id = b.id; }
      drawBoards();
    } else val.board_id = e.target.value;
  } });
  const drawBoards = () => {
    const owner = val.surfer_email || S.me.email;
    boardSel.replaceChildren(h('option', { value: '' }, t('up_no_board')),
      ...S.boards.filter((b) => b.owner_email === owner).map((b) => h('option', { value: b.id, selected: val.board_id === b.id }, b.name)),
      h('option', { value: '__new' }, t('up_new_board')));
  };
  drawBoards();

  const dateIn = h('input', { type: 'datetime-local', value: val.recorded_at, onchange: (e) => { val.recorded_at = e.target.value.slice(0, 16); changed(); } });
  const spotSel = h('select', { onchange: (e) => { val.spot_id = e.target.value; changed(); } }, S.spots.map((s) => h('option', { value: s.id, selected: val.spot_id === s.id }, s.name)));
  const srcSel = h('select', { onchange: (e) => (val.source = e.target.value) }, ['camera', 'phone', 'unknown'].map((s) => h('option', { value: s, selected: val.source === s }, t('src_' + s))));
  const field = (label, ...el) => h('label', { class: 'field' }, h('span', {}, label), ...el);

  const el = h('div', { class: 'fields' },
    field(t('surfer'), surferSel, otherName),
    field(t('date'), dateIn, h('small', { class: 'muted datehint' })),
    field(t('spot'), spotSel),
    field(t('board'), boardSel),
    field(t('source'), srcSel),
    field(t('rating_help_wave'), ratingInput(val.wave_rating, (n) => (val.wave_rating = n))),
    field(t('rating_help_surf'), ratingInput(val.surf_rating, (n) => (val.surf_rating = n))),
    field(t('up_title_field'), h('input', { type: 'text', value: val.title, oninput: (e) => (val.title = e.target.value) })),
    field(t('up_notes'), h('textarea', { rows: 3, value: val.notes, oninput: (e) => (val.notes = e.target.value) })));

  return {
    el, onChange: (f) => listeners.push(f),
    set(k, v) { val[k] = v; if (k === 'recorded_at') dateIn.value = v; if (k === 'source') srcSel.value = v; },
    hint(text) { el.querySelector('.datehint').textContent = text; },
    values: () => ({ ...val, surfer_email: val.surfer_email || null, surfer_name: val.surfer_email ? null : val.surfer_name, board_id: val.board_id || null }),
  };
}

// ---------------- vista: subir ----------------
function localIso(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

function viewUpload() {
  const root = $app();
  let file = null, url = null, analysis = null, highlight = 0, meta = {};
  const status = h('div', { class: 'status muted' });
  const flagsBox = h('div', { class: 'flags-help' });
  const condBox = h('div', {});
  const preview = h('video', { class: 'player', controls: true, playsInline: true, muted: true });
  const hlLabel = h('span', { class: 'muted' });
  const form = metaFields();
  const progress = h('progress', { max: 1, value: 0, hidden: true });
  const saveBtn = h('button', { class: 'btn big', disabled: true }, t('up_save'));
  const step2 = h('div', { class: 'step2', hidden: true });

  let condTimer;
  const refreshCond = (val) => {
    clearTimeout(condTimer);
    if (!val.recorded_at || !val.spot_id) { condBox.replaceChildren(h('p', { class: 'muted' }, t('no_conditions'))); return; }
    condTimer = setTimeout(async () => {
      condBox.replaceChildren(h('p', { class: 'muted' }, t('loading')));
      try { condBox.replaceChildren(conditionsPanel(await api(`conditions?spot=${val.spot_id}&at=${val.recorded_at}`))); }
      catch { condBox.replaceChildren(h('p', { class: 'muted' }, '–')); }
    }, 400);
  };
  form.onChange(refreshCond);

  const onFile = async (f) => {
    if (!f) return;
    file = f; if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(f);
    preview.src = url; step2.hidden = false; saveBtn.disabled = true;
    status.textContent = t('up_analyzing');
    const created = await readMp4CreationTime(f).catch(() => null);
    if (created) { form.set('recorded_at', localIso(created)); form.hint(t('up_date_from_file')); }
    else { form.set('recorded_at', ''); form.hint(t('up_date_unknown')); }
    refreshCond(form.values());
    try {
      const v = await loadVideo(url);
      meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight, size_bytes: f.size };
      status.textContent = t('up_detect');
      analysis = await detectSubject(v, (p) => (status.textContent = `${t('up_detect')} ${Math.round(p * 100)}%`));
      highlight = Math.max(0, analysis.bestTime - 1);
      const flags = computeFlags(analysis, { width: meta.width, height: meta.height, size: f.size, duration: meta.duration });
      analysis.flags = flags;
      flagsBox.replaceChildren(...flagChips(flags, true),
        analysis.ratio != null ? h('p', { class: 'small muted' }, `${t('up_size_ratio')}: ${Math.round(analysis.ratio * 100)}%`) : null);
      v.removeAttribute('src'); v.load();
    } catch (e) {
      console.warn(e); analysis = { ratio: null, detected: 0, flags: [] };
      status.textContent = String(e.message || e);
    }
    preview.currentTime = highlight;
    hlLabel.textContent = fmtSec(highlight);
    status.textContent = '';
    saveBtn.disabled = false;
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true; progress.hidden = false; progress.value = 0;
    try {
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
      const body = { ...form.values(), ...meta, subject_ratio: analysis?.ratio ?? null, flags: analysis?.flags || [], highlight_at: highlight };
      const res = await fetch('/api/videos', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ext': ext }, body: JSON.stringify(body) });
      const { id, keys, error } = await res.json(); if (!id) throw new Error(error);
      status.textContent = t('up_preview');
      const pv = await makePreview(url, highlight);
      const previewKey = `videos/${id}/preview.${pv.ext}`;
      await api(`upload/put?key=${encodeURIComponent(previewKey)}`, { method: 'PUT', raw: pv.preview });
      await api(`upload/put?key=${encodeURIComponent(keys.poster)}`, { method: 'PUT', raw: pv.poster });
      status.textContent = t('up_uploading');
      await uploadMultipart(api, keys.original, file, (p) => { progress.value = p; status.textContent = `${t('up_uploading')} ${Math.round(p * 100)}%`; });
      await api('videos/' + id, { method: 'PATCH', body: { status: 'ready', original_key: keys.original, preview_key: previewKey, poster_key: keys.poster } });
      status.textContent = t('up_done');
      S.videos = null;
      location.hash = '#/v/' + id;
    } catch (e) {
      console.error(e); status.textContent = `${t('up_error')}: ${e.message}`; saveBtn.disabled = false;
    }
  };

  root.replaceChildren(nav('nav_upload'), h('main', { class: 'wrap' },
    h('h1', {}, t('up_title')),
    h('label', { class: 'drop card' }, h('input', { type: 'file', accept: 'video/*', onchange: (e) => onFile(e.target.files[0]) }), h('span', {}, t('up_pick'))),
    status,
    h('div', { class: 'upgrid' },
      step2),
  ));
  step2.append(
    h('div', { class: 'upcol' }, preview,
      h('div', { class: 'hl card' }, h('strong', {}, t('up_highlight')), ' ', hlLabel, h('p', { class: 'small muted' }, t('up_highlight_help')),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { highlight = preview.currentTime; hlLabel.textContent = fmtSec(highlight); } }, t('up_use_moment'))),
      flagsBox),
    h('div', { class: 'upcol card' }, form.el, h('h3', {}, t('up_conditions_preview')), condBox, progress, saveBtn));
}

// ---------------- vista: perfil ----------------
function viewProfile() {
  const root = $app();
  const langSel = h('select', { onchange: async (e) => { await api('me', { method: 'PATCH', body: { lang: e.target.value } }); setLang(e.target.value); route(); } },
    [['es', 'Español'], ['en', 'English'], ['pt', 'Português']].map(([k, n]) => h('option', { value: k, selected: getLang() === k }, n)));
  const myBoards = S.boards.filter((b) => b.owner_email === S.me.email);
  const bName = h('input', { type: 'text', placeholder: t('up_board_name') });
  const bDet = h('input', { type: 'text', placeholder: t('details') });

  const alertBox = h('p', { class: 'small muted' });
  const newPw = h('input', { type: 'password', placeholder: t('new_password'), autocomplete: 'new-password' });
  const pwMsg = h('span', { class: 'small muted' });
  const admin = S.me.role === 'admin' ? (() => {
    const un = h('input', { type: 'text', placeholder: t('username'), autocapitalize: 'off' });
    const pw = h('input', { type: 'text', placeholder: t('password') });
    const em = h('input', { type: 'email', placeholder: t('email') });
    const nm = h('input', { type: 'text', placeholder: t('name') });
    const rl = h('select', {}, ['member', 'coach', 'admin'].map((r) => h('option', { value: r }, t('role_' + r))));
    return h('section', { class: 'card' }, h('h3', {}, t('members')),
      h('ul', { class: 'plain' }, S.members.map((m) => h('li', {}, h('strong', {}, m.name), ' ', h('span', { class: 'muted' }, t('role_' + m.role))))),
      h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); try { await api('members', { method: 'POST', body: { username: un.value, password: pw.value, email: em.value, name: nm.value, role: rl.value } }); await boot(); viewProfile(); } catch (x) { alertBox.textContent = x.message; } } },
        un, pw, nm, em, rl, h('button', { class: 'btn' }, t('add_member'))),
      alertBox,
      h('p', { class: 'small muted' }, t('access_note')));
  })() : null;

  root.replaceChildren(nav('nav_profile'), h('main', { class: 'wrap narrow' },
    h('h1', {}, S.me.name), h('p', { class: 'muted' }, '@', S.me.username || S.me.email),
    h('section', { class: 'card' }, h('label', { class: 'field' }, h('span', {}, t('language')), langSel)),
    h('section', { class: 'card' }, h('h3', {}, t('change_password')),
      h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); try { await api('me', { method: 'PATCH', body: { password: newPw.value } }); newPw.value = ''; pwMsg.textContent = t('saved'); } catch (x) { pwMsg.textContent = x.message; } } },
        newPw, h('button', { class: 'btn' }, t('save'))), pwMsg,
      h('p', {}, h('button', { class: 'btn ghost', onclick: async () => { await api('logout', { method: 'POST' }); location.reload(); } }, t('logout')))),
    h('section', { class: 'card' }, h('h3', {}, t('my_boards')),
      h('ul', { class: 'plain' }, myBoards.map((b) => h('li', {}, h('strong', {}, b.name), b.details ? h('span', { class: 'muted' }, ' · ', b.details) : null))),
      h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); if (!bName.value) return; S.boards.push(await api('boards', { method: 'POST', body: { name: bName.value, details: bDet.value } })); viewProfile(); } },
        bName, bDet, h('button', { class: 'btn' }, t('add')))),
    admin));
}

// ---------------- arranque y rutas ----------------
async function boot() {
  const d = await api('me');
  Object.assign(S, { me: d.me, members: d.members, spots: d.spots, boards: d.boards });
  setLang(d.me.lang || 'es');
}

async function route() {
  document.querySelectorAll('video.loop').forEach((v) => io.unobserve(v));
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = /^#\/v\/([a-f0-9]{16})/.exec(hash))) return await viewDetail(m[1]);
    if (hash.startsWith('#/pizarra')) return await viewBoard();
    if (hash.startsWith('#/subir')) return viewUpload();
    if (hash.startsWith('#/perfil')) return viewProfile();
    return await viewTimeline();
  } catch (e) {
    console.error(e);
    $app().replaceChildren(nav(''), h('main', { class: 'wrap' }, h('div', { class: 'card' }, String(e.message || e))));
  }
}

function loginScreen() {
  setLang('es');
  const u = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', required: true });
  const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('p', { class: 'small', style: 'color:var(--coral)' });
  $app().replaceChildren(h('main', { class: 'login' },
    h('form', { class: 'card login-card', onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await api('login', { method: 'POST', body: { username: u.value, password: p.value } }); await boot(); route(); }
      catch { msg.textContent = t('bad_login'); }
    } },
      h('div', { class: 'login-mark' }, '≈'), h('h1', {}, t('login_title')),
      h('label', { class: 'field' }, h('span', {}, t('username')), u),
      h('label', { class: 'field' }, h('span', {}, t('password')), p),
      msg, h('button', { class: 'btn big' }, t('enter')))));
  u.focus();
}

window.addEventListener('hashchange', route);
(async () => {
  try { await boot(); }
  catch (e) {
    if (e.status !== 401) { $app().replaceChildren(h('main', { class: 'wrap narrow' }, h('div', { class: 'card' }, String(e.message)))); return; }
    return loginScreen();
  }
  route();
})();
