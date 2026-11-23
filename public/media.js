// Análisis del video en el navegador: fecha del archivo, detección del surfista,
// clip en loop liviano y poster. Nada de esto se manda a servidores externos.

// ---------- fecha de grabación desde el átomo 'mvhd' del MP4/MOV ----------
export async function readMp4CreationTime(file) {
  const chunks = [[0, Math.min(file.size, 1 << 20)]];
  if (file.size > 1 << 20) chunks.push([Math.max(0, file.size - 8 * (1 << 20)), file.size]);
  for (const [a, b] of chunks) {
    const buf = new Uint8Array(await file.slice(a, b).arrayBuffer());
    for (let i = 4; i < buf.length - 20; i++) {
      if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) { // 'mvhd'
        const dv = new DataView(buf.buffer, buf.byteOffset + i + 4);
        const version = dv.getUint8(0);
        let secs = version === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
        if (!secs) return null;
        const d = new Date((secs - 2082844800) * 1000); // epoch 1904 → 1970
        if (d.getFullYear() < 2010 || d > new Date(Date.now() + 86400000)) return null;
        return d;
      }
    }
  }
  return null;
}

// ---------- utilidades de video ----------
export function loadVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(new Error('No se pudo leer el video'));
    v.src = src;
  });
}

export function seek(v, t) {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.max(0, Math.min(t, (v.duration || 0) - 0.05));
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

let modelPromise = null;
async function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      return window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })();
  }
  return modelPromise;
}

// Mide qué tan grande se ve el surfista: alto de la persona (o tabla) / alto del cuadro.
export async function detectSubject(v, onProgress) {
  const model = await getModel();
  const N = 8;
  const W = 640, H = Math.round((v.videoHeight / v.videoWidth) * W) || 360;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const ratios = [];
  let best = { ratio: 0, time: v.duration / 2 };
  for (let k = 0; k < N; k++) {
    const t = v.duration * (0.05 + (0.9 * k) / (N - 1));
    await seek(v, t);
    ctx.drawImage(v, 0, 0, W, H);
    const preds = await model.detect(c, 20, 0.3);
    let r = 0;
    for (const p of preds) {
      const [, , w, h] = p.bbox;
      if (p.class === 'person') r = Math.max(r, h / H);
      if (p.class === 'surfboard') r = Math.max(r, (Math.max(w, h) / H) * 0.8);
    }
    if (r > 0) ratios.push(r);
    if (r > best.ratio) best = { ratio: r, time: t };
    onProgress && onProgress((k + 1) / N);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  return { ratio: median, detected: ratios.length, of: N, bestTime: best.time };
}

export function computeFlags({ ratio, detected }, { width, height, size, duration }) {
  const flags = [];
  if (detected < 2) flags.push('not_detected');
  else if (ratio < 0.08) flags.push('small');
  const bitrate = duration ? (size * 8) / duration : 0;
  if (Math.min(width, height) < 720 || (bitrate && bitrate < 2_500_000)) flags.push('low_quality');
  return flags;
}

// ---------- clip en loop (4 s, 480 px, sin audio) + poster ----------
function pickMime() {
  const opts = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export async function makePreview(src, start, seconds = 4, width = 480) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await recordPreview(src, start, seconds, width);
    if (r.frames >= seconds * 8) return r; // al menos ~8 cuadros por segundo
    console.warn('clip incompleto, reintentando', r.frames);
  }
  throw new Error('No se pudo generar el clip en loop. Deja la pestaña abierta y en primer plano mientras se sube.');
}

