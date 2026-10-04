-- "Forgot password" support for BOTH admin and employee logins (same users table).
-- Only a SHA-256 hash of the reset token is stored — never the raw token — so a
-- database read alone can't be used to reset someone's password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_reset_token_hash ON users (reset_token_hash) WHERE reset_token_hash IS NOT NULL;
