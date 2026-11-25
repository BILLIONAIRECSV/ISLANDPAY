// Island Pay financial schema. All monetary values are integer minor units (e.g. USD cents).
import {
  pgTable, text, bigint, timestamp, uuid, bigserial, jsonb, boolean, primaryKey, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);
const ts = (name: string) => timestamp(name, { withTimezone: true });

// Customer profile (identity lives in Netlify Identity; id = Identity user id).
export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  fullName: text("full_name"),
  phone: text("phone"),
  country: text("country"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const customerBalances = pgTable("customer_balances", {
  userId: text("user_id").notNull(),
  currency: text("currency").notNull(),
  availableMinor: money("available_minor"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.currency] })]);

// Internal Island Pay company balance. This is a ledger figure, not money already in a bank.
export const companyBalances = pgTable("company_balances", {
  currency: text("currency").primaryKey(),
  earnedMinor: money("earned_minor"),
  reversedMinor: money("reversed_minor"),
  availableMinor: money("available_minor"),
  reservedMinor: money("reserved_minor"),
  withdrawnMinor: money("withdrawn_minor"),
  withdrawalFeesMinor: money("withdrawal_fees_minor"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const deposits = pgTable("deposits", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  provider: text("provider").notNull(),
  providerOrderId: text("provider_order_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  currency: text("currency").notNull(),
  grossMinor: bigint("gross_minor", { mode: "number" }).notNull(),
  companyFeeMinor: bigint("company_fee_minor", { mode: "number" }).notNull(),
  customerCreditMinor: bigint("customer_credit_minor", { mode: "number" }).notNull(),
  providerFeeMinor: money("provider_fee_minor"),
  // created | pending | succeeded | failed | expired | refunded | reversed | review
  status: text("status").notNull().default("created"),
  providerStatus: text("provider_status"),
  // unsettled | provider_confirmed | settled
  settlementStatus: text("settlement_status").notNull().default("unsettled"),
  checkoutUrl: text("checkout_url"),
  cryptoAsset: text("crypto_asset"),
  cryptoAmount: text("crypto_amount"),
  transactionHash: text("transaction_hash"),
  failureReason: text("failure_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  succeededAt: ts("succeeded_at"),
  reversedAt: ts("reversed_at"),
}, (t) => [
  uniqueIndex("deposits_provider_order_uq").on(t.provider, t.providerOrderId),
  uniqueIndex("deposits_idempotency_uq").on(t.userId, t.idempotencyKey),
  index("deposits_user_idx").on(t.userId, t.createdAt),
  check("deposits_split_ck", sql`${t.companyFeeMinor} + ${t.customerCreditMinor} = ${t.grossMinor}`),
  check("deposits_gross_ck", sql`${t.grossMinor} > 0`),
]);

// Append-only double-entry style ledger (update/delete blocked by trigger).
export const ledgerEntries = pgTable("ledger_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  depositId: uuid("deposit_id"),
  withdrawalId: uuid("withdrawal_id"),
  userId: text("user_id"),
  currency: text("currency").notNull(),
  // customer_credit | company_revenue | company_withdrawal | withdrawal_fee
  account: text("account").notNull(),
  direction: text("direction").notNull(), // credit | debit
  kind: text("kind").notNull(), // deposit | reversal | withdrawal | withdrawal_fee
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  memo: text("memo").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("ledger_user_idx").on(t.userId),
  index("ledger_deposit_idx").on(t.depositId),
  check("ledger_amount_ck", sql`${t.amountMinor} > 0`),
]);

export const payoutDestinations = pgTable("payout_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // bank | crypto
  label: text("label").notNull(),
  currency: text("currency").notNull(),
  beneficiaryName: text("beneficiary_name"),
  bankName: text("bank_name"),
  accountNumber: text("account_number"),
  swift: text("swift"),
  asset: text("asset"),
  network: text("network"),
  address: text("address"),
  createdBy: text("created_by").notNull(),
  verifiedBy: text("verified_by"),
  verifiedAt: ts("verified_at"),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const withdrawals = pgTable("withdrawals", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  destinationId: uuid("destination_id").notNull(),
  type: text("type").notNull(),
  currency: text("currency").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  feeMinor: money("fee_minor"),
  // requested | approved | processing | paid | failed | rejected
  status: text("status").notNull().default("requested"),
  requestedBy: text("requested_by").notNull(),
  requestedByEmail: text("requested_by_email"),
  approvedBy: text("approved_by"),
  providerReference: text("provider_reference"),
  failureReason: text("failure_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
}, (t) => [check("withdrawals_amount_ck", sql`${t.amountMinor} > 0`)]);

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  eventKey: text("event_key").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  payload: jsonb("payload"),
  result: text("result"),
  createdAt: ts("created_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
}, (t) => [uniqueIndex("webhook_events_key_uq").on(t.provider, t.eventKey)]);

// Append-only audit trail (update/delete blocked by trigger).
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorId: text("actor_id"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const emailEvents = pgTable("email_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipient: text("recipient").notNull(),
  template: text("template").notNull(),
  relatedId: text("related_id"),
  status: text("status").notNull(), // sent | failed | skipped
  providerId: text("provider_id"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------------- IP Coin wallet & crypto shop ----------------
// IP Coin balances live in customer_balances with currency "IPC" (integer coins, 1 USD = 10 coins).
// Coin movements are written to ledger_entries with currency "IPC" (account "coin_wallet").

// Card/bank purchases of IP Coin packages. Coins are credited only after verified provider approval.
export const coinOrders = pgTable("coin_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  provider: text("provider").notNull(), // cxpay | sentoo
  method: text("method").notNull(), // card | bank
  packageId: text("package_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  currency: text("currency").notNull().default("USD"),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  coins: bigint("coins", { mode: "number" }).notNull(),
  providerFeeMinor: money("provider_fee_minor"), // estimated processing fee (business cost)
  refundedMinor: money("refunded_minor"),
  // created | pending | paid | failed | refunded | review
  status: text("status").notNull().default("created"),
  providerTransactionId: text("provider_transaction_id"),
  providerResponse: text("provider_response"),
  testMode: boolean("test_mode").notNull().default(true),
  failureReason: text("failure_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  paidAt: ts("paid_at"),
}, (t) => [
  uniqueIndex("coin_orders_idem_uq").on(t.userId, t.idempotencyKey),
  uniqueIndex("coin_orders_provider_tx_uq").on(t.provider, t.providerTransactionId),
  index("coin_orders_user_idx").on(t.userId, t.createdAt),
  check("coin_orders_amount_ck", sql`${t.amountMinor} > 0 and ${t.coins} > 0`),
]);

// Short-lived server-side price quotes for the crypto shop (locks rate & fees for a few minutes).
export const cryptoQuotes = pgTable("crypto_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  asset: text("asset").notNull(), // USDT | BTC
  network: text("network").notNull(),
  coins: bigint("coins", { mode: "number" }).notNull(),
  usdMinor: bigint("usd_minor", { mode: "number" }).notNull(),
  serviceFeeMinor: bigint("service_fee_minor", { mode: "number" }).notNull(),
  networkFeeMinor: bigint("network_fee_minor", { mode: "number" }).notNull(),
  rateUsd: text("rate_usd").notNull(),
  rateSource: text("rate_source").notNull(),
  cryptoBaseUnits: bigint("crypto_base_units", { mode: "number" }).notNull(), // sats / USDT micro-units
  usedAt: ts("used_at"),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// Customer crypto purchases paid with IP Coins. Coins are deducted atomically at creation.
export const cryptoRedemptions = pgTable("crypto_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  reference: text("reference").notNull().unique(), // human-friendly unique reference, e.g. IPX-7F3K9Q2M
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  quoteId: uuid("quote_id").notNull().unique(),
  asset: text("asset").notNull(),
  network: text("network").notNull(),
  walletAddress: text("wallet_address").notNull(),
  coins: bigint("coins", { mode: "number" }).notNull(),
  usdMinor: bigint("usd_minor", { mode: "number" }).notNull(),
  serviceFeeMinor: bigint("service_fee_minor", { mode: "number" }).notNull(),
  networkFeeMinor: bigint("network_fee_minor", { mode: "number" }).notNull(),
  rateUsd: text("rate_usd").notNull(),
  cryptoBaseUnits: bigint("crypto_base_units", { mode: "number" }).notNull(),
  // pending | processing | completed | failed | refunded
  status: text("status").notNull().default("pending"),
  fulfillment: text("fulfillment").notNull().default("admin_queue"), // admin_queue | provider name
  fulfillmentReference: text("fulfillment_reference"),
  txHash: text("tx_hash"),
  verification: text("verification"), // e.g. "mempool.space: confirmed, output matched" | "manual: admin attestation"
  failureReason: text("failure_reason"),
  handledBy: text("handled_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
}, (t) => [
  uniqueIndex("crypto_redemptions_idem_uq").on(t.userId, t.idempotencyKey),
  uniqueIndex("crypto_redemptions_tx_uq").on(t.network, t.txHash),
  index("crypto_redemptions_user_idx").on(t.userId, t.createdAt),
  index("crypto_redemptions_status_idx").on(t.status),
  check("crypto_redemptions_amount_ck", sql`${t.coins} > 0 and ${t.cryptoBaseUnits} > 0`),
]);

// Actual business-held crypto reserves (separate from customer coin liabilities and fiat cash).
export const cryptoReserveMovements = pgTable("crypto_reserve_movements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  asset: text("asset").notNull(),
  network: text("network").notNull(),
  direction: text("direction").notNull(), // in | out
  baseUnits: bigint("base_units", { mode: "number" }).notNull(),
  redemptionId: uuid("redemption_id"),
  txHash: text("tx_hash"),
  memo: text("memo").notNull(),
  actorEmail: text("actor_email"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [check("crypto_reserve_amount_ck", sql`${t.baseUnits} > 0`)]);
