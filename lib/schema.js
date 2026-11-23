// Esquema de la base. Se aplica solo la primera vez que la API recibe una solicitud.
// Cada sentencia corre por separado; se ignoran las que ya estaban aplicadas
// (columna duplicada, tabla existente), así que es seguro repetirlas.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',   -- member | coach | admin
  lang        TEXT NOT NULL DEFAULT 'es',       -- es | en | pt
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS spots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,          -- ubicación del pico (aprox.)
  lon         REAL NOT NULL,
  fc_lat      REAL NOT NULL,          -- punto mar adentro para el modelo de oleaje
  fc_lon      REAL NOT NULL,
  tz          TEXT NOT NULL DEFAULT 'America/Fortaleza',
  sort        INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES members(email),
  name        TEXT NOT NULL,          -- ej. "Pyzel Ghost 5'10"
  details     TEXT,                   -- volumen, quillas, etc.
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS videos (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'uploading',  -- uploading | ready
  uploader_email  TEXT NOT NULL REFERENCES members(email),
  surfer_email    TEXT REFERENCES members(email),
  surfer_name     TEXT,                               -- si el surfista no es miembro
  board_id        TEXT REFERENCES boards(id),
  spot_id         TEXT REFERENCES spots(id),
  recorded_at     TEXT,                               -- hora local del pico, 'YYYY-MM-DDTHH:MM'
  source          TEXT,                               -- camera | phone | unknown
  wave_rating     INTEGER,                            -- 0..5 según el surfista
  surf_rating     INTEGER,                            -- 0..5 según el surfista
  title           TEXT,
  notes           TEXT,
  original_key    TEXT,
  preview_key     TEXT,
  poster_key      TEXT,
  duration        REAL,
  width           INTEGER,
  height          INTEGER,
  size_bytes      INTEGER,
  subject_ratio   REAL,                               -- alto del surfista / alto del cuadro
  flags           TEXT NOT NULL DEFAULT '[]',         -- ["small","not_detected","low_quality"]
  conditions      TEXT,                               -- JSON de Open-Meteo
  highlight_at    REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_surfer ON videos(surfer_email, recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_recorded ON videos(recorded_at)`,
  `CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author_email  TEXT NOT NULL REFERENCES members(email),
  kind          TEXT NOT NULL DEFAULT 'general',     -- general | coach
  body          TEXT NOT NULL,
  at_seconds    REAL,                                -- segundo del video al que se refiere
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at)`,
  `INSERT OR IGNORE INTO spots (id, name, lat, lon, fc_lat, fc_lon, sort) VALUES
  ('praia-do-amor',      'Praia do Amor',       -6.2345, -35.0425, -6.23, -34.98, 1),
  ('praia-do-centro',    'Praia do Centro',     -6.2270, -35.0445, -6.23, -34.98, 2),
  ('baia-dos-golfinhos', 'Baía dos Golfinhos',  -6.2215, -35.0430, -6.22, -34.98, 3),
  ('madeiro',            'Madeiro',             -6.2140, -35.0395, -6.21, -34.98, 4),
  ('cacimbinhas',        'Cacimbinhas',         -6.2060, -35.0360, -6.20, -34.98, 5),
  ('otro',               'Otro pico',           -6.2300, -35.0440, -6.23, -34.98, 99)`,
  `INSERT OR IGNORE INTO members (email, name, role) VALUES
  ('markuszl5@gmail.com', 'Markus', 'admin')`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `ALTER TABLE members ADD COLUMN username TEXT`,
  `ALTER TABLE members ADD COLUMN pass_hash TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username ON members(lower(username))`,
  `INSERT OR IGNORE INTO members (email, name, role) VALUES ('jou@surfclub.local', 'Jou', 'member')`,
  `UPDATE members SET username = 'markus', pass_hash = 'pbkdf2$100000$m0WpOH9WluyPz2t8PTl24A==$fD8iKj3nNT8qjlUBtbmVbvr/9GJR8dXky9F7qJrklEM=' WHERE email = 'markuszl5@gmail.com' AND pass_hash IS NULL`,
  `UPDATE members SET username = 'jou', pass_hash = 'pbkdf2$100000$g7VsjDg+TpHGWav+Vzwo7A==$LHP+tlsCehMMgZONq+kKPaNnIRnEJc8/W2VFRG2s1h4=' WHERE email = 'jou@surfclub.local' AND pass_hash IS NULL`,
  `ALTER TABLE members ADD COLUMN avatar_key TEXT`,
  `ALTER TABLE boards ADD COLUMN photo_key TEXT`,
  `ALTER TABLE spots ADD COLUMN created_by TEXT`,
  `CREATE TABLE IF NOT EXISTS favorite_spots (email TEXT NOT NULL, spot_id TEXT NOT NULL, PRIMARY KEY (email, spot_id))`,
  `CREATE TABLE IF NOT EXISTS friends (owner_email TEXT NOT NULL, friend_email TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_interact INTEGER NOT NULL DEFAULT 1, favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_email, friend_email))`,
  `CREATE TABLE IF NOT EXISTS likes (video_id TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (video_id, email))`,
  `UPDATE comments SET kind = 'rec' WHERE kind = 'coach'`,
  `DELETE FROM spots WHERE id = 'otro' AND NOT EXISTS (SELECT 1 FROM videos WHERE spot_id = 'otro')`,
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) {
    ready = (async () => {
      const done = await db.prepare("SELECT value FROM settings WHERE key = 'schema_v'").first().catch(() => null);
      if (done && Number(done.value) === SCHEMA.length) return;
      for (const s of SCHEMA) {
        try { await db.prepare(s).run(); }
        catch (e) { if (!/duplicate column|already exists/i.test(String(e.message || e))) throw e; }
      }
      await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_v', ?)").bind(String(SCHEMA.length)).run();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
