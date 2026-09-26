ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scratch jsonb NOT NULL DEFAULT '{}';
