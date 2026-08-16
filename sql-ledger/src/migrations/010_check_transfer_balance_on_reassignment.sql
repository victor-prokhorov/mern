CREATE OR REPLACE FUNCTION check_transfer_balance() RETURNS trigger AS $$
DECLARE
  total bigint;
  affected_transfer_id bigint;
BEGIN
  affected_transfer_id := COALESCE(NEW.transfer_id, OLD.transfer_id);
  SELECT COALESCE(SUM(amount_minor), 0) INTO total FROM entries WHERE transfer_id = affected_transfer_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'entries for transfer % do not sum to zero (got %)', affected_transfer_id, total;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transfer_id IS DISTINCT FROM NEW.transfer_id THEN
    SELECT COALESCE(SUM(amount_minor), 0) INTO total FROM entries WHERE transfer_id = OLD.transfer_id;
    IF total <> 0 THEN
      RAISE EXCEPTION 'entries for transfer % do not sum to zero (got %)', OLD.transfer_id, total;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
