CREATE TABLE shipments (
  id bigserial PRIMARY KEY,
  saga_id bigint NOT NULL,
  address text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saga_id)
);
