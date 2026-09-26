ALTER TABLE messages ADD COLUMN sending_since timestamptz NULL;
ALTER TABLE messages ADD COLUMN first_404_at timestamptz NULL;
