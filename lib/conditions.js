// Condiciones del mar para un pico y una hora local, desde Open-Meteo (gratis, sin clave).
// Oleaje y marea: Marine API. Viento: Forecast API (o Archive si la fecha es antigua).

const MARINE_VARS = [
  'wave_height', 'wave_period', 'wave_direction',
  'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
  'wind_wave_height', 'sea_level_height_msl', 'sea_surface_temperature',
];
const WIND_VARS = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];

function interp(times, values, target) {
  // times: ['YYYY-MM-DDTHH:00', ...] en hora local; target: Date-like minutes
  const t = (s) => Date.parse(s + ':00Z');
  const x = t(target);
  for (let i = 0; i < times.length - 1; i++) {
    const a = t(times[i]), b = t(times[i + 1]);
    if (x >= a && x <= b) {
      const va = values[i], vb = values[i + 1];
      if (va == null || vb == null) return va ?? vb ?? null;
      return va + (vb - va) * ((x - a) / (b - a));
    }
  }
  return null;
}

function nearestIndex(times, target) {
  const x = Date.parse(target + ':00Z');
  let best = 0, bd = Infinity;
  times.forEach((s, i) => { const d = Math.abs(Date.parse(s + ':00Z') - x); if (d < bd) { bd = d; best = i; } });
  return best;
}

const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  return r.json();
}

// Estado del viento respecto a la costa (como en las tablas de surf):
// facing = hacia dónde mira la playa (grados). Viento "desde el mar" = onshore.
export function windState(windFrom, facing = 90) {
  if (windFrom == null) return null;
  const d = Math.abs((((windFrom - facing) % 360) + 540) % 360 - 180); // 0 = desde el mar, 180 = desde tierra
  if (d < 35) return 'onshore';
  if (d < 80) return 'cross-on';
  if (d <= 100) return 'cross';
  if (d < 145) return 'cross-off';
  return 'offshore';
}

export async function fetchConditions(spot, recordedAt) {
  // recordedAt: 'YYYY-MM-DDTHH:MM' hora local del pico
  const date = recordedAt.slice(0, 10);
  const tz = encodeURIComponent(spot.tz || 'America/Fortaleza');
  // pedimos el día anterior y el siguiente para tener contexto de marea
  const d = new Date(date + 'T12:00:00Z');
  const start = new Date(d - 86400000).toISOString().slice(0, 10);
  const end = new Date(+d + 86400000).toISOString().slice(0, 10);

  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${spot.fc_lat}&longitude=${spot.fc_lon}&hourly=${MARINE_VARS.join(',')}&start_date=${start}&end_date=${end}&timezone=${tz}`;
  const ageDays = (Date.now() - Date.parse(date)) / 86400000;
  const windBase = ageDays > 80 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const windUrl = `${windBase}?latitude=${spot.lat}&longitude=${spot.lon}&hourly=${WIND_VARS.join(',')}&start_date=${start}&end_date=${end}&timezone=${tz}&wind_speed_unit=kmh`;

  const [marine, wind] = await Promise.allSettled([getJson(marineUrl), getJson(windUrl)]);
  const out = { source: 'open-meteo', at: recordedAt, spot_id: spot.id, fetched_at: new Date().toISOString() };

  if (marine.status === 'fulfilled') {
    const h = marine.value.hourly;
    const i = nearestIndex(h.time, recordedAt);
    out.wave_height = round(h.wave_height[i]);
    out.wave_period = round(h.wave_period[i], 1);
    out.wave_direction = h.wave_direction[i];
    out.swell_height = round(h.swell_wave_height[i]);
    out.swell_period = round(h.swell_wave_period[i], 1);
    out.swell_direction = h.swell_wave_direction[i];
    out.wind_wave_height = round(h.wind_wave_height[i]);
    out.sea_temp = round(h.sea_surface_temperature[i], 1);
    // marea: altura interpolada al minuto, tendencia y rango del día
    const tide = interp(h.time, h.sea_level_height_msl, recordedAt);
    const later = new Date(Date.parse(recordedAt + ':00Z') + 30 * 60000).toISOString().slice(0, 16);
    const tideLater = interp(h.time, h.sea_level_height_msl, later);
    const dayIdx = h.time.map((s, k) => [s, k]).filter(([s]) => s.startsWith(date)).map(([, k]) => k);
    const dayVals = dayIdx.map((k) => h.sea_level_height_msl[k]).filter((v) => v != null);
    out.tide_height = round(tide);
    out.tide_trend = tide != null && tideLater != null ? (tideLater > tide + 0.01 ? 'rising' : tideLater < tide - 0.01 ? 'falling' : 'slack') : null;
    out.tide_day_min = dayVals.length ? round(Math.min(...dayVals)) : null;
    out.tide_day_max = dayVals.length ? round(Math.max(...dayVals)) : null;
    // curva del día (para dibujarla)
    out.tide_curve = dayIdx.map((k) => [h.time[k].slice(11, 16), round(h.sea_level_height_msl[k])]);
  } else {
    out.marine_error = String(marine.reason);
  }

  if (wind.status === 'fulfilled') {
    const h = wind.value.hourly;
    out.wind_speed = round(interp(h.time, h.wind_speed_10m, recordedAt), 0);
    out.wind_gusts = round(interp(h.time, h.wind_gusts_10m, recordedAt), 0);
    out.wind_direction = h.wind_direction_10m[nearestIndex(h.time, recordedAt)];
    out.wind_state = windState(out.wind_direction, spot.facing ?? 90);
  } else {
    out.wind_error = String(wind.reason);
  }

  // tabla del día cada 3 horas (para la vista tipo forecast)
  const mh = marine.status === 'fulfilled' ? marine.value.hourly : null;
  const wh = wind.status === 'fulfilled' ? wind.value.hourly : null;
  out.day = [0, 3, 6, 9, 12, 15, 18, 21].map((hh) => {
    const key = `${date}T${String(hh).padStart(2, '0')}:00`;
    const mi = mh ? mh.time.indexOf(key) : -1;
    const wi = wh ? wh.time.indexOf(key) : -1;
    const wdir = wi >= 0 ? wh.wind_direction_10m[wi] : null;
    return {
      h: hh,
      wave: mi >= 0 ? round(mh.wave_height[mi], 1) : null,
      swell: mi >= 0 ? round(mh.swell_wave_height[mi], 1) : null,
      period: mi >= 0 ? round(mh.swell_wave_period[mi], 0) : null,
      swell_dir: mi >= 0 ? mh.swell_wave_direction[mi] : null,
      wind: wi >= 0 ? round(wh.wind_speed_10m[wi], 0) : null,
      gust: wi >= 0 ? round(wh.wind_gusts_10m[wi], 0) : null,
      wind_dir: wdir,
      wind_state: windState(wdir, spot.facing ?? 90),
      tide: mi >= 0 ? round(mh.sea_level_height_msl[mi], 1) : null,
    };
  });
  out.source_label = 'Open-Meteo';
  return out;
}
