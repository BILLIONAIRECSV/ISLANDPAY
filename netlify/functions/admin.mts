import type { Config, Context } from "@netlify/functions";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, deposits, companyBalances, customerBalances, ledgerEntries, withdrawals, payoutDestinations, auditLog, emailEvents, webhookEvents,
} from "../../db/index.js";
import { requireAdmin, type AuthUser } from "../../lib/auth.js";
import { assertSameOrigin, error, isUuid, json, readJson } from "../../lib/http.js";
import { audit } from "../../lib/audit.js";
import { depositCurrency } from "../../lib/money.js";
import { adminEmails, sendEmail, templates } from "../../lib/email.js";
import { applyProviderOrder, reverseDepositTx, runEmails } from "../../lib/ledger.js";
import { coinAdmin } from "../../lib/admin-coins.js";
import { banxaCheckoutReady, banxaConfig, banxaWebhookReady, getOrder } from "../../lib/banxa.js";

const destLabel = (d: typeof payoutDestinations.$inferSelect) =>
  d.type === "crypto" ? `${d.label} · ${d.asset} on ${d.network} · ${d.address}` : `${d.label} · ${d.bankName} · ${d.beneficiaryName} · ****${String(d.accountNumber || "").slice(-4)}`;

async function summary() {
  const currency = depositCurrency();
  const [company] = await db.select().from(companyBalances).where(eq(companyBalances.currency, currency));
  const c = company ?? { earnedMinor: 0, reversedMinor: 0, availableMinor: 0, reservedMinor: 0, withdrawnMinor: 0, withdrawalFeesMinor: 0 };

  const wd = await db.select({
    status: withdrawals.status, type: withdrawals.type,
    count: sql<number>`count(*)::int`, amount: sql<number>`coalesce(sum(${withdrawals.amountMinor}),0)::bigint`, fees: sql<number>`coalesce(sum(${withdrawals.feeMinor}),0)::bigint`,
  }).from(withdrawals).where(eq(withdrawals.currency, currency)).groupBy(withdrawals.status, withdrawals.type);
  const sumWd = (f: (r: (typeof wd)[number]) => boolean) => wd.filter(f).reduce((a, r) => a + Number(r.amount), 0);

  const dep = await db.select({
    status: deposits.status, count: sql<number>`count(*)::int`,
    gross: sql<number>`coalesce(sum(${deposits.grossMinor}),0)::bigint`, providerFees: sql<number>`coalesce(sum(${deposits.providerFeeMinor}),0)::bigint`,
  }).from(deposits).where(eq(deposits.currency, currency)).groupBy(deposits.status);
  const depBy = Object.fromEntries(dep.map((r) => [r.status, { count: r.count, grossMinor: Number(r.gross), providerFeesMinor: Number(r.providerFees) }]));
  const providerFeesMinor = Number(depBy.succeeded?.providerFeesMinor ?? 0);
  const companyBearsProviderFees = process.env.PROVIDER_FEES_BORNE_BY_COMPANY === "true";

  // Reconciliation against the immutable ledger.
  const [lc] = await db.select({
    revCredit: sql<number>`coalesce(sum(case when account='company_revenue' and direction='credit' then amount_minor end),0)::bigint`,
    revDebit: sql<number>`coalesce(sum(case when account='company_revenue' and direction='debit' then amount_minor end),0)::bigint`,
    wdDebit: sql<number>`coalesce(sum(case when account='company_withdrawal' then amount_minor end),0)::bigint`,
    feeDebit: sql<number>`coalesce(sum(case when account='withdrawal_fee' then amount_minor end),0)::bigint`,
    custNet: sql<number>`coalesce(sum(case when account='customer_credit' then case when direction='credit' then amount_minor else -amount_minor end end),0)::bigint`,
  }).from(ledgerEntries).where(eq(ledgerEntries.currency, currency));
  const [cb] = await db.select({ total: sql<number>`coalesce(sum(${customerBalances.availableMinor}),0)::bigint` }).from(customerBalances).where(eq(customerBalances.currency, currency));
  const [mismatchedCustomers] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from customer_balances b
    left join (select user_id, sum(case when direction='credit' then amount_minor else -amount_minor end) as net
               from ledger_entries where account='customer_credit' and currency=${currency} group by user_id) l on l.user_id=b.user_id
    where b.currency=${currency} and b.available_minor <> coalesce(l.net,0)`).then((r: any) => r.rows ?? r);

  const ledgerRevenue = Number(lc.revCredit) - Number(lc.revDebit);
  const companyBooks = Number(c.availableMinor) + Number(c.reservedMinor) + Number(c.withdrawnMinor) + Number(c.withdrawalFeesMinor);
  const ledgerCompanyRemaining = ledgerRevenue - Number(lc.wdDebit) - Number(lc.feeDebit);

  return {
    currency,
    revenue: {
      totalEarnedMinor: Number(c.earnedMinor),
      refundsReversalsMinor: Number(c.reversedMinor),
      availableMinor: Number(c.availableMinor),
      reservedForWithdrawalsMinor: Number(c.reservedMinor),
      totalWithdrawnMinor: Number(c.withdrawnMinor),
      withdrawalFeesMinor: Number(c.withdrawalFeesMinor),
      providerFeesMinor,
      companyBearsProviderFees,
      netRevenueMinor: Number(c.earnedMinor) - Number(c.reversedMinor) - Number(c.withdrawalFeesMinor) - (companyBearsProviderFees ? providerFeesMinor : 0),
    },
    withdrawals: {
      pendingMinor: sumWd((r) => ["requested", "approved", "processing"].includes(r.status)),
      paidBankMinor: sumWd((r) => r.status === "paid" && r.type === "bank"),
      paidCryptoMinor: sumWd((r) => r.status === "paid" && r.type === "crypto"),
      failedMinor: sumWd((r) => ["failed", "rejected"].includes(r.status)),
      failedCount: wd.filter((r) => ["failed", "rejected"].includes(r.status)).reduce((a, r) => a + r.count, 0),
    },
    deposits: depBy,
    customers: { totalCreditsOutstandingMinor: Number(cb.total) },
    reconciliation: {
      companyRevenueMatchesLedger: ledgerRevenue === Number(c.earnedMinor) - Number(c.reversedMinor),
      companyBalancesMatchLedger: companyBooks === ledgerRevenue && Number(c.availableMinor) + Number(c.reservedMinor) === ledgerCompanyRemaining,
      customerTotalMatchesLedger: Number(cb.total) === Number(lc.custNet),
      customersWithMismatch: Number(mismatchedCustomers?.n ?? 0),
    },
    integrations: {
      banxaCheckout: banxaCheckoutReady(), banxaWebhook: banxaWebhookReady(), banxaEnvironment: banxaConfig().env,
      webhookPath: banxaConfig().webhookPath,
      email: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM), adminEmailConfigured: adminEmails().length > 0,
    },
  };
}

const TRANSITIONS: Record<string, string[]> = {
  approve: ["requested"], processing: ["approved"], paid: ["approved", "processing"],
  failed: ["requested", "approved", "processing"], reject: ["requested", "approved"],
};
const NEXT: Record<string, string> = { approve: "approved", processing: "processing", paid: "paid", failed: "failed", reject: "rejected" };

async function withdrawalAction(admin: AuthUser, id: string, action: string, body: Record<string, any>) {
  if (!TRANSITIONS[action]) return error(404, "Unknown action");
  const ref = body.providerReference ? String(body.providerReference).trim().slice(0, 200) : null;
  const reason = body.reason ? String(body.reason).trim().slice(0, 500) : null;
  if (action === "paid" && !ref) return error(422, "Enter the bank or blockchain settlement reference confirming the payout.");
  if ((action === "failed" || action === "reject") && !reason) return error(422, "Enter a reason.");

  const out = await db.transaction(async (tx) => {
    const [w] = await tx.select().from(withdrawals).where(eq(withdrawals.id, id)).for("update");
    if (!w) return { err: error(404, "Not found") };
    if (!TRANSITIONS[action].includes(w.status)) return { err: error(409, `Cannot ${action} a withdrawal that is ${w.status}.`) };
    const total = Number(w.amountMinor) + Number(w.feeMinor);
    const now = new Date();
    await tx.insert(companyBalances).values({ currency: w.currency }).onConflictDoNothing();
    await tx.select().from(companyBalances).where(eq(companyBalances.currency, w.currency)).for("update");

    if (action === "failed" || action === "reject") {
      await tx.update(companyBalances).set({ reservedMinor: sql`${companyBalances.reservedMinor} - ${total}`, availableMinor: sql`${companyBalances.availableMinor} + ${total}`, updatedAt: now }).where(eq(companyBalances.currency, w.currency));
    }
    if (action === "paid") {
      await tx.update(companyBalances).set({
        reservedMinor: sql`${companyBalances.reservedMinor} - ${total}`,
        withdrawnMinor: sql`${companyBalances.withdrawnMinor} + ${w.amountMinor}`,
        withdrawalFeesMinor: sql`${companyBalances.withdrawalFeesMinor} + ${w.feeMinor}`, updatedAt: now,
      }).where(eq(companyBalances.currency, w.currency));
      const entries: any[] = [{ withdrawalId: w.id, currency: w.currency, account: "company_withdrawal", direction: "debit", kind: "withdrawal", amountMinor: w.amountMinor, memo: `${w.type} withdrawal settled · ref ${ref}` }];
      if (Number(w.feeMinor) > 0) entries.push({ withdrawalId: w.id, currency: w.currency, account: "withdrawal_fee", direction: "debit", kind: "withdrawal_fee", amountMinor: w.feeMinor, memo: `Withdrawal fee · ref ${ref}` });
      await tx.insert(ledgerEntries).values(entries);
    }
    const [updated] = await tx.update(withdrawals).set({
      status: NEXT[action], updatedAt: now,
      ...(action === "approve" ? { approvedBy: admin.email } : {}),
      ...(ref ? { providerReference: ref } : {}),
      ...(reason ? { failureReason: reason } : {}),
      ...(action === "paid" ? { completedAt: now } : {}),
    }).where(eq(withdrawals.id, w.id)).returning();
    await audit(tx, { actorId: admin.id, actorEmail: admin.email, action: `withdrawal_${NEXT[action]}`, entityType: "withdrawal", entityId: w.id, details: { from: w.status, ref, reason } });
    return { updated };
  });
  if ("err" in out) return out.err;
  const w = out.updated!;
  const [dest] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, w.destinationId));
  await sendEmail(adminEmails(), templates.adminWithdrawal({ status: w.status, id: w.id, amountMinor: w.amountMinor, feeMinor: w.feeMinor, currency: w.currency, destination: dest ? destLabel(dest) : "—", actor: admin.email, reference: w.providerReference }), `admin_withdrawal_${w.status}`, w.id);
  return json({ withdrawal: w });
}

export default async (req: Request, context: Context) => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { resource, id, action } = context.params ?? {};
  const isWrite = req.method !== "GET";
  if (isWrite) {
    const bad = assertSameOrigin(req);
    if (bad) return bad;
  }
  const body = isWrite ? await readJson(req) : {};
  const url = new URL(req.url);

  switch (resource) {
    case "summary":
      return json(await summary());

    case "deposits": {
      if (!id && !isWrite) {
        const status = url.searchParams.get("status");
        const q = db.select().from(deposits);
        const rows = await (status ? q.where(eq(deposits.status, status)) : q).orderBy(desc(deposits.createdAt)).limit(300);
        return json({ deposits: rows });
      }
      if (!isUuid(id)) return error(404, "Not found");
      if (action === "reverse" && req.method === "POST") {
        const reason = String(body.reason || "").trim().slice(0, 500);
        const kind = body.kind === "refunded" ? "refunded" : "reversed";
        if (!reason) return error(422, "Enter a reason (e.g. chargeback reference).");
        if (body.confirm !== true) return error(422, "Confirmation required.");
        const res = await db.transaction(async (tx) => {
          const [dep] = await tx.select().from(deposits).where(eq(deposits.id, id!)).for("update");
          if (!dep) return { err: error(404, "Not found") };
          if (dep.status !== "succeeded") return { err: error(409, `Only succeeded deposits can be reversed (current: ${dep.status}).`) };
          return reverseDepositTx(tx, dep, kind, reason, admin);
        });
        if ("err" in res) return res.err;
        context.waitUntil(runEmails(res.emails));
        return json({ deposit: res.deposit });
      }
      if (action === "refresh" && req.method === "POST") {
        const [dep] = await db.select().from(deposits).where(eq(deposits.id, id!));
        if (!dep?.providerOrderId) return error(409, "No provider order for this deposit.");
        const out = await applyProviderOrder(await getOrder(dep.providerOrderId), `admin_refresh:${admin.email}`);
        context.waitUntil(runEmails(out.emails));
        return json({ result: out.result });
      }
      return error(405, "Method not allowed");
    }

    case "destinations": {
      if (!id && !isWrite) return json({ destinations: await db.select().from(payoutDestinations).orderBy(desc(payoutDestinations.createdAt)) });
      if (!id && req.method === "POST") {
        const type = body.type;
        const s = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
        const label = s(body.label, 80);
        if (!["bank", "crypto"].includes(type) || !label) return error(422, "Choose bank or crypto and enter a label.");
        const values: any = { type, label, currency: depositCurrency(), createdBy: admin.email };
        if (type === "bank") {
          Object.assign(values, { beneficiaryName: s(body.beneficiaryName), bankName: s(body.bankName), accountNumber: s(body.accountNumber, 64).replace(/\s+/g, ""), swift: s(body.swift, 11).toUpperCase() });
          if (!values.beneficiaryName || !values.bankName || values.accountNumber.length < 4) return error(422, "Enter the company beneficiary name, bank and account/IBAN.");
          if (values.swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(values.swift)) return error(422, "SWIFT/BIC must be 8 or 11 characters.");
        } else {
          Object.assign(values, { asset: s(body.asset, 10).toUpperCase(), network: s(body.network, 30), address: s(body.address, 120) });
          if (!values.asset || !values.network || values.address.length < 20) return error(422, "Enter the asset, network and full wallet address.");
        }
        const [d] = await db.insert(payoutDestinations).values(values).returning();
        await audit(null, { actorId: admin.id, actorEmail: admin.email, action: "destination_created", entityType: "payout_destination", entityId: d.id, details: { type, label } });
        return json({ destination: d }, 201);
      }
      if (isUuid(id) && action === "verify" && req.method === "POST") {
        const [d] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, id!));
        if (!d) return error(404, "Not found");
        const secret = String(d.type === "crypto" ? d.address : d.accountNumber);
        if (String(body.confirmLast6 || "").trim() !== secret.slice(-6)) return error(422, "The last 6 characters do not match. Destination not verified.");
        const [v] = await db.update(payoutDestinations).set({ verifiedBy: admin.email, verifiedAt: new Date() }).where(eq(payoutDestinations.id, d.id)).returning();
        await audit(null, { actorId: admin.id, actorEmail: admin.email, action: "destination_verified", entityType: "payout_destination", entityId: d.id });
        return json({ destination: v });
      }
      if (isUuid(id) && action === "disable" && req.method === "POST") {
        const [v] = await db.update(payoutDestinations).set({ disabled: true }).where(eq(payoutDestinations.id, id!)).returning();
        await audit(null, { actorId: admin.id, actorEmail: admin.email, action: "destination_disabled", entityType: "payout_destination", entityId: id });
        return json({ destination: v });
      }
      return error(405, "Method not allowed");
    }

    case "withdrawals": {
      if (!id && !isWrite) {
        const rows = await db.select().from(withdrawals).orderBy(desc(withdrawals.createdAt)).limit(300);
        const dests = await db.select().from(payoutDestinations);
        return json({ withdrawals: rows.map((w) => ({ ...w, destination: (() => { const d = dests.find((x) => x.id === w.destinationId); return d ? destLabel(d) : "—"; })() })) });
      }
      if (!id && req.method === "POST") {
        const amountMinor = Number(body.amountMinor);
        const feeMinor = Number(body.feeMinor || 0);
        const key = String(body.idempotencyKey || "");
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return error(422, "Enter a valid amount.");
        if (!Number.isSafeInteger(feeMinor) || feeMinor < 0) return error(422, "Enter a valid fee.");
        if (!isUuid(key)) return error(422, "Missing request key.");
        if (!isUuid(body.destinationId)) return error(422, "Choose a destination.");
        if (body.confirmDestination !== true) return error(422, "Please review and confirm the destination.");
        const res = await db.transaction(async (tx) => {
          const [dup] = await tx.select().from(withdrawals).where(eq(withdrawals.idempotencyKey, key));
          if (dup) return { withdrawal: dup, duplicate: true };
          const [d] = await tx.select().from(payoutDestinations).where(eq(payoutDestinations.id, body.destinationId));
          if (!d || d.disabled) return { err: error(422, "Destination not available.") };
          if (!d.verifiedAt) return { err: error(422, "Destination must be verified before use.") };
          await tx.insert(companyBalances).values({ currency: d.currency }).onConflictDoNothing();
          const [bal] = await tx.select().from(companyBalances).where(eq(companyBalances.currency, d.currency)).for("update");
          const total = amountMinor + feeMinor;
          if (Number(bal.availableMinor) < total) return { err: error(422, "Amount plus fee exceeds the available company balance.") };
          await tx.update(companyBalances).set({ availableMinor: sql`${companyBalances.availableMinor} - ${total}`, reservedMinor: sql`${companyBalances.reservedMinor} + ${total}`, updatedAt: new Date() }).where(eq(companyBalances.currency, d.currency));
          const [w] = await tx.insert(withdrawals).values({ idempotencyKey: key, destinationId: d.id, type: d.type, currency: d.currency, amountMinor, feeMinor, requestedBy: admin.id, requestedByEmail: admin.email }).returning();
          await audit(tx, { actorId: admin.id, actorEmail: admin.email, action: "withdrawal_requested", entityType: "withdrawal", entityId: w.id, details: { amountMinor, feeMinor, destination: destLabel(d) } });
          return { withdrawal: w, dest: d };
        });
        if ("err" in res) return res.err;
        if (!res.duplicate && res.dest) {
          const w = res.withdrawal;
          await sendEmail(adminEmails(), templates.adminWithdrawal({ status: "requested", id: w.id, amountMinor: w.amountMinor, feeMinor: w.feeMinor, currency: w.currency, destination: destLabel(res.dest), actor: admin.email }), "admin_withdrawal_requested", w.id);
        }
        return json({ withdrawal: res.withdrawal, duplicate: Boolean(res.duplicate) }, res.duplicate ? 200 : 201);
      }
      if (isUuid(id) && action && req.method === "POST") return withdrawalAction(admin, id!, action, body);
      return error(405, "Method not allowed");
    }

    case "ledger":
      return json({ entries: await db.select().from(ledgerEntries).orderBy(desc(ledgerEntries.id)).limit(500) });
    case "audit":
      return json({ entries: await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(300) });
    case "emails":
      return json({ entries: await db.select().from(emailEvents).orderBy(desc(emailEvents.createdAt)).limit(200) });
    case "webhooks":
      return json({ entries: await db.select({ id: webhookEvents.id, eventKey: webhookEvents.eventKey, result: webhookEvents.result, createdAt: webhookEvents.createdAt, processedAt: webhookEvents.processedAt }).from(webhookEvents).orderBy(desc(webhookEvents.createdAt)).limit(200) });
  }
  const extra = await coinAdmin(admin, req, resource!, id, action, body, url);
  if (extra) return extra;
  return error(404, "Not found");
};

export const config: Config = { path: ["/api/admin/:resource", "/api/admin/:resource/:id", "/api/admin/:resource/:id/:action"] };
