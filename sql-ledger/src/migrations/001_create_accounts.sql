CREATE TABLE accounts (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
