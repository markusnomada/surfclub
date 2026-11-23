import { t, setLang, getLang } from './i18n.js';
import { loadVideo, detectSubject, computeFlags, makePreview, uploadMultipart, detectRecordedAt, resizeImage } from './media.js';

// ================= estado y API =================
const S = {
  me: null, members: [], spots: [], favSpots: new Set(), boards: [], myGrants: new Map(), grantsToMe: new Map(),
  videos: null, filters: { surfer: '' }, board: { group: 'session', zoom: 220 },
};
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
Object.assign(S.board, store.get('sc_board', {}));

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

async function boot() {
  const d = await api('me');
  Object.assign(S, {
    me: d.me, members: d.members, spots: d.spots, favSpots: new Set(d.favorite_spots), boards: d.boards,
    myGrants: new Map(d.my_grants.map((g) => [g.friend_email, g])), grantsToMe: new Map(d.grants_to_me.map((g) => [g.owner_email, g])),
  });
  setLang(d.me.lang || 'es');
}

// ================= DOM =================
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); };
const $app = () => document.getElementById('app');

const memberBy = (email) => S.members.find((m) => m.email === email);
const surferName = (v) => v.surfer_member_name || v.surfer_name || memberBy(v.uploader_email)?.name || '';
const LOCALE = () => ({ es: 'es', en: 'en', pt: 'pt-BR' }[getLang()]);
function fmtDate(s, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!s) return '–';
  return new Intl.DateTimeFormat(LOCALE(), opts).format(new Date(s.length === 16 ? s + ':00' : s));
}
function ago(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const s = (d - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(LOCALE(), { numeric: 'auto' });
  for (const [u, n] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  return rtf.format(0, 'minute');
}
const fmtSec = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
const compass = (deg) => (deg == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round((deg % 360) / 45) % 8]);
const arrow = (deg) => (deg == null ? '' : h('span', { class: 'arrow', style: `transform:rotate(${deg + 180}deg)` }, '↑'));
const localIso = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function avatar(person, size = 32) {
  const name = person?.name || person?.author_name || '?';
  const key = person?.avatar_key || person?.author_avatar || person?.surfer_avatar;
  if (key) return h('img', { class: 'avatar', src: media(key), alt: name, style: `width:${size}px;height:${size}px` });
  let hue = 0; for (const c of name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const ini = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return h('span', { class: 'avatar ini', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:hsl(${hue} 45% 42%)`, title: name }, ini);
}

function stars(n, cls = '') {
  return h('span', { class: 'stars ' + cls, title: n == null ? '' : `${n}/5` }, [1, 2, 3, 4, 5].map((i) => h('i', { class: n != null && i <= n ? 'on' : '' }, '★')));
}
function starInput(value, onChange) {
  const box = h('span', { class: 'stars input' });
  const draw = () => box.replaceChildren([1, 2, 3, 4, 5].map((i) => h('button', { type: 'button', class: value != null && i <= value ? 'on' : '', 'aria-label': `${i}/5`,
    onclick: () => { value = value === i ? null : i; onChange(value); draw(); } }, '★')));
  draw();
  return box;
}
const flagChips = (flags, help = false) => (flags || []).map((f) => h('span', { class: `chip flag flag-${f}`, title: t(`flag_${f}_help`) }, t(`flag_${f}`), help ? h('small', {}, t(`flag_${f}_help`)) : null));

// reproduce solo los clips visibles
const io = new IntersectionObserver((entries) => {
  for (const e of entries) { const v = e.target; if (e.isIntersecting) { if (!v.src && v.dataset.src) v.src = v.dataset.src; v.play().catch(() => {}); } else v.pause(); }
}, { rootMargin: '200px' });
function loopVideo(v) {
  const el = h('video', { class: 'loop', loop: true, playsInline: true, preload: 'none', poster: media(v.poster_key) });
  el.muted = true; el.setAttribute('muted', ''); el.setAttribute('playsinline', '');
  el.dataset.src = media(v.preview_key);
  io.observe(el);
  return el;
}

// ================= navegación =================
function nav(active) {
  const link = (hash, key) => h('a', { href: hash, class: active === key ? 'active' : '' }, t(key));
  return h('header', { class: 'top' },
    h('a', { href: '#/', class: 'brand' }, h('span', { class: 'mark' }, '≈'), t('brand')),
    h('nav', {}, link('#/', 'nav_timeline'), link('#/pizarra', 'nav_board'), link('#/subir', 'nav_upload'), link('#/amigos', 'nav_friends')),
    h('a', { href: '#/perfil', class: 'me-link' + (active === 'nav_profile' ? ' active' : ''), title: t('nav_profile') }, avatar(S.me, 30)));
}

// surfistas cuyos videos puedo ver: yo + quienes me dieron acceso; favoritos primero
function visibleSurfers() {
  const others = S.members.filter((m) => m.email !== S.me.email && S.grantsToMe.get(m.email)?.can_view);
  others.sort((a, b) => (S.myGrants.get(b.email)?.favorite || 0) - (S.myGrants.get(a.email)?.favorite || 0) || a.name.localeCompare(b.name));
  return [memberBy(S.me.email) || S.me, ...others];
}
function surferFilter(onChange) {
  return h('div', { class: 'chips' },
    h('button', { class: 'chip' + (!S.filters.surfer ? ' on' : ''), onclick: () => { S.filters.surfer = ''; onChange(); } }, t('all_surfers')),
    visibleSurfers().map((m) => h('button', { class: 'chip person' + (S.filters.surfer === m.email ? ' on' : ''), onclick: () => { S.filters.surfer = m.email; onChange(); } },
      avatar(m, 20), m.email === S.me.email ? t('me') : m.name, S.myGrants.get(m.email)?.favorite ? h('span', { class: 'fav' }, '★') : null)));
}
async function loadVideos(force = false) { if (!S.videos || force) S.videos = await api('videos'); return S.videos; }
const filtered = () => (S.videos || []).filter((v) => !S.filters.surfer || (v.surfer_email || v.uploader_email) === S.filters.surfer);

// ================= línea de tiempo =================
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
  const n = (v.n_general || 0);
  const pi = (v.n_note || 0) + (v.n_rec || 0);
  return h('a', { class: 'vcard', href: `#/v/${v.id}` },
    h('div', { class: 'thumb' }, loopVideo(v), h('div', { class: 'overlay' }, flagChips(v.flags))),
    h('div', { class: 'meta' },
      h('div', { class: 'row1' }, h('span', { class: 'who' }, avatar({ name: surferName(v), avatar_key: v.surfer_avatar }, 22), h('strong', {}, surferName(v))),
        h('span', { class: 'muted' }, fmtDate(v.recorded_at, { timeStyle: 'short' }))),
      h('div', { class: 'row2' }, h('span', {}, t('wave'), ' ', stars(v.wave_rating)), h('span', {}, t('surf'), ' ', stars(v.surf_rating))),
      h('div', { class: 'row3 muted' },
        h('span', {}, [v.board_name, v.conditions?.swell_height != null ? `${v.conditions.swell_height} m · ${v.conditions.swell_period}s` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'counts' },
          v.n_likes ? h('span', { class: v.liked ? 'liked' : '' }, '♥ ', v.n_likes) : null,
          n ? h('span', { title: t('comments') }, '❝ ', n) : null,
          pi ? h('span', { class: 'pi', title: t('notes_title') }, h('i', { class: 'pi-dot' }), pi) : null))));
}

function dayConditions(list) {
  const v0 = list.find((v) => v.conditions && v.conditions.swell_height != null);
  if (!v0) return null;
  const c = v0.conditions;
  return h('details', { class: 'daycond' }, h('summary', { class: 'muted' }, condLine(c), c.wind_state ? ` (${t(WS[c.wind_state])})` : '', ' · ', h('span', { class: 'link' }, t('fc_see_day'))),
    forecastTable(c, (v0.recorded_at || '').slice(11, 16), v0.spot_id));
}

async function viewTimeline() {
  const root = $app(); root.replaceChildren(nav('nav_timeline'), h('main', { class: 'wrap' }, h('p', { class: 'muted' }, t('loading'))));
  await loadVideos();
  const render = () => {
    const vids = filtered();
    const groups = new Map();
    for (const v of vids) { const day = (v.recorded_at || v.created_at).slice(0, 10); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(v); }
    root.replaceChildren(nav('nav_timeline'), h('main', { class: 'wrap' },
      surferFilter(render),
      S.filters.surfer ? evolutionChart(vids) : null,
      vids.length ? h('div', { class: 'timeline' }, [...groups].map(([day, list]) => h('section', { class: 'day' },
        h('div', { class: 'dot' }),
        h('h2', {}, h('span', { class: 'cap' }, fmtDate(day + 'T12:00', { dateStyle: 'full' })), h('span', { class: 'muted' }, ' · ', [...new Set(list.map((v) => v.spot_name).filter(Boolean))].join(', '))),
        dayConditions(list),
        h('div', { class: 'cards' }, list.map(videoCard)))))
        : h('div', { class: 'empty card' }, t('empty'), ' ', h('a', { href: '#/subir' }, t('nav_upload'), ' →'))));
  };
  render();
}

// ================= pizarra =================
async function viewBoard() {
  const root = $app(); root.replaceChildren(nav('nav_board'), h('main', { class: 'wrap wide' }, h('p', { class: 'muted' }, t('loading'))));
  await loadVideos();
  const render = () => {
    const vids = filtered();
    const key = { session: (v) => `${fmtDate((v.recorded_at || '').slice(0, 10) + 'T12:00', { dateStyle: 'medium' })} · ${v.spot_name || ''}`, spot: (v) => v.spot_name || '–', board: (v) => v.board_name || '–', surfer: (v) => surferName(v), none: () => '' }[S.board.group] || (() => '');
    const groups = new Map();
    for (const v of vids) { const k = key(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
    const grid = h('div', { class: 'board', style: `--z:${S.board.zoom}px` }, [...groups].map(([k, list]) => [
      k ? h('h3', { class: 'gh' }, k, h('span', { class: 'muted' }, ` · ${list.length} ${t('videos_n')}`)) : null,
      h('div', { class: 'bgrid' }, list.map((v) => h('a', { class: 'tile', href: `#/v/${v.id}` },
        loopVideo(v),
        h('div', { class: 'tile-meta' }, h('span', { class: 'who' }, avatar({ name: surferName(v), avatar_key: v.surfer_avatar }, 18), surferName(v)), stars(v.surf_rating)),
        (v.flags || []).length ? h('div', { class: 'tile-flags' }, flagChips(v.flags)) : null))),
    ]));
    const zoom = h('input', { type: 'range', min: 120, max: 520, step: 10, value: S.board.zoom, oninput: (e) => { S.board.zoom = +e.target.value; grid.style.setProperty('--z', S.board.zoom + 'px'); store.set('sc_board', S.board); } });
    const grp = h('select', { onchange: (e) => { S.board.group = e.target.value; store.set('sc_board', S.board); render(); } },
      ['session', 'spot', 'board', 'surfer', 'none'].map((g) => h('option', { value: g, selected: S.board.group === g }, t('g_' + g))));
    root.replaceChildren(nav('nav_board'), h('main', { class: 'wrap wide' },
      h('div', { class: 'toolbar' }, surferFilter(render), h('label', {}, t('group_by'), ' ', grp), h('label', {}, t('zoom'), ' ', zoom)),
      vids.length ? grid : h('div', { class: 'empty card' }, t('empty'))));
  };
  render();
}

// ================= condiciones =================
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
  if (!c || (c.swell_height == null && c.wind_speed == null)) return h('p', { class: 'muted small' }, t('no_conditions'));
  const row = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v));
  return h('div', { class: 'cond' },
    row(t('swell'), h('span', {}, `${c.swell_height ?? '–'} m · ${c.swell_period ?? '–'} s `, arrow(c.swell_direction), ` ${compass(c.swell_direction)}`)),
    row(t('waves'), `${c.wave_height ?? '–'} m · ${c.wave_period ?? '–'} s`),
    row(t('wind'), h('span', {}, `${c.wind_speed ?? '–'} km/h (${c.wind_gusts ?? '–'}) `, arrow(c.wind_direction), ` ${compass(c.wind_direction)}`, c.wind_state ? ` · ${t(WS[c.wind_state])}` : '')),
    row(t('tide'), `${c.tide_height ?? '–'} m ${c.tide_trend ? '· ' + t(c.tide_trend) : ''}`),
    c.tide_day_min != null ? h('div', { class: 'muted small' }, `${t('tide_range')}: ${c.tide_day_min} → ${c.tide_day_max} m`) : null,
    tideCurve(c),
    c.sea_temp != null ? row(t('sea_temp'), `${c.sea_temp} °C`) : null,
    h('p', { class: 'muted small' }, t('tide_note')));
}
function condLine(c) {
  if (!c || c.swell_height == null) return '';
  return `${t('swell')} ${c.swell_height} m · ${c.swell_period}s ${compass(c.swell_direction)} — ${t('wind')} ${c.wind_speed ?? '–'} km/h ${compass(c.wind_direction)} — ${t('tide')} ${c.tide_height ?? '–'} m ${c.tide_trend ? t(c.tide_trend) : ''}`;
}

// ================= selectores: pico y tabla =================
function spotPicker(value, onChange) {
  const box = h('div', { class: 'picker' });
  let adding = false;
  const draw = () => {
    const favs = S.spots.filter((s) => S.favSpots.has(s.id));
    const others = S.spots.filter((s) => !S.favSpots.has(s.id));
    const name = h('input', { type: 'text', placeholder: t('spot_name') });
    const coords = h('input', { type: 'text', placeholder: t('spot_coords') });
    const shown = favs.length ? favs : S.spots.slice(0, 4);
    if (value && !shown.some((s) => s.id === value)) { const cur = S.spots.find((s) => s.id === value); if (cur) shown.push(cur); }
    box.replaceChildren(
      h('div', { class: 'chips' },
        shown.map((s) => h('button', { type: 'button', class: 'chip' + (value === s.id ? ' on' : ''), onclick: () => { value = s.id; onChange(value); draw(); } }, S.favSpots.has(s.id) ? h('span', { class: 'fav' }, '★') : null, s.name)),
        others.length ? h('select', { class: 'chip-select', onchange: (e) => { if (e.target.value) { value = e.target.value; onChange(value); draw(); } } },
          h('option', { value: '' }, t('more_spots')), others.map((s) => h('option', { value: s.id }, s.name))) : null,
        h('button', { type: 'button', class: 'chip add', onclick: () => { adding = !adding; draw(); } }, '+ ', t('new_spot'))),
      adding ? h('div', { class: 'inline-add' }, name, coords, h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!name.value.trim()) return;
        const [lat, lon] = coords.value.split(',').map((x) => parseFloat(x));
        const s = await api('spots', { method: 'POST', body: { name: name.value, lat, lon } });
        S.spots.push(s); S.favSpots.add(s.id); value = s.id; adding = false; onChange(value); draw();
      } }, t('add')), h('small', { class: 'muted' }, t('spot_coords_help'))) : null);
  };
  draw();
  return box;
}

