CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  sku text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'placed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
