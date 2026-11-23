-- v4: ficha técnica de tablas e historial de datos del surfista
ALTER TABLE boards ADD COLUMN brand TEXT;
ALTER TABLE boards ADD COLUMN model TEXT;
ALTER TABLE boards ADD COLUMN length TEXT;
ALTER TABLE boards ADD COLUMN width TEXT;
ALTER TABLE boards ADD COLUMN thickness TEXT;
ALTER TABLE boards ADD COLUMN volume REAL;
ALTER TABLE boards ADD COLUMN construction TEXT;
CREATE TABLE IF NOT EXISTS body_metrics (id TEXT PRIMARY KEY, email TEXT NOT NULL, recorded_on TEXT NOT NULL, height_cm REAL, weight_kg REAL, age INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_body_metrics ON body_metrics(email, recorded_on);
