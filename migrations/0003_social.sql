-- v2: amigos con permisos, likes, notas y recomendaciones, fotos, picos propios y favoritos
ALTER TABLE members ADD COLUMN avatar_key TEXT;
ALTER TABLE boards ADD COLUMN photo_key TEXT;
ALTER TABLE spots ADD COLUMN created_by TEXT;
CREATE TABLE IF NOT EXISTS favorite_spots (email TEXT NOT NULL, spot_id TEXT NOT NULL, PRIMARY KEY (email, spot_id));
CREATE TABLE IF NOT EXISTS friends (owner_email TEXT NOT NULL, friend_email TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_interact INTEGER NOT NULL DEFAULT 1, favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_email, friend_email));
CREATE TABLE IF NOT EXISTS likes (video_id TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (video_id, email));
UPDATE comments SET kind = 'rec' WHERE kind = 'coach';
DELETE FROM spots WHERE id = 'otro' AND NOT EXISTS (SELECT 1 FROM videos WHERE spot_id = 'otro');
