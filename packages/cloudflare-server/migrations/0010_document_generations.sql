-- The client-assigned generation of each version, NULL for versions pushed without one, including
-- every version written before this migration. A NULL generation never causes a rejection.
ALTER TABLE documents ADD COLUMN generation INTEGER;
