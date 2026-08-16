CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  saga_id bigint NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status text NOT NULL DEFAULT 'charged' CHECK (status IN ('charged', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saga_id)
);
