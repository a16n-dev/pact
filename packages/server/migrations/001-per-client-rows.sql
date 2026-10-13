-- Migrates an existing deployment to protocol v4: per-client document rows
-- (siblings) and an app-wide pull cursor. Apply ONCE, against a database
-- whose schema predates the `client_id` column:
--
--   wrangler d1 execute <db> --remote --file migrations/001-per-client-rows.sql
--
-- Order of operations. The v4 Worker and this schema only work together:
-- the old Worker's upsert targets a conflict key this table no longer has,
-- and the new Worker's queries name `client_id`. So deploy the v4 Worker and
-- run this script back to back; pushes in the gap fail and are retried by
-- the client outbox, pulls in the gap fail and are retried on the next
-- trigger. Clients on an older protocol are refused outright by the v4
-- Worker (426), so upgrade apps to the v4 client alongside.
--
-- Not idempotent: a second run would re-tag every row '_legacy' and collide
-- on the primary key wherever a document already has more than one sibling.
--
-- SQLite can't alter a primary key, so the table is rebuilt. Existing rows
-- keep their seq (pull cursors stay valid) and are tagged client_id
-- '_legacy'. A legacy row is just another sibling to clients, folded like
-- any other; it stays until something removes it out-of-band. Dropping the
-- old table drops its indexes with it; the v4 index is recreated after the
-- rename, so there's no name collision.

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

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE UNIQUE INDEX idx_documents_app_seq ON documents (app_name, seq);
