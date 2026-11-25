CREATE TABLE "coin_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"package_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"coins" bigint NOT NULL,
	"provider_fee_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"provider_transaction_id" text,
	"provider_response" text,
	"test_mode" boolean DEFAULT true NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "coin_orders_amount_ck" CHECK ("amount_minor" > 0 and "coins" > 0)
);
--> statement-breakpoint
CREATE TABLE "crypto_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"coins" bigint NOT NULL,
	"usd_minor" bigint NOT NULL,
	"service_fee_minor" bigint NOT NULL,
	"network_fee_minor" bigint NOT NULL,
	"rate_usd" text NOT NULL,
	"rate_source" text NOT NULL,
	"crypto_base_units" bigint NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crypto_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"reference" text NOT NULL UNIQUE,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"quote_id" uuid NOT NULL UNIQUE,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"wallet_address" text NOT NULL,
	"coins" bigint NOT NULL,
	"usd_minor" bigint NOT NULL,
	"service_fee_minor" bigint NOT NULL,
	"network_fee_minor" bigint NOT NULL,
	"rate_usd" text NOT NULL,
	"crypto_base_units" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fulfillment" text DEFAULT 'admin_queue' NOT NULL,
	"fulfillment_reference" text,
	"tx_hash" text,
	"verification" text,
	"failure_reason" text,
	"handled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "crypto_redemptions_amount_ck" CHECK ("coins" > 0 and "crypto_base_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "crypto_reserve_movements" (
	"id" bigserial PRIMARY KEY,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"direction" text NOT NULL,
	"base_units" bigint NOT NULL,
	"redemption_id" uuid,
	"tx_hash" text,
	"memo" text NOT NULL,
	"actor_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crypto_reserve_amount_ck" CHECK ("base_units" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "coin_orders_idem_uq" ON "coin_orders" ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "coin_orders_provider_tx_uq" ON "coin_orders" ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "coin_orders_user_idx" ON "coin_orders" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crypto_redemptions_idem_uq" ON "crypto_redemptions" ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "crypto_redemptions_tx_uq" ON "crypto_redemptions" ("network","tx_hash");--> statement-breakpoint
CREATE INDEX "crypto_redemptions_user_idx" ON "crypto_redemptions" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "crypto_redemptions_status_idx" ON "crypto_redemptions" ("status");