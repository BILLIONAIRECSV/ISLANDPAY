-- Financial history is permanent: block UPDATE and DELETE on the ledger and audit trail.
CREATE OR REPLACE FUNCTION island_pay_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
--> statement-breakpoint
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON "deposits"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
--> statement-breakpoint
CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON "withdrawals"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
