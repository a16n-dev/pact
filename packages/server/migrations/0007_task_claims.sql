-- Which writer may run a task right now. `task_id` and `rev` are opaque client strings; a claim
-- whose `expires_at` has passed can be taken by any writer.
CREATE TABLE task_claims (
  app_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  rev TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, task_id)
);
