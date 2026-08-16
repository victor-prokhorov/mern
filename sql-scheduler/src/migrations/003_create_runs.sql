CREATE TABLE runs (
  id bigserial PRIMARY KEY,
  schedule_id bigint NOT NULL REFERENCES schedules(id),
  occurrence_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  error text,
  UNIQUE (schedule_id, occurrence_at)
);

CREATE INDEX runs_schedule_idx ON runs (schedule_id, occurrence_at DESC);
