-- Browser origins allowed to call the API for an app, as `https://host[:port]`.
CREATE TABLE app_origins (
  app_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (app_id, origin)
);

-- Origins used to be inferred from https redirect URIs; carry those over so existing apps keep
-- working. Strips everything from the first slash after the scheme's "//".
INSERT OR IGNORE INTO app_origins (app_id, origin)
SELECT app_id,
  CASE WHEN instr(substr(uri, 9), '/') > 0
    THEN substr(uri, 1, 8 + instr(substr(uri, 9), '/') - 1)
    ELSE uri END
FROM app_redirect_uris WHERE uri LIKE 'https://%';
