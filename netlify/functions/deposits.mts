import type { Config, Context } from "@netlify/functions";
import { and, desc, eq } from "drizzle-orm";
import { db, deposits, ledgerEntries } from "../../db/index.js";
import { requireUser } from "../../lib/auth.js";
import { assertSameOrigin, error, isUuid, json, readJson, siteUrl } from "../../lib/http.js";
import { depositCurrency, maxDepositMinor, minDepositMinor, splitDeposit } from "../../lib/money.js";
import { banxaCheckoutReady, createBuyOrder, getOrder, PROVIDER } from "../../lib/banxa.js";
import { applyProviderOrder, runEmails } from "../../lib/ledger.js";
import { audit } from "../../lib/audit.js";

const publicDeposit = (d: typeof deposits.$inferSelect) => ({
  id: d.id, provider: d.provider, providerOrderId: d.providerOrderId, currency: d.currency,
  grossMinor: d.grossMinor, companyFeeMinor: d.companyFeeMinor, customerCreditMinor: d.customerCreditMinor,
  status: d.status, providerStatus: d.providerStatus, settlementStatus: d.settlementStatus,
  checkoutUrl: ["created", "pending"].includes(d.status) ? d.checkoutUrl : null,
  cryptoAsset: d.cryptoAsset, cryptoAmount: d.cryptoAmount, transactionHash: d.transactionHash,
  failureReason: d.failureReason, createdAt: d.createdAt, succeededAt: d.succeededAt, reversedAt: d.reversedAt, email: d.email,
});

export default async (req: Request, context: Context) => {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const id = context.params?.id;
  const action = context.params?.action;

  // --- list own deposits ---
  if (!id && req.method === "GET") {
    const rows = await db.select().from(deposits).where(eq(deposits.userId, user.id)).orderBy(desc(deposits.createdAt)).limit(200);
    return json({ deposits: rows.map(publicDeposit) });
  }

  // --- create deposit + Banxa checkout ---
  if (!id && req.method === "POST") {
    const bad = assertSameOrigin(req);
    if (bad) return bad;
    const body = await readJson(req);
    const grossMinor = Number(body.amountMinor);
    const idempotencyKey = String(body.idempotencyKey || "");
    if (!Number.isSafeInteger(grossMinor)) return error(422, "Invalid amount.");
    if (grossMinor < minDepositMinor() || grossMinor > maxDepositMinor()) return error(422, "Amount is outside the allowed range.");
    if (!isUuid(idempotencyKey)) return error(422, "Missing request key. Refresh and try again.");
    if (body.acceptFee !== true) return error(422, "Please confirm the 8.88% Island Pay fee before paying.");
    if (!banxaCheckoutReady()) {
      return error(503, "Card and bank payments are not enabled yet. No payment was taken and no credits were created.", { code: "provider_not_configured" });
    }

    const [existing] = await db.select().from(deposits).where(and(eq(deposits.userId, user.id), eq(deposits.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.checkoutUrl) return json({ deposit: publicDeposit(existing), checkoutUrl: existing.checkoutUrl });
      return error(409, "This payment request is already being processed.");
    }

    const currency = depositCurrency();
    const split = splitDeposit(grossMinor); // server-side calculation; client figures are never trusted
    const [dep] = await db.insert(deposits).values({
      userId: user.id, email: user.email, provider: PROVIDER, idempotencyKey, currency, ...split, status: "created",
    }).returning();

    try {
      const order = await createBuyOrder({
        depositId: dep.id, userId: user.id, email: user.email, grossMinor, currency,
        redirectUrl: `${siteUrl(req)}/#receipt/${dep.id}`, ip: context.ip, originalUrl: `${siteUrl(req)}/#buy`,
      });
      const [updated] = await db.update(deposits).set({ providerOrderId: order.orderId, checkoutUrl: order.checkoutUrl, status: "pending", updatedAt: new Date() })
        .where(eq(deposits.id, dep.id)).returning();
      await audit(null, { actorId: user.id, actorEmail: user.email, action: "deposit_created", entityType: "deposit", entityId: dep.id, details: { ...split, currency, banxaOrder: order.orderId } });
      return json({ deposit: publicDeposit(updated), checkoutUrl: order.checkoutUrl }, 201);
    } catch (e: any) {
      await db.update(deposits).set({ status: "failed", failureReason: `Checkout could not be created: ${String(e?.message || e).slice(0, 300)}`, updatedAt: new Date() }).where(eq(deposits.id, dep.id));
      await audit(null, { actorId: user.id, actorEmail: user.email, action: "deposit_checkout_failed", entityType: "deposit", entityId: dep.id, details: { message: String(e?.message || e) } });
      return error(502, "The payment provider could not start checkout. No payment was taken. Please try again later.");
    }
  }

  if (!isUuid(id)) return error(404, "Not found");
  const [dep] = await db.select().from(deposits).where(eq(deposits.id, id!));
  // Customers can only see their own deposits; admins can see any.
  if (!dep || (dep.userId !== user.id && !user.isAdmin)) return error(404, "Not found");

  // --- receipt ---
  if (!action && req.method === "GET") {
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.depositId, dep.id)).orderBy(ledgerEntries.id);
    return json({
      deposit: publicDeposit(dep),
      ledger: entries.filter((e) => user.isAdmin || e.account === "customer_credit")
        .map((e) => ({ id: e.id, account: e.account, direction: e.direction, kind: e.kind, amountMinor: e.amountMinor, memo: e.memo, createdAt: e.createdAt })),
    });
  }

  // --- refresh status from Banxa (authoritative lookup; same idempotent path as webhooks) ---
  if (action === "refresh" && req.method === "POST") {
    const bad = assertSameOrigin(req);
    if (bad) return bad;
    if (!dep.providerOrderId || !banxaCheckoutReady()) return json({ deposit: publicDeposit(dep), result: "no_provider_order" });
    if (["succeeded", "refunded", "reversed"].includes(dep.status)) return json({ deposit: publicDeposit(dep), result: "final" });
    try {
      const order = await getOrder(dep.providerOrderId);
      const out = await applyProviderOrder(order, "customer_refresh");
      context.waitUntil(runEmails(out.emails));
      const [fresh] = await db.select().from(deposits).where(eq(deposits.id, dep.id));
      return json({ deposit: publicDeposit(fresh), result: out.result });
    } catch (e: any) {
      return error(502, "Could not reach the payment provider. Your payment status will update automatically.");
    }
  }

  return error(405, "Method not allowed");
};

export const config: Config = { path: ["/api/deposits", "/api/deposits/:id", "/api/deposits/:id/:action"] };
