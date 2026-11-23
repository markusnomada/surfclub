-- Login con usuario y clave (fase de prueba)
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE members ADD COLUMN username TEXT;
ALTER TABLE members ADD COLUMN pass_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username ON members(lower(username));
INSERT OR IGNORE INTO members (email, name, role) VALUES ('jou@surfclub.local', 'Jou', 'member');
UPDATE members SET username = 'markus', pass_hash = 'pbkdf2$100000$m0WpOH9WluyPz2t8PTl24A==$fD8iKj3nNT8qjlUBtbmVbvr/9GJR8dXky9F7qJrklEM=' WHERE email = 'markuszl5@gmail.com' AND pass_hash IS NULL;
UPDATE members SET username = 'jou', pass_hash = 'pbkdf2$100000$g7VsjDg+TpHGWav+Vzwo7A==$LHP+tlsCehMMgZONq+kKPaNnIRnEJc8/W2VFRG2s1h4=' WHERE email = 'jou@surfclub.local' AND pass_hash IS NULL;
