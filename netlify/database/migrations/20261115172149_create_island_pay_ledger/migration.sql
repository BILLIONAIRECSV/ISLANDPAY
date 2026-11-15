CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY,
	"actor_id" text,
	"actor_email" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_balances" (
	"currency" text PRIMARY KEY,
	"earned_minor" bigint DEFAULT 0 NOT NULL,
	"reversed_minor" bigint DEFAULT 0 NOT NULL,
	"available_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"withdrawn_minor" bigint DEFAULT 0 NOT NULL,
	"withdrawal_fees_minor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_balances" (
	"user_id" text,
	"currency" text,
	"available_minor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_balances_pkey" PRIMARY KEY("user_id","currency")
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text,
	"idempotency_key" text NOT NULL,
	"currency" text NOT NULL,
	"gross_minor" bigint NOT NULL,
	"company_fee_minor" bigint NOT NULL,
	"customer_credit_minor" bigint NOT NULL,
	"provider_fee_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"provider_status" text,
	"settlement_status" text DEFAULT 'unsettled' NOT NULL,
	"checkout_url" text,
	"crypto_asset" text,
	"crypto_amount" text,
	"transaction_hash" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "deposits_split_ck" CHECK ("company_fee_minor" + "customer_credit_minor" = "gross_minor"),
	CONSTRAINT "deposits_gross_ck" CHECK ("gross_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recipient" text NOT NULL,
	"template" text NOT NULL,
	"related_id" text,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY,
	"deposit_id" uuid,
	"withdrawal_id" uuid,
	"user_id" text,
	"currency" text NOT NULL,
	"account" text NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"memo" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_ck" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" text NOT NULL,
	"label" text NOT NULL,
	"currency" text NOT NULL,
	"beneficiary_name" text,
	"bank_name" text,
	"account_number" text,
	"swift" text,
	"asset" text,
	"network" text,
	"address" text,
	"created_by" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY,
	"email" text NOT NULL,
	"full_name" text,
	"phone" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"idempotency_key" text NOT NULL UNIQUE,
	"destination_id" uuid NOT NULL,
	"type" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_email" text,
	"approved_by" text,
	"provider_reference" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "withdrawals_amount_ck" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_provider_order_uq" ON "deposits" ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_idempotency_uq" ON "deposits" ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "deposits_user_idx" ON "deposits" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger_entries" ("user_id");--> statement-breakpoint
CREATE INDEX "ledger_deposit_idx" ON "ledger_entries" ("deposit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_key_uq" ON "webhook_events" ("provider","event_key");