CREATE TRIGGER crypto_reserve_movements_append_only BEFORE UPDATE OR DELETE ON "crypto_reserve_movements"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
--> statement-breakpoint
CREATE TRIGGER coin_orders_no_delete BEFORE DELETE ON "coin_orders"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
--> statement-breakpoint
CREATE TRIGGER crypto_redemptions_no_delete BEFORE DELETE ON "crypto_redemptions"
  FOR EACH ROW EXECUTE FUNCTION island_pay_block_mutation();
