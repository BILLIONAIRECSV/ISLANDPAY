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
