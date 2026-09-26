INSERT INTO users (username, password_hash, role) VALUES
  ('admin', '$2a$10$IeTWmbnQs8ho6C.qld/SP./cZvuq8n4RUX06VurV2NaKFQNXaQfDu', 'admin'),
  ('viewer', '$2a$10$bdm0gRi.le5.oimyasSR3utb.VSObwIu4RVjWaAofrjLXCP.Aecpa', 'viewer')
ON CONFLICT (username) DO NOTHING;

INSERT INTO accounts (id, status) VALUES
  ('acc-1', 'idle'),
  ('acc-2', 'idle'),
  ('acc-3', 'idle'),
  ('acc-4', 'idle'),
  ('acc-5', 'idle'),
  ('acc-6', 'idle')
ON CONFLICT (id) DO NOTHING;
