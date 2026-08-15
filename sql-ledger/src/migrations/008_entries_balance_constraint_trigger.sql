CREATE FUNCTION check_transfer_balance() RETURNS trigger AS $$
DECLARE
  total bigint;
  affected_transfer_id bigint;
BEGIN
  affected_transfer_id := COALESCE(NEW.transfer_id, OLD.transfer_id);
  SELECT COALESCE(SUM(amount_minor), 0) INTO total FROM entries WHERE transfer_id = affected_transfer_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'entries for transfer % do not sum to zero (got %)', affected_transfer_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balance_check
AFTER INSERT OR UPDATE OR DELETE ON entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_transfer_balance();
