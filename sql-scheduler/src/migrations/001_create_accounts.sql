CREATE TABLE accounts (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