function boardPicker(getOwner, value, onChange) {
  const box = h('div', { class: 'picker' });
  let adding = false;
  const draw = () => {
    const mine = S.boards.filter((b) => b.owner_email === getOwner());
    if (value && !mine.some((b) => b.id === value)) { value = ''; onChange(null); }
    const name = h('input', { type: 'text', placeholder: t('board_name') });
    box.replaceChildren(
      h('div', { class: 'chips' },
        h('button', { type: 'button', class: 'chip' + (!value ? ' on' : ''), onclick: () => { value = ''; onChange(null); draw(); } }, t('no_board')),
        mine.map((b) => h('button', { type: 'button', class: 'chip board-chip' + (value === b.id ? ' on' : ''), onclick: () => { value = b.id; onChange(b.id); draw(); } },
          b.photo_key ? h('img', { src: media(b.photo_key), alt: '' }) : null, b.name)),
        h('button', { type: 'button', class: 'chip add', onclick: () => { adding = !adding; draw(); } }, '+ ', t('new_board'))),
      adding ? h('div', { class: 'inline-add' }, name, h('button', { type: 'button', class: 'btn small', onclick: async () => {
        if (!name.value.trim()) return;
        const b = await api('boards', { method: 'POST', body: { name: name.value, owner_email: getOwner() } });
        S.boards.push(b); value = b.id; adding = false; onChange(b.id); draw();
      } }, t('add'))) : null);
  };
  box.redraw = draw;
  draw();
  return box;
}
function defaultSpot() {
  const last = store.get('sc_last_spot', null);
  if (last && S.spots.some((s) => s.id === last)) return last;
  return [...S.favSpots][0] || S.spots[0]?.id || null;
}

