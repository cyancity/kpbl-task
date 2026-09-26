ALTER TABLE sequence_runs
  ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_tick_at timestamptz NULL;

ALTER TABLE sequence_run_steps
  ADD COLUMN IF NOT EXISTS resolved_text text NULL,
  ADD COLUMN IF NOT EXISTS deferred_until timestamptz NULL;
