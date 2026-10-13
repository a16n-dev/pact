-- Migrates an existing deployment to per-client document rows (siblings).
-- Apply once, against a server whose schema predates the `client_id` column:
--
--   wrangler d1 execute <db> --remote --file migrations/001-per-client-rows.sql
--
-- SQLite can't alter a primary key, so the table is rebuilt. Existing rows
-- keep their seq (pull cursors stay valid) and are tagged client_id
-- '_legacy'. A legacy row is just another sibling to clients, folded like
-- any other; it stays until something removes it out-of-band.
--
-- Safe to run with v1 clients still connected: they pull siblings and apply
-- last-write-wins locally, which lands on the same answer the old server
-- upsert did, and their pushes land in their own rows.

CREATE TABLE documents_new (
  app_name TEXT NOT NULL,
  id TEXT NOT NULL,
  collection TEXT NOT NULL,
  client_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app_name, collection, id, client_id)
);

INSERT INTO documents_new (app_name, id, collection, client_id, updated_at, data, seq)
SELECT app_name, id, collection, '_legacy', updated_at, data, seq FROM documents;

DROP INDEX IF EXISTS idx_documents_app_seq;
DROP INDEX IF EXISTS idx_documents_pull;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_name, seq);
CREATE INDEX idx_documents_pull ON documents (app_name, collection, seq);