// Graba el clip en tiempo real. Si la pestaña pasa a segundo plano, pausa video y grabación
// (el navegador deja de dibujar) y los reanuda al volver, para no cortar el clip.
async function recordPreview(src, start, seconds, width) {
  const v = await loadVideo(src);
  const W = width, H = Math.round(((v.videoHeight / v.videoWidth) * W) / 2) * 2;
  const s = Math.max(0, Math.min(start, v.duration - seconds));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // poster a 960 px desde el medio del clip
  const pc = document.createElement('canvas'); pc.width = 960; pc.height = Math.round((v.videoHeight / v.videoWidth) * 960);
  await seek(v, s + seconds / 2);
  pc.getContext('2d').drawImage(v, 0, 0, pc.width, pc.height);
  const poster = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.8));
  await seek(v, s);
  ctx.drawImage(v, 0, 0, W, H);

  const mime = pickMime();
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1_200_000 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  let frames = 0, done = false;

  const onVis = () => {
    if (done) return;
    if (document.hidden) { v.pause(); if (rec.state === 'recording') rec.pause(); }
    else { if (rec.state === 'paused') rec.resume(); v.play().catch(() => {}); tick(); }
  };
  const finish = () => { if (done) return; done = true; v.pause(); document.removeEventListener('visibilitychange', onVis); if (rec.state !== 'inactive') rec.stop(); };
  const tick = () => {
    if (done || document.hidden) return;
    ctx.drawImage(v, 0, 0, W, H); frames++;
    if (v.currentTime >= s + seconds || v.ended) return finish();
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', onVis);
  rec.start(250);
  if (document.hidden) rec.pause(); else { await v.play(); tick(); }
  await stopped;
  v.removeAttribute('src'); v.load();
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  return { preview: new Blob(parts, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', poster, frames };
}

// ---------- subida por partes a R2 a través de la API ----------
export async function uploadMultipart(api, key, file, onProgress) {
  const PART = 16 * 1024 * 1024;
  const { uploadId } = await api('upload/create', { method: 'POST', body: { key, contentType: file.type || 'video/mp4' } });
  const parts = [];
  const total = Math.ceil(file.size / PART) || 1;
  try {
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * PART, Math.min(file.size, (i + 1) * PART));
      let attempt = 0, res;
      while (true) {
        try {
          res = await api(`upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`, { method: 'PUT', raw: blob });
          break;
        } catch (e) {
          if (++attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      parts.push({ partNumber: res.partNumber, etag: res.etag });
      onProgress && onProgress((i + 1) / total);
    }
    return api('upload/complete', { method: 'POST', body: { key, uploadId, parts } });
  } catch (e) {
    api('upload/abort', { method: 'POST', body: { key, uploadId } }).catch(() => {});
    throw e;
  }
}

// ---------- fecha desde el nombre del archivo ----------
// WhatsApp Video 2026-11-23 at 08.17.48 · VID_20261123_081748 · PXL_20261123_081748123 · 2026-11-23 08.17.48
export function dateFromFilename(name) {
  const pats = [
    /(20\d{2})-(\d{2})-(\d{2})[ _T]*(?:at[ _])?(\d{2})[.:_-](\d{2})[.:_-](\d{2})/i,
    /(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/,
  ];
  for (const re of pats) {
    const m = re.exec(name);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (!isNaN(d) && d.getFullYear() > 2010) return { date: d, whatsapp: /whatsapp/i.test(name) };
    }
  }
  return null;
}

// Fecha y hora del video: metadatos del archivo > nombre > fecha de modificación.
export async function detectRecordedAt(file) {
  const byName = dateFromFilename(file.name);
  if (byName?.whatsapp) return { date: byName.date, source: 'whatsapp' }; // WhatsApp re-codifica: su metadato es la hora de envío
  const meta = await readMp4CreationTime(file).catch(() => null);
  if (meta) return { date: meta, source: 'meta' };
  if (byName) return { date: byName.date, source: 'name' };
  if (file.lastModified) return { date: new Date(file.lastModified), source: 'modified' };
  return null;
}

// ---------- foto cuadrada/recortada liviana (perfil, tablas) ----------
export async function resizeImage(file, size = 512, square = true) {
  const img = await createImageBitmap(file);
  const c = document.createElement('canvas');
  if (square) {
    const s = Math.min(img.width, img.height);
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  } else {
    const k = Math.min(1, size / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}
