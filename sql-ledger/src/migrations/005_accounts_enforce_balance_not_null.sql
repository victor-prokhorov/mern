ALTER TABLE accounts ADD CONSTRAINT balance_minor_not_null CHECK (balance_minor IS NOT NULL) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT balance_minor_not_null;
