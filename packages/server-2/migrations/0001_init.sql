CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE app_redirect_uris (
  app_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  PRIMARY KEY (app_id, uri)
);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  app_id TEXT NOT NULL,
  user_id TEXT,
  device_id TEXT,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- Admin-minted tokens have NULL user_id and device_id; SQLite treats NULLs as distinct here,
  -- so any number of them can coexist per app.
  UNIQUE (app_id, user_id, device_id)
);
CREATE INDEX idx_tokens_app ON tokens (app_id);

-- One row per (document, writer): each writer's latest version of the document.
CREATE TABLE documents (
  app_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (app_id, collection, id, writer_id)
);
CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_id, seq);

CREATE TABLE blobs (
  app_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- Who first uploaded the blob; NULL for uploads by API tokens.
  user_id TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, hash)
);
