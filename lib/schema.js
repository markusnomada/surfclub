// Esquema de la base. Se aplica solo la primera vez que la API recibe una solicitud
// (todas las sentencias son idempotentes: IF NOT EXISTS / INSERT OR IGNORE).
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  lang        TEXT NOT NULL DEFAULT 'es',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS spots (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  fc_lat      REAL NOT NULL,
  fc_lon      REAL NOT NULL,
  tz          TEXT NOT NULL DEFAULT 'America/Fortaleza',
  sort        INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES members(email),
  name        TEXT NOT NULL,
  details     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE TABLE IF NOT EXISTS videos (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'uploading',
  uploader_email  TEXT NOT NULL REFERENCES members(email),
  surfer_email    TEXT REFERENCES members(email),
  surfer_name     TEXT,
  board_id        TEXT REFERENCES boards(id),
  spot_id         TEXT REFERENCES spots(id),
  recorded_at     TEXT,
  source          TEXT,
  wave_rating     INTEGER,
  surf_rating     INTEGER,
  title           TEXT,
  notes           TEXT,
  original_key    TEXT,
  preview_key     TEXT,
  poster_key      TEXT,
  duration        REAL,
  width           INTEGER,
  height          INTEGER,
  size_bytes      INTEGER,
  subject_ratio   REAL,
  flags           TEXT NOT NULL DEFAULT '[]',
  conditions      TEXT,
  highlight_at    REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_surfer ON videos(surfer_email, recorded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_videos_recorded ON videos(recorded_at)`,
  `CREATE TABLE IF NOT EXISTS comments (
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  author_email  TEXT NOT NULL REFERENCES members(email),
  kind          TEXT NOT NULL DEFAULT 'general',
  body          TEXT NOT NULL,
  at_seconds    REAL,
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
];

let ready = null;
export function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}
