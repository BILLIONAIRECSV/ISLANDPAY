import { and, eq, sql } from "drizzle-orm";
import { db, deposits, customerBalances, companyBalances, ledgerEntries } from "../db/index.js";
import { audit } from "./audit.js";
import { type BanxaOrder, classifyStatus, PROVIDER } from "./banxa.js";
import { alertThresholdMinor, formatMoney } from "./money.js";
import { adminEmails, sendEmail, templates } from "./email.js";

type Deposit = typeof deposits.$inferSelect;
type Outcome = { result: string; deposit?: Deposit; emails: Array<() => Promise<void>> };

async function ensureCompanyRow(tx: any, currency: string) {
  await tx.insert(companyBalances).values({ currency }).onConflictDoNothing();
  const [row] = await tx.select().from(companyBalances).where(eq(companyBalances.currency, currency)).for("update");
  return row;
}

/**
 * Applies the authoritative Banxa order state to the matching deposit. Safe to call repeatedly
 * (webhook retries, customer refreshes): a deposit is credited at most once because the row is
 * locked and its status checked inside the transaction.
 */
export async function applyProviderOrder(order: BanxaOrder, source: string): Promise<Outcome> {
  const emails: Outcome["emails"] = [];
  const outcome = await db.transaction(async (tx) => {
    const [dep] = await tx.select().from(deposits)
      .where(and(eq(deposits.provider, PROVIDER), eq(deposits.providerOrderId, order.id))).for("update");
    if (!dep) {
      await audit(tx, { action: "provider_order_unmatched", entityType: "banxa_order", entityId: order.id, details: { source, status: order.status } });
      emails.push(() => sendEmail(adminEmails(), templates.adminSuspicious({ reason: "A Banxa order event did not match any Island Pay deposit.", details: [["Banxa order", order.id], ["Status", order.status]] }), "admin_suspicious", order.id));
      return { result: "unmatched" };
    }

    const kind = classifyStatus(order.status);
    await tx.update(deposits).set({ providerStatus: order.status, updatedAt: new Date() }).where(eq(deposits.id, dep.id));

    // Integrity checks: reference, amount and currency must match what we created.
    const mismatch: string[] = [];
    if (order.externalOrderId && order.externalOrderId !== dep.id) mismatch.push("externalOrderId");
    if (order.fiat !== dep.currency) mismatch.push(`currency ${order.fiat} != ${dep.currency}`);
    if (order.fiatAmountMinor !== dep.grossMinor) mismatch.push(`amount ${order.fiatAmountMinor} != ${dep.grossMinor}`);

    if (kind === "success") {
      if (dep.status === "succeeded") return { result: "duplicate", deposit: dep };
      if (mismatch.length) {
        await tx.update(deposits).set({ status: "review", failureReason: `Provider mismatch: ${mismatch.join(", ")}` }).where(eq(deposits.id, dep.id));
        await audit(tx, { action: "deposit_mismatch_hold", entityType: "deposit", entityId: dep.id, details: { mismatch, order } });
        emails.push(() => sendEmail(adminEmails(), templates.adminSuspicious({ reason: "Provider order did not match the expected deposit. No credits were issued.", details: [["Deposit", dep.id], ["Banxa order", order.id], ["Mismatch", mismatch.join("; ")]] }), "admin_suspicious", dep.id));
        return { result: "mismatch_hold" };
      }
      if (!["created", "pending", "expired", "failed"].includes(dep.status)) {
        await audit(tx, { action: "deposit_success_needs_review", entityType: "deposit", entityId: dep.id, details: { currentStatus: dep.status, order } });
        return { result: "needs_review" };
      }
      const now = new Date();
      const [updated] = await tx.update(deposits).set({
        status: "succeeded", settlementStatus: "provider_confirmed", succeededAt: now, updatedAt: now, failureReason: null,
        providerFeeMinor: order.processingFeeMinor + order.networkFeeMinor,
        cryptoAsset: order.crypto, cryptoAmount: order.cryptoAmount, transactionHash: order.transactionHash,
      }).where(eq(deposits.id, dep.id)).returning();

      await tx.insert(customerBalances).values({ userId: dep.userId, currency: dep.currency, availableMinor: dep.customerCreditMinor })
        .onConflictDoUpdate({ target: [customerBalances.userId, customerBalances.currency], set: { availableMinor: sql`${customerBalances.availableMinor} + ${dep.customerCreditMinor}`, updatedAt: now } });
      await ensureCompanyRow(tx, dep.currency);
      await tx.update(companyBalances).set({
        earnedMinor: sql`${companyBalances.earnedMinor} + ${dep.companyFeeMinor}`,
        availableMinor: sql`${companyBalances.availableMinor} + ${dep.companyFeeMinor}`, updatedAt: now,
      }).where(eq(companyBalances.currency, dep.currency));
      await tx.insert(ledgerEntries).values([
        { depositId: dep.id, userId: dep.userId, currency: dep.currency, account: "customer_credit", direction: "credit", kind: "deposit", amountMinor: dep.customerCreditMinor, memo: "91.12% customer credit allocation" },
        { depositId: dep.id, userId: null, currency: dep.currency, account: "company_revenue", direction: "credit", kind: "deposit", amountMinor: dep.companyFeeMinor, memo: "8.88% Island Pay platform fee" },
      ]);
      await audit(tx, { action: "deposit_credited", entityType: "deposit", entityId: dep.id, details: { source, banxaOrder: order.id, gross: dep.grossMinor, fee: dep.companyFeeMinor, credit: dep.customerCreditMinor } });
      emails.push(() => sendEmail(dep.email, templates.depositSucceeded(updated), "deposit_succeeded", dep.id));
      emails.push(() => sendEmail(adminEmails(), templates.adminDeposit(updated), "admin_deposit", dep.id));
      if (dep.grossMinor >= alertThresholdMinor()) {
        emails.push(() => sendEmail(adminEmails(), templates.adminSuspicious({ reason: `Large deposit at or above the ${formatMoney(alertThresholdMinor(), dep.currency)} alert threshold.`, details: [["Deposit", dep.id], ["Customer", dep.email], ["Amount", formatMoney(dep.grossMinor, dep.currency)]] }), "admin_suspicious", dep.id));
      }
      return { result: "credited", deposit: updated };
    }

    if (kind === "refund") {
      if (dep.status === "succeeded") {
        const r = await reverseDepositTx(tx, dep, "refunded", `Banxa order refunded (${source})`, null);
        emails.push(...r.emails);
        return { result: "refunded", deposit: r.deposit };
      }
      if (["refunded", "reversed"].includes(dep.status)) return { result: "duplicate", deposit: dep };
      await tx.update(deposits).set({ status: "refunded", failureReason: "Refunded before credits were issued" }).where(eq(deposits.id, dep.id));
      return { result: "refunded_uncredited" };
    }

    if (kind === "failure" || kind === "expired") {
      if (dep.status === "succeeded") {
        // A credited order should never move to failure; hold for manual reconciliation.
        await audit(tx, { action: "credited_deposit_failure_event", entityType: "deposit", entityId: dep.id, details: { order } });
        emails.push(() => sendEmail(adminEmails(), templates.adminSuspicious({ reason: `A credited deposit received a "${order.status}" status from Banxa. Review and reverse manually if required.`, details: [["Deposit", dep.id], ["Banxa order", order.id]] }), "admin_suspicious", dep.id));
        return { result: "needs_review" };
      }
      if (["failed", "expired"].includes(dep.status) && dep.providerStatus === order.status) return { result: "duplicate" };
      const status = kind === "expired" ? "expired" : "failed";
      const [updated] = await tx.update(deposits).set({ status, failureReason: `Banxa status: ${order.status}`, updatedAt: new Date() }).where(eq(deposits.id, dep.id)).returning();
      await audit(tx, { action: `deposit_${status}`, entityType: "deposit", entityId: dep.id, details: { source, order: order.id, status: order.status } });
      if (kind === "failure") {
        emails.push(() => sendEmail(dep.email, templates.depositFailed(updated), "deposit_failed", dep.id));
        emails.push(() => sendEmail(adminEmails(), templates.adminFailed(updated), "admin_failed", dep.id));
      }
      return { result: status, deposit: updated };
    }

    if (dep.status === "created") await tx.update(deposits).set({ status: "pending" }).where(eq(deposits.id, dep.id));
    return { result: "pending" };
  });
  return { ...outcome, emails };
}

