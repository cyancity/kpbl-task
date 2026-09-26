ALTER TABLE sequence_runs
  ADD COLUMN lease_until timestamptz NULL,
  ADD COLUMN last_tick_at timestamptz NULL;

ALTER TABLE sequence_run_steps
  ADD COLUMN resolved_text text NULL,
  ADD COLUMN deferred_until timestamptz NULL;
