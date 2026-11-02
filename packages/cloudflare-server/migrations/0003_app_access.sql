ALTER TABLE apps ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;

-- Who may sign in to an app while it is restricted. Ignored otherwise.
CREATE TABLE app_users (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id)
);
