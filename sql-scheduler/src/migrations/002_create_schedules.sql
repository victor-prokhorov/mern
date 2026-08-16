CREATE TABLE schedules (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts(id),
  name text NOT NULL,
  cadence text NOT NULL,
  timezone text NOT NULL,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  catchup_policy text NOT NULL DEFAULT 'skip',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE active;
