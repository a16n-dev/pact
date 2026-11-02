-- A browser's remembered sign-in on the login page. Only the session hash is stored.
CREATE TABLE login_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_login_sessions_user ON login_sessions (user_id);
