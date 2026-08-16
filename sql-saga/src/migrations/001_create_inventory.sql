CREATE TABLE inventory (
  sku text PRIMARY KEY,
  available integer NOT NULL CHECK (available >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);

CREATE TABLE reservations (
  saga_id bigint NOT NULL,
  sku text NOT NULL REFERENCES inventory(sku),
  qty integer NOT NULL CHECK (qty > 0),
  released boolean NOT NULL DEFAULT false,
  PRIMARY KEY (saga_id, sku)
);
