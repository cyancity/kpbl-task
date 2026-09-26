ALTER TABLE jobs ADD COLUMN lease_until timestamptz NULL;
ALTER TABLE jobs ADD COLUMN next_run_at timestamptz NULL;
