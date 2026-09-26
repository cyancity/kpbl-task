ALTER TABLE agent_runs
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN scratch jsonb NOT NULL DEFAULT '{}';
