ALTER TABLE apps ADD COLUMN api_proxy INTEGER NOT NULL DEFAULT 1;

-- One credential set per app and API name. `sealed` is the AES-GCM encrypted JSON of each field's
-- value and placement, under a key derived from the VAULT_KEY secret; `fields` lists the field
-- names in plain text so a client can see which are set.
CREATE TABLE api_credentials (
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  fields TEXT NOT NULL,
  sealed TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);
