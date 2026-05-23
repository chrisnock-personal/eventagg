-- 012: Force password change on first login
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed BOOLEAN NOT NULL DEFAULT TRUE;

-- The seeded admin must change their password on first login
UPDATE users SET password_changed = FALSE WHERE username = 'admin';
