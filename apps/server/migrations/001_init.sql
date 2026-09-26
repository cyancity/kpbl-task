CREATE TABLE users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','viewer'))
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  token_hash text UNIQUE NOT NULL,
  used_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('idle','online','rate_limited','disconnected','suspended','session_expired')),
  platform_user_id text NULL,
  rate_limited_until timestamptz NULL,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id uuid PRIMARY KEY,
  gateway_group_id text UNIQUE NULL,
  status text NOT NULL CHECK (status IN ('creating','active','unreachable','left')),
  creator_account_id text NOT NULL REFERENCES accounts(id),
  agent_enabled boolean NOT NULL DEFAULT false,
  auto_kick_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id),
  account_id text NULL REFERENCES accounts(id),
  platform_user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('creator','admin','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, platform_user_id)
);

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  msg_id text NULL,
  client_msg_id uuid NULL UNIQUE,
  sender_platform_user_id text NULL,
  sender_account_id text NULL REFERENCES accounts(id),
  is_own boolean NOT NULL DEFAULT false,
  text text,
  sent_at timestamptz NOT NULL,
  media_url text NULL,
  local_file_path text NULL,
  delivery_status text NULL CHECK (delivery_status IN ('queued','sending','accepted','sent','failed','unknown','cancelled')),
  fail_code text NULL,
  accepted_at timestamptz NULL,
  unknown_since timestamptz NULL,
  resend_count int NOT NULL DEFAULT 0,
  sequence_run_step_id uuid NULL,
  agent_step_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, msg_id)
);

CREATE TABLE gateway_events (
  event_id bigint PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway_cursor (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  watermark bigint NOT NULL DEFAULT 0
);

CREATE TABLE dead_events (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  error text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ws_events (
  seq bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  group_id uuid,
  status text NOT NULL CHECK (status IN ('running','finished','failed')),
  state jsonb,
  errors jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequences (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  steps jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_runs (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  sequence_id uuid NOT NULL REFERENCES sequences(id),
  status text NOT NULL CHECK (status IN ('running','finished','failed','stopped')),
  current_step_index int,
  vars jsonb,
  step_vars jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sequence_runs_one_running ON sequence_runs (group_id) WHERE status = 'running';

CREATE TABLE sequence_run_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES sequence_runs(id),
  index int NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','sent','skipped','failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  client_msg_id uuid NULL,
  resolved_vars jsonb,
  var_sources jsonb,
  account_id text NULL,
  UNIQUE (run_id, index)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  status text NOT NULL CHECK (status IN ('running','finished','failed','blocked','cancelled')),
  end_reason text NULL,
  summary text NULL,
  trigger_messages jsonb,
  history jsonb NOT NULL DEFAULT '[]',
  step_count int NOT NULL DEFAULT 0,
  consecutive_protocol_errors int NOT NULL DEFAULT 0,
  elapsed_ms bigint NOT NULL DEFAULT 0,
  resumed_at timestamptz NULL,
  lease_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL
);
CREATE UNIQUE INDEX agent_runs_one_running ON agent_runs (group_id) WHERE status = 'running';

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  seq int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
  tool_use_id text NULL,
  name text NULL,
  input jsonb NULL,
  state text CHECK (state IN ('executing','done')),
  result_summary text NULL,
  is_error boolean NOT NULL DEFAULT false,
  error_code text NULL,
  audit_verdict text NULL,
  raw_response text NULL,
  client_msg_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE agent_pending_messages (
  run_group_id uuid NOT NULL,
  message_pk bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_group_id, message_pk)
);

CREATE TABLE agent_idempotency (
  run_id uuid NOT NULL,
  key text NOT NULL,
  client_msg_id uuid NOT NULL,
  PRIMARY KEY (run_id, key)
);