/** Creates reversal entries for a credited deposit. Never deletes history. */
export async function reverseDepositTx(tx: any, dep: Deposit, status: "refunded" | "reversed", reason: string, actor: { id: string; email: string } | null) {
  const now = new Date();
  const [updated] = await tx.update(deposits).set({ status, reversedAt: now, updatedAt: now, failureReason: reason }).where(eq(deposits.id, dep.id)).returning();
  await tx.update(customerBalances).set({ availableMinor: sql`${customerBalances.availableMinor} - ${dep.customerCreditMinor}`, updatedAt: now })
    .where(and(eq(customerBalances.userId, dep.userId), eq(customerBalances.currency, dep.currency)));
  await ensureCompanyRow(tx, dep.currency);
  await tx.update(companyBalances).set({
    reversedMinor: sql`${companyBalances.reversedMinor} + ${dep.companyFeeMinor}`,
    availableMinor: sql`${companyBalances.availableMinor} - ${dep.companyFeeMinor}`, updatedAt: now,
  }).where(eq(companyBalances.currency, dep.currency));
  await tx.insert(ledgerEntries).values([
    { depositId: dep.id, userId: dep.userId, currency: dep.currency, account: "customer_credit", direction: "debit", kind: "reversal", amountMinor: dep.customerCreditMinor, memo: `Reversal: ${reason}` },
    { depositId: dep.id, userId: null, currency: dep.currency, account: "company_revenue", direction: "debit", kind: "reversal", amountMinor: dep.companyFeeMinor, memo: `Reversal: ${reason}` },
  ]);
  await audit(tx, { actorId: actor?.id, actorEmail: actor?.email, action: `deposit_${status}`, entityType: "deposit", entityId: dep.id, details: { reason } });
  const emails = [
    () => sendEmail(dep.email, templates.depositReversed({ ...updated, kind: status === "refunded" ? "refund" : "reversal" }), "deposit_reversed", dep.id),
    () => sendEmail(adminEmails(), templates.adminSuspicious({ reason: `Deposit ${status}: ${reason}`, details: [["Deposit", dep.id], ["Customer", dep.email], ["Amount", formatMoney(dep.grossMinor, dep.currency)]] }), "admin_reversal", dep.id),
  ];
  return { deposit: updated as Deposit, emails };
}

export async function runEmails(emails: Array<() => Promise<void>>) {
  for (const send of emails) await send();
}
