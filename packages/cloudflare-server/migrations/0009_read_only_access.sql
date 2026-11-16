-- Only read on API tokens. A device token's access comes from its user's app_users row while the
-- app is restricted, so it is looked up at request time rather than stored on the token.
ALTER TABLE tokens ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_users ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
