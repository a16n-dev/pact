-- Apply with: wrangler d1 execute <db> --remote --file node_modules/@a16n/pact-server/schema.sql
--
-- Every table is scoped by app_name — the tenant boundary on a multi-tenant
-- server. Different apps share these tables but can never see each other's
-- rows: every query the server issues filters on app_name.

-- Dynamically provisioned apps (POST /apps, guarded by PROVISION_KEY).
-- Apps defined in the APPS env secret don't get rows here; the env roster
-- wins on a name collision. Passwords are stored PBKDF2-hashed.
CREATE TABLE apps (
  app_name TEXT NOT NULL PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE documents (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL,
  collection TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app_name, collection, id)
);
-- seq is assigned as MAX(seq)+1 per app; unique so any counter bug fails
-- loudly instead of silently corrupting pull cursors.
CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_name, seq);
-- The pull hot path: WHERE app_name = ? AND collection = ? AND seq > ?.
CREATE INDEX idx_documents_pull ON documents (app_name, collection, seq);

CREATE TABLE blobs (
  app_name TEXT NOT NULL,
  hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_name, hash)
);

CREATE TABLE clients (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Globally unique (stores the SHA-256 of the bearer token): the token
  -- alone resolves both the client and its app.
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (app_name, id)
);
CREATE INDEX idx_clients_token ON clients (token);
