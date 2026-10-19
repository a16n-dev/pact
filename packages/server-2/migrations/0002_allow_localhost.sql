ALTER TABLE apps ADD COLUMN allow_localhost INTEGER NOT NULL DEFAULT 0;

-- Loopback redirect URIs used to be registered one by one; the per-app switch replaces them.
UPDATE apps SET allow_localhost = 1 WHERE id IN (
  SELECT app_id FROM app_redirect_uris
  WHERE uri LIKE 'http://localhost%' OR uri LIKE 'http://127.0.0.1%'
);
DELETE FROM app_redirect_uris WHERE uri LIKE 'http://localhost%' OR uri LIKE 'http://127.0.0.1%';
