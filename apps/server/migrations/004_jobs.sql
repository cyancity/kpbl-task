ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_run_at timestamptz NULL;