// ================= forecast del día (tabla tipo surf forecast) =================
const WS = { onshore: 'ws_on', 'cross-on': 'ws_crosson', cross: 'ws_cross', 'cross-off': 'ws_crossoff', offshore: 'ws_off' };
const windBg = (k) => (k == null ? 'transparent' : k < 10 ? '#cfeed6' : k < 20 ? '#e8f2b0' : k < 30 ? '#f7dc95' : k < 40 ? '#f4b385' : '#ec8f80');
const waveBg = (m) => (m == null ? 'transparent' : `rgba(42,127,140,${Math.min(0.85, 0.12 + m * 0.32).toFixed(2)})`);
const isPipa = (spotId) => { const s = S.spots.find((x) => x.id === spotId); return s && Math.abs(s.lat + 6.22) < 0.15 && Math.abs(s.lon + 35.04) < 0.15; };

function forecastTable(c, atTime, spotId) {
  if (!c?.day?.length) return h('p', { class: 'muted small' }, t('no_conditions'));
  const hh = atTime ? parseInt(atTime.slice(0, 2), 10) + parseInt(atTime.slice(3, 5), 10) / 60 : null;
  const hi = hh == null ? -1 : Math.min(7, Math.floor(hh / 3)); // franja de 3 h que contiene la hora
  const td = (i, ...k) => h('td', { class: i === hi ? 'now' : '' }, ...k);
  const curve = c.tide_curve?.length ? (() => {
    const vals = c.tide_curve.map(([, v]) => v).filter((v) => v != null);
    const lo = Math.min(...vals), hi2 = Math.max(...vals), W = 800, H = 46;
    const d = c.tide_curve.map(([, v], i) => `${i ? 'L' : 'M'}${((i + 0.5) / 24 * W).toFixed(1)},${(H - 4 - ((v ?? lo) - lo) / Math.max(0.01, hi2 - lo) * (H - 8)).toFixed(1)}`).join(' ');
    const x = hh == null ? null : ((hh + 0.5) / 24) * W;
    return h('div', { html: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="fc-tide"><path d="${d} L${W},${H} L0,${H} Z" class="area"/><path d="${d}" class="line"/>${x != null ? `<line x1="${x}" x2="${x}" y1="0" y2="${H}"/>` : ''}</svg>` });
  })() : null;
  return h('div', { class: 'fc' },
    h('div', { class: 'fc-scroll' }, h('table', { class: 'fc-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), c.day.map((d, i) => h('th', { class: i === hi ? 'now' : '' }, `${String(d.h).padStart(2, '0')}h`)))),
      h('tbody', {},
        h('tr', {}, h('th', {}, t('waves'), h('small', {}, 'm')), c.day.map((d, i) => td(i, h('span', { class: 'cell', style: `background:${waveBg(d.wave)};color:${d.wave > 1.2 ? '#fff' : 'inherit'}` }, d.wave != null ? d.wave.toFixed(1) : '–')))),
        h('tr', {}, h('th', {}, t('swell'), h('small', {}, 'm · s')), c.day.map((d, i) => td(i, h('div', { class: 'stack' }, arrow(d.swell_dir), h('b', {}, d.swell != null ? d.swell.toFixed(1) : '–'), h('small', {}, d.period != null ? d.period + 's' : ''))))),
        h('tr', {}, h('th', {}, t('wind'), h('small', {}, 'km/h')), c.day.map((d, i) => td(i, h('span', { class: 'cell', style: `background:${windBg(d.wind)}` }, arrow(d.wind_dir), ' ', d.wind ?? '–')))),
        h('tr', {}, h('th', {}, t('wind_state')), c.day.map((d, i) => td(i, h('small', { class: 'ws ws-' + (d.wind_state || '') }, d.wind_state ? t(WS[d.wind_state]) : '–')))),
        h('tr', {}, h('th', {}, t('tide'), h('small', {}, 'm')), h('td', { colspan: 8, class: 'tide-cell' }, curve))))),
    h('p', { class: 'fc-source' }, t('fc_source'), ' ',
      isPipa(spotId) ? h('a', { href: 'https://www.surf-forecast.com/breaks/Praia-de-Pipa/forecasts/latest', target: '_blank', rel: 'noopener' }, t('fc_compare'), ' ↗') : null));
}

// ================= subir: una sesión = un día =================
function viewUpload() {
  const root = $app();
  const shared = { surfer_email: S.me.email, surfer_name: '', spot_id: defaultSpot(), board_id: store.get('sc_last_board', null), date: '', time: '' };
  const items = [];
  const list = h('div', { class: 'queue' });
  const status = h('div', { class: 'status muted' });
  const uploadBtn = h('button', { class: 'btn big', disabled: true }, t('up_save'));
  const fcBox = h('div', { class: 'session-fc' });
  const dateWarn = h('p', { class: 'small date-warn', hidden: true });
  let busy = false, userSetDate = false;

  const dateIn = h('input', { type: 'date', max: localIso(new Date()).slice(0, 10), onchange: (e) => { shared.date = e.target.value; userSetDate = true; changed(); } });
  const timeIn = h('input', { type: 'time', step: 900, onchange: (e) => { shared.time = e.target.value; changed(); } });
  const otherName = h('input', { type: 'text', placeholder: t('up_other_name'), hidden: true, oninput: (e) => (shared.surfer_name = e.target.value) });
  const boardBox = boardPicker(() => shared.surfer_email || S.me.email, shared.board_id, (id) => { shared.board_id = id; });
  const surferSel = h('select', { onchange: (e) => { shared.surfer_email = e.target.value; otherName.hidden = !!shared.surfer_email; boardBox.redraw(); } },
    S.members.map((m) => h('option', { value: m.email, selected: m.email === S.me.email }, m.email === S.me.email ? `${m.name} (${t('me')})` : m.name)),
    h('option', { value: '' }, t('up_other_surfer')));
  const spotBox = spotPicker(shared.spot_id, (id) => { shared.spot_id = id; changed(); });

  // hora de cada video: la del archivo si es confiable y del mismo día; si no, la de la sesión
  const videoTime = (it) => (it.fileTime && it.fileDate === shared.date ? it.fileTime : shared.time || '');
  const recordedAt = (it) => (shared.date && videoTime(it) ? `${shared.date}T${videoTime(it)}` : null);

  let fcKey = '';
  async function changed() {
    items.forEach((it) => it.draw());
    refreshBtn();
    const at = shared.date && shared.time ? `${shared.date}T${shared.time}` : null;
    if (!at || !shared.spot_id) { fcBox.replaceChildren(h('p', { class: 'muted small' }, t('fc_need_date'))); return; }
    const key = shared.spot_id + at; if (key === fcKey) return; fcKey = key;
    fcBox.replaceChildren(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' ', t('fc_loading')));
    try { const c = await api(`conditions?spot=${shared.spot_id}&at=${at}`); if (fcKey === key) fcBox.replaceChildren(h('h3', {}, t('fc_title')), forecastTable(c, shared.time, shared.spot_id)); }
    catch { fcBox.replaceChildren(h('p', { class: 'muted small' }, '–')); }
  }

  // propone el día y la hora de la sesión a partir de los archivos confiables
  function suggestSession() {
    const reliable = items.filter((i) => i.fileDate);
    const days = [...new Set(reliable.map((i) => i.fileDate))];
    if (!userSetDate && days.length) {
      shared.date = days.sort()[0]; dateIn.value = shared.date;
      const first = reliable.filter((i) => i.fileDate === shared.date).map((i) => i.fileTime).sort()[0];
      if (first && !shared.time) { shared.time = first; timeIn.value = first; }
    }
    const unreliable = items.filter((i) => i.dateChecked && !i.fileDate);
    dateWarn.hidden = !(days.length > 1 || unreliable.length);
    dateWarn.textContent = days.length > 1 ? t('date_multi_days') : unreliable.length ? t('date_no_meta') : '';
    changed();
  }

  const refreshBtn = () => {
    const pending = items.filter((i) => i.status === 'ready' || i.status === 'error');
    const missing = !shared.date || !shared.time;
    uploadBtn.disabled = busy || !pending.length || items.some((i) => i.status === 'analyzing') || missing;
    uploadBtn.textContent = missing && items.length ? t('up_need_date') : pending.length > 1 ? t('up_save_n').replace('{n}', pending.length) : t('up_save');
    uploadBtn.hidden = !items.length;
  };

  function card(it) {
    const el = h('article', { class: 'qcard card' });
    const player = h('video', { class: 'qplayer', src: it.url, controls: true, playsInline: true, preload: 'metadata' });
    player.muted = true;
    it.player = player;
    const noteBox = h('textarea', { rows: 2, placeholder: t('note_placeholder'), hidden: true, oninput: (e) => (it.note = e.target.value) });
    let noteOpen = false;
    const removeBtn = h('button', { class: 'icon-btn', title: t('remove'), onclick: () => { items.splice(items.indexOf(it), 1); el.remove(); URL.revokeObjectURL(it.url); suggestSession(); } }, '✕');
    const timeLine = h('p', { class: 'small qtime' });
    const dynamic = h('div', { class: 'qdyn' });
    it.draw = () => {
      if (!it.dateChecked) timeLine.replaceChildren(h('span', { class: 'spinner' }), ' ', t('reading_date'));
      else {
        const tm = videoTime(it);
        const src = it.fileTime && it.fileDate === shared.date ? t('time_from_file') : t('time_from_session');
        timeLine.replaceChildren(h('b', {}, tm || '–:–'), ' ', h('span', { class: 'muted' }, src),
          it.fileDate && shared.date && it.fileDate !== shared.date ? h('span', { class: 'err' }, ' · ', t('date_other_day').replace('{d}', fmtDate(it.fileDate + 'T12:00', { dateStyle: 'medium' }))) : null);
      }
      dynamic.replaceChildren(
        it.status === 'analyzing' ? h('p', { class: 'small muted' }, h('span', { class: 'spinner' }), ' ', it.progressText || t('up_analyzing')) : h('div', { class: 'qflags' }, flagChips(it.flags)),
        h('div', { class: 'qactions' },
          h('button', { type: 'button', class: 'link-btn', onclick: () => { noteOpen = !noteOpen; noteBox.hidden = !noteOpen; it.draw(); if (noteOpen) noteBox.focus(); } }, noteOpen ? t('hide_note') : '+ ' + t('add_note')),
          h('button', { type: 'button', class: 'link-btn', title: t('up_highlight_help'), onclick: () => { it.highlight = player.currentTime; it.draw(); } }, '⟲ ', t('loop_here'), ` (${fmtSec(it.highlight || 0)})`)),
        it.status === 'uploading' ? h('progress', { max: 1, value: it.progress || 0 }) : null,
        it.status === 'done' ? h('p', { class: 'ok small' }, '✓ ', t('up_done_one')) : null,
        it.status === 'error' ? h('p', { class: 'err small' }, t('up_error'), ': ', it.error) : null);
      removeBtn.hidden = it.status === 'uploading' || it.status === 'done';
    };
    el.append(player, h('div', { class: 'qbody' },
      h('div', { class: 'qhead' }, h('strong', { class: 'fname', title: it.file.name }, it.file.name), removeBtn),
      timeLine,
      h('div', { class: 'rate-row' },
        h('div', { class: 'field' }, h('span', {}, t('rating_wave')), starInput(it.wave_rating, (n) => (it.wave_rating = n))),
        h('div', { class: 'field' }, h('span', {}, t('rating_surf')), starInput(it.surf_rating, (n) => (it.surf_rating = n)))),
      dynamic, noteBox));
    it.draw();
    return el;
  }

  // 1) fecha de todos los archivos de inmediato; 2) detección del surfista de a uno
  let analyzing = Promise.resolve();
  function addFiles(files) {
    const added = [];
    for (const file of files) {
      if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) continue;
      const it = { file, url: URL.createObjectURL(file), status: 'analyzing', wave_rating: null, surf_rating: null, note: '', flags: [], highlight: 0 };
      items.push(it); added.push(it);
      list.append(card(it));
    }
    refreshBtn();
    Promise.all(added.map(async (it) => {
      const d = await detectRecordedAt(it.file).catch(() => null);
      // solo se confía en la fecha del propio archivo o de nombres de cámara/celular; WhatsApp y "modificado" no sirven
      if (d && (d.source === 'meta' || d.source === 'name')) { const iso = localIso(d.date); it.fileDate = iso.slice(0, 10); it.fileTime = iso.slice(11, 16); }
      it.dateChecked = true; it.draw();
    })).then(suggestSession);
    for (const it of added) analyzing = analyzing.then(() => analyze(it));
  }
  async function analyze(it) {
    if (!items.includes(it)) return;
    try {
      const v = await loadVideo(it.url);
      it.meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight, size_bytes: it.file.size };
      const a = await detectSubject(v, (p) => { it.progressText = `${t('up_detect')} ${Math.round(p * 100)}%`; it.draw(); });
      it.ratio = a.ratio;
      it.highlight = Math.max(0, a.bestTime - 1);
      it.flags = computeFlags(a, { width: it.meta.width, height: it.meta.height, size: it.file.size, duration: it.meta.duration });
      v.removeAttribute('src'); v.load();
    } catch (e) { console.warn(e); }
    if (it.player) it.player.currentTime = it.highlight;
    it.status = 'ready'; it.draw(); refreshBtn();
  }

  async function uploadOne(it) {
    it.status = 'uploading'; it.progress = 0; it.draw();
    const ext = (it.file.name.split('.').pop() || 'mp4').toLowerCase();
    const body = { surfer_email: shared.surfer_email || null, surfer_name: shared.surfer_email ? null : shared.surfer_name, spot_id: shared.spot_id, board_id: shared.board_id || null,
      recorded_at: recordedAt(it), wave_rating: it.wave_rating, surf_rating: it.surf_rating, note: it.note,
      ...(it.meta || {}), subject_ratio: it.ratio ?? null, flags: it.flags, highlight_at: it.highlight };
    const res = await fetch('/api/videos', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ext': ext }, body: JSON.stringify(body) });
    const { id, keys, error } = await res.json(); if (!id) throw new Error(error || res.status);
    const pv = await makePreview(it.url, it.highlight);
    const previewKey = `videos/${id}/preview.${pv.ext}`;
    await api(`upload/put?key=${encodeURIComponent(previewKey)}`, { method: 'PUT', raw: pv.preview });
    await api(`upload/put?key=${encodeURIComponent(keys.poster)}`, { method: 'PUT', raw: pv.poster });
    await uploadMultipart(api, keys.original, it.file, (p) => { it.progress = p; it.draw(); });
    await api('videos/' + id, { method: 'PATCH', body: { status: 'ready', original_key: keys.original, preview_key: previewKey, poster_key: keys.poster } });
    it.status = 'done'; it.draw();
  }

  uploadBtn.onclick = async () => {
    busy = true; refreshBtn();
    store.set('sc_last_spot', shared.spot_id); store.set('sc_last_board', shared.board_id);
    const todo = items.filter((i) => i.status === 'ready' || i.status === 'error');
    for (const [k, it] of todo.entries()) {
      status.textContent = `${t('up_uploading')} ${k + 1}/${todo.length}…`;
      try { await uploadOne(it); } catch (e) { console.error(e); it.status = 'error'; it.error = e.message; it.draw(); }
    }
    busy = false; S.videos = null;
    const allDone = items.every((i) => i.status === 'done');
    status.textContent = allDone ? t('up_done') : '';
    refreshBtn();
    if (allDone) setTimeout(() => (location.hash = '#/'), 900);
  };

  const fileIn = h('input', { type: 'file', accept: 'video/*,.mov,.mp4', multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); } },
    h('div', { class: 'drop-icon' }, '⇪'), h('strong', {}, t('drop_title')), h('span', { class: 'muted small' }, t('drop_help')), fileIn);
  root.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  root.ondragleave = (e) => { if (!e.relatedTarget || !root.contains(e.relatedTarget)) drop.classList.remove('over'); };
  root.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };

  refreshBtn(); changed();
  root.replaceChildren(nav('nav_upload'), h('main', { class: 'wrap' },
    h('h1', {}, t('up_title')),
    h('section', { class: 'card shared' },
      h('h3', { class: 'step' }, h('span', { class: 'num' }, '1'), t('session_title')),
      h('div', { class: 'session-row' },
        h('label', { class: 'field' }, h('span', {}, t('session_day')), dateIn),
        h('label', { class: 'field' }, h('span', {}, t('session_time')), timeIn),
        h('label', { class: 'field' }, h('span', {}, t('surfer')), surferSel, otherName)),
      dateWarn,
      h('div', { class: 'field' }, h('span', {}, t('spot')), spotBox),
      h('div', { class: 'field' }, h('span', {}, t('board')), boardBox),
      fcBox),
    h('h3', { class: 'step' }, h('span', { class: 'num' }, '2'), t('videos_step')),
    drop, list, status, uploadBtn));
}

// ================= detalle =================
let seekPlayer = () => {};
function postit(c, canDelete, onDelete) {
  const rot = ((c.id.charCodeAt(0) + c.id.charCodeAt(1)) % 5) - 2;
  return h('div', { class: `postit ${c.kind}`, style: `--r:${rot * 0.6}deg` },
    c.kind === 'rec' ? h('div', { class: 'pi-head' }, avatar(c, 26), h('div', {}, h('strong', {}, c.author_name), h('small', {}, t('recommendation')))) : null,
    h('p', {}, c.body),
    h('div', { class: 'pi-foot' },
      c.at_seconds != null ? h('button', { class: 'ts', onclick: () => seekPlayer(c.at_seconds) }, '▶ ', fmtSec(c.at_seconds)) : h('span'),
      canDelete ? h('button', { class: 'icon-btn', title: t('delete'), onclick: onDelete }, '✕') : null));
}

async function viewDetail(id) {
  const root = $app(); root.replaceChildren(nav(''), h('main', { class: 'wrap' }, h('p', { class: 'muted' }, t('loading'))));
  let v;
  try { v = await api('videos/' + id); }
  catch (e) { root.replaceChildren(nav(''), h('main', { class: 'wrap' }, h('div', { class: 'card' }, e.status === 403 ? t('no_access') : t('not_found')))); return; }
  const player = h('video', { class: 'player', controls: true, playsInline: true, preload: 'metadata', poster: media(v.poster_key), src: media(v.original_key) });
  seekPlayer = (s) => { player.currentTime = s; player.play(); };
  const canDel = (c) => c.author_email === S.me.email || v.can_edit;

  const delComment = (c) => async () => { await api('comments/' + c.id, { method: 'DELETE' }); v.comments = v.comments.filter((x) => x.id !== c.id); S.videos = null; renderAll(); };
  const addComment = async (kind, body, at) => {
    const { id: cid } = await api(`videos/${v.id}/comments`, { method: 'POST', body: { body, kind, at_seconds: at } });
    v.comments.push({ id: cid, video_id: v.id, author_email: S.me.email, author_name: S.me.name, author_avatar: S.me.avatar_key, kind, body, at_seconds: at, created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    S.videos = null; renderAll();
  };

  // --- post-its: notas propias (amarillas) y recomendaciones (verdes, con foto de quien recomienda) ---
  const boardEl = h('section', { class: 'postits-wrap' });
  let composer = null; // 'note' | 'rec'
  const renderPostits = () => {
    const notes = v.comments.filter((c) => c.kind === 'note' || c.kind === 'rec');
    const ta = h('textarea', { rows: 3, placeholder: t(composer === 'rec' ? 'rec_placeholder' : 'note_placeholder') });
    const mark = h('input', { type: 'checkbox', checked: player.currentTime > 0.5 });
    boardEl.replaceChildren(
      h('div', { class: 'sec-head' }, h('h3', {}, t('notes_title')),
        h('div', { class: 'sec-actions' },
          v.can_edit ? h('button', { class: 'chip note-btn', onclick: () => { composer = 'note'; renderPostits(); } }, '+ ', t('add_note')) : null,
          v.can_interact && !v.can_edit ? h('button', { class: 'chip rec-btn', onclick: () => { composer = 'rec'; renderPostits(); } }, '+ ', t('recommend')) : null)),
      h('div', { class: 'postits' },
        v.notes ? h('div', { class: 'postit note', style: '--r:-1deg' }, h('p', {}, v.notes)) : null,
        notes.map((c) => postit(c, canDel(c), delComment(c))),
        composer ? h('form', { class: `postit ${composer} composing`, onsubmit: async (e) => {
          e.preventDefault(); const body = ta.value.trim(); if (!body) return;
          const kind = composer; composer = null;
          await addComment(kind, body, mark.checked ? Math.round(player.currentTime * 10) / 10 : null);
        } }, ta, h('label', { class: 'small' }, mark, ' ', t('at_second'), ' ', fmtSec(player.currentTime)),
          h('div', { class: 'pi-foot' }, h('button', { type: 'button', class: 'link-btn', onclick: () => { composer = null; renderPostits(); } }, t('cancel')), h('button', { class: 'btn small' }, t('save')))) : null,
        !notes.length && !composer && !v.notes ? h('p', { class: 'muted small' }, t('no_notes')) : null));
    if (composer) ta.focus();
  };

  // --- likes ---
  const likeBox = h('div', { class: 'likes' });
  const renderLikes = () => likeBox.replaceChildren(
    h('button', { class: 'like-btn' + (v.liked ? ' on' : ''), disabled: !v.can_interact, title: t('like'), onclick: async () => {
      const r = await api(`videos/${v.id}/like`, { method: 'POST' });
      v.liked = r.liked; v.n_likes = r.n_likes;
      v.likers = r.liked ? [...v.likers, { name: S.me.name, avatar_key: S.me.avatar_key }] : v.likers.filter((l) => l.name !== S.me.name);
      S.videos = null; renderLikes();
    } }, '♥'),
    h('span', { class: 'like-faces' }, v.likers.slice(0, 6).map((l) => avatar(l, 22))),
    h('span', { class: 'muted small' }, v.n_likes ? `${v.n_likes} ${t(v.n_likes === 1 ? 'like_one' : 'like_many')}` : t('no_likes')));

  // --- comentarios estilo red social ---
  const commentsEl = h('section', { class: 'comments' });
  const renderComments = () => {
    const list = v.comments.filter((c) => c.kind === 'general');
    const ta = h('textarea', { rows: 1, placeholder: t('comment_placeholder'), oninput: (e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; } });
    commentsEl.replaceChildren(
      h('h3', {}, t('comments'), list.length ? ` (${list.length})` : ''),
      h('ul', { class: 'feed' }, list.map((c) => h('li', {},
        avatar(c, 34),
        h('div', { class: 'bubble' },
          h('div', { class: 'chead' }, h('strong', {}, c.author_name), h('span', { class: 'muted small' }, ago(c.created_at)),
            c.at_seconds != null ? h('button', { class: 'ts', onclick: () => seekPlayer(c.at_seconds) }, '▶ ', fmtSec(c.at_seconds)) : null),
          h('p', {}, c.body)),
        canDel(c) ? h('button', { class: 'icon-btn', title: t('delete'), onclick: delComment(c) }, '✕') : null))),
      !list.length ? h('p', { class: 'muted small' }, t('no_comments')) : null,
      v.can_interact ? h('form', { class: 'composer', onsubmit: async (e) => { e.preventDefault(); const b = ta.value.trim(); if (b) await addComment('general', b, null); } },
        avatar(S.me, 34), ta, h('button', { class: 'btn small' }, t('send'))) : null);
  };

  // --- panel lateral ---
  const side = h('aside', { class: 'side card' });
  const renderSide = () => side.replaceChildren(
    h('div', { class: 'surfer-head' }, avatar({ name: surferName(v), avatar_key: v.surfer_avatar }, 44), h('div', {}, h('h1', {}, surferName(v)), h('span', { class: 'muted' }, fmtDate(v.recorded_at)))),
    h('div', { class: 'kv' }, h('span', {}, t('spot')), h('b', {}, v.spot_name || '–')),
    h('div', { class: 'kv' }, h('span', {}, t('board')), h('b', { class: 'board-val' }, v.board_photo ? h('img', { src: media(v.board_photo), alt: '' }) : null, v.board_name || t('no_board'))),
    h('div', { class: 'kv' }, h('span', {}, t('wave')), stars(v.wave_rating, 'big')),
    h('div', { class: 'kv' }, h('span', {}, t('surf')), stars(v.surf_rating, 'big')),
    (v.flags || []).length ? h('div', { class: 'flags-help' }, flagChips(v.flags, true)) : null,
    h('h3', {}, t('conditions')), conditionsPanel(v.conditions),
    v.can_edit ? h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', onclick: editForm }, t('edit')),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm(t('confirm_delete'))) return; await api('videos/' + v.id, { method: 'DELETE' }); S.videos = null; location.hash = '#/'; } }, t('delete'))) : null);

  function editForm() {
    const val = { recorded_at: v.recorded_at, spot_id: v.spot_id, board_id: v.board_id, wave_rating: v.wave_rating, surf_rating: v.surf_rating };
    side.replaceChildren(h('h3', {}, t('edit')),
      h('label', { class: 'field' }, h('span', {}, t('date')), h('input', { type: 'datetime-local', value: val.recorded_at || '', onchange: (e) => (val.recorded_at = e.target.value.slice(0, 16)) })),
      h('div', { class: 'field' }, h('span', {}, t('spot')), spotPicker(val.spot_id, (sid) => (val.spot_id = sid))),
      h('div', { class: 'field' }, h('span', {}, t('board')), boardPicker(() => v.surfer_email || v.uploader_email, val.board_id, (bid) => (val.board_id = bid))),
      h('div', { class: 'field' }, h('span', {}, t('rating_wave')), starInput(val.wave_rating, (n) => (val.wave_rating = n))),
      h('div', { class: 'field' }, h('span', {}, t('rating_surf')), starInput(val.surf_rating, (n) => (val.surf_rating = n))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => { await api('videos/' + v.id, { method: 'PATCH', body: val }); S.videos = null; viewDetail(v.id); } }, t('save')),
        h('button', { class: 'btn ghost', onclick: renderSide }, t('cancel'))));
  }

  const renderAll = () => { renderPostits(); renderComments(); renderLikes(); };
  renderAll(); renderSide();
  root.replaceChildren(nav(''), h('main', { class: 'wrap detail' },
    h('a', { href: '#/', class: 'back' }, '← ', t('back')),
    h('div', { class: 'dgrid' }, h('div', {}, player, likeBox,
      v.conditions?.day ? h('details', { class: 'fc-details' }, h('summary', {}, t('fc_title'), ' · ', h('span', { class: 'muted small' }, condLine(v.conditions))), forecastTable(v.conditions, (v.recorded_at || '').slice(11, 16), v.spot_id)) : null,
      boardEl, commentsEl), side)));
}

// ================= amigos =================
function toggle(label, checked, onChange) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('span', { class: 'track' }), label);
}
function viewFriends() {
  const root = $app();
  const render = () => {
    const others = S.members.filter((m) => m.email !== S.me.email);
    others.sort((a, b) => (S.myGrants.get(b.email)?.favorite || 0) - (S.myGrants.get(a.email)?.favorite || 0) || (S.myGrants.has(b.email) - S.myGrants.has(a.email)) || a.name.localeCompare(b.name));
    const set = async (m, patch) => {
      await api('friends/' + encodeURIComponent(m.email), { method: 'PUT', body: patch });
      const cur = S.myGrants.get(m.email) || { can_view: 1, can_interact: 1, favorite: 0 };
      S.myGrants.set(m.email, { ...cur, friend_email: m.email, ...Object.fromEntries(Object.entries(patch).map(([k, x]) => [k, x ? 1 : 0])) });
      render();
    };
    root.replaceChildren(nav('nav_friends'), h('main', { class: 'wrap narrow' },
      h('h1', {}, t('friends_title')), h('p', { class: 'muted' }, t('friends_help')),
      others.length ? others.map((m) => {
        const g = S.myGrants.get(m.email);
        const theirs = S.grantsToMe.get(m.email);
        return h('section', { class: 'card friend' + (g ? ' is-friend' : '') },
          h('div', { class: 'friend-head' }, avatar(m, 44),
            h('div', { class: 'grow' }, h('strong', {}, m.name), h('div', { class: 'muted small' }, '@', m.username || '', theirs?.can_view ? ` · ${t('shares_with_you')}` : '')),
            g ? h('button', { class: 'star-btn' + (g.favorite ? ' on' : ''), title: t('favorite'), onclick: () => set(m, { favorite: !g.favorite }) }, '★') : null,
            g ? null : h('button', { class: 'btn small', onclick: () => set(m, { can_view: true, can_interact: true }) }, t('add_friend'))),
          g ? h('div', { class: 'perms' },
            toggle(t('perm_view'), !!g.can_view, (x) => set(m, { can_view: x })),
            toggle(t('perm_interact'), !!g.can_interact, (x) => set(m, { can_interact: x })),
            h('button', { class: 'link-btn danger-text', onclick: async () => { await api('friends/' + encodeURIComponent(m.email), { method: 'DELETE' }); S.myGrants.delete(m.email); render(); } }, t('remove_friend'))) : null);
      }) : h('p', { class: 'muted' }, t('no_people'))));
  };
  render();
}

// ================= perfil =================
function viewProfile() {
  const root = $app();
  const msg = h('p', { class: 'small muted' });
  const filePick = (onFile) => h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => e.target.files[0] && onFile(e.target.files[0]) });

  const avatarIn = filePick(async (f) => {
    const r = await api('me/avatar', { method: 'PUT', raw: await resizeImage(f, 256) });
    S.me.avatar_key = r.avatar_key; const mm = memberBy(S.me.email); if (mm) mm.avatar_key = r.avatar_key; viewProfile();
  });
  const nameIn = h('input', { type: 'text', value: S.me.name });
  const langSel = h('select', { onchange: async (e) => { await api('me', { method: 'PATCH', body: { lang: e.target.value } }); setLang(e.target.value); viewProfile(); } },
    [['es', 'Español'], ['en', 'English'], ['pt', 'Português']].map(([k, n]) => h('option', { value: k, selected: getLang() === k }, n)));
  const newPw = h('input', { type: 'password', placeholder: t('new_password'), autocomplete: 'new-password' });

  // tablas con foto
  const myBoards = S.boards.filter((b) => b.owner_email === S.me.email);
  const bName = h('input', { type: 'text', placeholder: t('board_name') });
  const bDet = h('input', { type: 'text', placeholder: t('board_details') });
  const boardCard = (b) => {
    const pic = filePick(async (f) => { const r = await api(`boards/${b.id}/photo`, { method: 'PUT', raw: await resizeImage(f, 900, false) }); b.photo_key = r.photo_key; viewProfile(); });
    return h('div', { class: 'board-card' },
      h('button', { class: 'board-photo', title: t('board_photo'), onclick: () => pic.click() },
        b.photo_key ? h('img', { src: media(b.photo_key), alt: b.name }) : h('span', { class: 'ph' }, '+', h('small', {}, t('board_photo'))), pic),
      h('div', { class: 'grow' }, h('strong', {}, b.name), b.details ? h('div', { class: 'muted small' }, b.details) : null),
      h('button', { class: 'icon-btn', title: t('remove'), onclick: async () => { await api('boards/' + b.id, { method: 'PATCH', body: { active: 0 } }); S.boards = S.boards.filter((x) => x.id !== b.id); viewProfile(); } }, '✕'));
  };

  // picos favoritos
  const spotChip = (s) => h('button', { class: 'chip' + (S.favSpots.has(s.id) ? ' on' : ''), onclick: async () => {
    const fav = !S.favSpots.has(s.id);
    await api(`spots/${s.id}/favorite`, { method: 'PUT', body: { favorite: fav } });
    fav ? S.favSpots.add(s.id) : S.favSpots.delete(s.id); viewProfile();
  } }, h('span', { class: 'fav' }, S.favSpots.has(s.id) ? '★' : '☆'), s.name);
  const spotName = h('input', { type: 'text', placeholder: t('spot_name') });
  const spotCoords = h('input', { type: 'text', placeholder: t('spot_coords') });

  const admin = S.me.role === 'admin' ? (() => {
    const un = h('input', { type: 'text', placeholder: t('username'), autocapitalize: 'off' });
    const pw = h('input', { type: 'text', placeholder: t('password') });
    const nm = h('input', { type: 'text', placeholder: t('name') });
    const rl = h('select', {}, ['member', 'coach', 'admin'].map((r) => h('option', { value: r }, t('role_' + r))));
    const amsg = h('p', { class: 'small muted' });
    return h('section', { class: 'card' }, h('h3', {}, t('admin_users')),
      h('p', { class: 'small muted' }, t('admin_help')),
      h('form', { class: 'inline', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('members', { method: 'POST', body: { username: un.value, password: pw.value, name: nm.value, role: rl.value } }); await boot(); amsg.textContent = t('user_created'); un.value = pw.value = nm.value = ''; }
        catch (x) { amsg.textContent = t('err_' + x.message); }
      } }, nm, un, pw, rl, h('button', { class: 'btn' }, t('create_user'))), amsg);
  })() : null;

  root.replaceChildren(nav('nav_profile'), h('main', { class: 'wrap narrow' },
    h('section', { class: 'card profile-head' },
      h('button', { class: 'avatar-edit', onclick: () => avatarIn.click() }, avatar(S.me, 84), h('span', {}, t('change_photo')), avatarIn),
      h('div', { class: 'grow' },
        h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); await api('me', { method: 'PATCH', body: { name: nameIn.value } }); S.me.name = nameIn.value; const mm = memberBy(S.me.email); if (mm) mm.name = nameIn.value; msg.textContent = t('saved'); } },
          nameIn, h('button', { class: 'btn small' }, t('save'))),
        h('p', { class: 'muted small' }, '@', S.me.username), msg)),

    h('section', { class: 'card' }, h('h3', {}, t('my_boards')),
      myBoards.length ? h('div', { class: 'boards' }, myBoards.map(boardCard)) : h('p', { class: 'muted small' }, t('no_boards')),
      h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); if (!bName.value.trim()) return; S.boards.push(await api('boards', { method: 'POST', body: { name: bName.value, details: bDet.value } })); viewProfile(); } },
        bName, bDet, h('button', { class: 'btn small' }, t('add')))),

    h('section', { class: 'card' }, h('h3', {}, t('my_spots')), h('p', { class: 'small muted' }, t('my_spots_help')),
      h('div', { class: 'chips' }, S.spots.map(spotChip)),
      h('form', { class: 'inline', onsubmit: async (e) => {
        e.preventDefault(); if (!spotName.value.trim()) return;
        const [lat, lon] = spotCoords.value.split(',').map((x) => parseFloat(x));
        const s = await api('spots', { method: 'POST', body: { name: spotName.value, lat, lon } });
        S.spots.push(s); S.favSpots.add(s.id); viewProfile();
      } }, spotName, spotCoords, h('button', { class: 'btn small' }, t('add'))),
      h('p', { class: 'small muted' }, t('spot_coords_help'))),

    h('section', { class: 'card' }, h('h3', {}, t('account')),
      h('label', { class: 'field' }, h('span', {}, t('language')), langSel),
      h('form', { class: 'inline', onsubmit: async (e) => { e.preventDefault(); try { await api('me', { method: 'PATCH', body: { password: newPw.value } }); newPw.value = ''; msg.textContent = t('saved'); } catch { msg.textContent = t('err_short_password'); } } },
        newPw, h('button', { class: 'btn small' }, t('change_password'))),
      h('p', {}, h('button', { class: 'btn ghost', onclick: async () => { await api('logout', { method: 'POST' }); location.reload(); } }, t('logout')))),
    admin));
}

// ================= login =================
function loginScreen() {
  setLang('es');
  const u = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', required: true });
  const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('p', { class: 'small err' });
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

// ================= rutas =================
async function route() {
  document.querySelectorAll('video.loop').forEach((v) => io.unobserve(v));
  const root = $app(); root.ondragover = root.ondrop = root.ondragleave = null;
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = /^#\/v\/([a-f0-9]{16})/.exec(hash))) return await viewDetail(m[1]);
    if (hash.startsWith('#/pizarra')) return await viewBoard();
    if (hash.startsWith('#/subir')) return viewUpload();
    if (hash.startsWith('#/amigos')) return viewFriends();
    if (hash.startsWith('#/perfil')) return viewProfile();
    return await viewTimeline();
  } catch (e) {
    console.error(e);
    if (e.status === 401) return loginScreen();
    root.replaceChildren(nav(''), h('main', { class: 'wrap' }, h('div', { class: 'card' }, String(e.message || e))));
  }
}
// evita que soltar un archivo fuera de la zona lo abra en el navegador
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('hashchange', route);
(async () => {
  try { await boot(); }
  catch (e) {
    if (e.status === 401) return loginScreen();
    $app().replaceChildren(h('main', { class: 'wrap narrow' }, h('div', { class: 'card' }, String(e.message))));
    return;
  }
  route();
})();
