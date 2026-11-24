-- Session invalidation: bumping token_version logs a user out everywhere (password change / reset).
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
-- Brute-force protection: failed login attempts per (ip|username) within a window.
CREATE TABLE login_attempts (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);
