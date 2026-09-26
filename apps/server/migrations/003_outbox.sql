ALTER TABLE messages ADD COLUMN IF NOT EXISTS sending_since timestamptz NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS first_404_at timestamptz NULL;
