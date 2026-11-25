import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, coinOrders, cryptoRedemptions, cryptoReserveMovements, customerBalances, deposits, ledgerEntries, profiles } from "../db/index.js";
import type { AuthUser } from "./auth.js";
import { error, json } from "./http.js";
import { audit } from "./audit.js";
import { COIN, lockCoinBalance, moveCoins, reverseCoinOrder } from "./coins.js";
import { cryptoConfig, decimalsOf, formatBase, networkOf, validateTxHash, verifyOnChain } from "./crypto.js";
import { cxpayConfig, cxpayReady, cxpayWebhookReady } from "./cxpay.js";

const n = (v: unknown) => Number(v ?? 0);

async function reserves() {
  const rows = await db.select({ asset: cryptoReserveMovements.asset, network: cryptoReserveMovements.network,
    inU: sql<number>`coalesce(sum(case when direction='in' then base_units end),0)::bigint`, outU: sql<number>`coalesce(sum(case when direction='out' then base_units end),0)::bigint` })
    .from(cryptoReserveMovements).groupBy(cryptoReserveMovements.asset, cryptoReserveMovements.network);
  return rows.map((r) => ({ asset: r.asset, network: r.network, inUnits: n(r.inU), outUnits: n(r.outU), balanceUnits: n(r.inU) - n(r.outU), balance: formatBase(n(r.inU) - n(r.outU), r.asset) }));
}
async function reserveBalance(tx: any, asset: string, network: string) {
  const [r] = await tx.select({ b: sql<number>`coalesce(sum(case when direction='in' then base_units else -base_units end),0)::bigint` }).from(cryptoReserveMovements)
    .where(and(eq(cryptoReserveMovements.asset, asset), eq(cryptoReserveMovements.network, network)));
  return n(r?.b);
}

export async function coinSummary() {
  const [L] = await db.select({
    issued: sql<number>`coalesce(sum(case when kind='coin_purchase' then amount_minor end),0)::bigint`,
    spent: sql<number>`coalesce(sum(case when kind='crypto_redemption' then amount_minor end),0)::bigint`,
    returned: sql<number>`coalesce(sum(case when kind='redemption_refund' then amount_minor end),0)::bigint`,
    reversed: sql<number>`coalesce(sum(case when kind='coin_refund' then amount_minor end),0)::bigint`,
    net: sql<number>`coalesce(sum(case when direction='credit' then amount_minor else -amount_minor end),0)::bigint`,
  }).from(ledgerEntries).where(eq(ledgerEntries.currency, COIN));
  const [B] = await db.select({ t: sql<number>`coalesce(sum(available_minor),0)::bigint` }).from(customerBalances).where(eq(customerBalances.currency, COIN));
  const orders = await db.select({ status: coinOrders.status, test: coinOrders.testMode, c: sql<number>`count(*)::int`, amt: sql<number>`coalesce(sum(amount_minor),0)::bigint`, fee: sql<number>`coalesce(sum(provider_fee_minor),0)::bigint`, ref: sql<number>`coalesce(sum(refunded_minor),0)::bigint`, method: coinOrders.method })
    .from(coinOrders).groupBy(coinOrders.status, coinOrders.testMode, coinOrders.method);
  const settledStatuses = ["paid", "refunded", "review"];
  const pick = (test: boolean) => {
    const rs = orders.filter((o) => o.test === test && settledStatuses.includes(o.status));
    const gross = rs.reduce((a, r) => a + n(r.amt), 0), fees = rs.reduce((a, r) => a + n(r.fee), 0), refunds = rs.reduce((a, r) => a + n(r.ref), 0);
    return { cardMinor: rs.filter((r) => r.method === "card").reduce((a, r) => a + n(r.amt), 0), bankMinor: rs.filter((r) => r.method === "bank").reduce((a, r) => a + n(r.amt), 0), grossMinor: gross, processingFeesMinor: fees, refundsMinor: refunds, netSettlementMinor: gross - fees - refunds };
  };
  const reds = await db.select({ status: cryptoRedemptions.status, asset: cryptoRedemptions.asset, c: sql<number>`count(*)::int`, units: sql<number>`coalesce(sum(crypto_base_units),0)::bigint`, coins: sql<number>`coalesce(sum(coins),0)::bigint`, fee: sql<number>`coalesce(sum(service_fee_minor),0)::bigint` })
    .from(cryptoRedemptions).groupBy(cryptoRedemptions.status, cryptoRedemptions.asset);
  const by = (st: string[], asset: string) => reds.filter((r) => st.includes(r.status) && r.asset === asset).reduce((a, r) => a + n(r.units), 0);
  const cnt = (st: string[]) => reds.filter((r) => st.includes(r.status)).reduce((a, r) => a + r.c, 0);
  const c = cxpayConfig(), cc = cryptoConfig();
  return {
    coins: { issued: n(L.issued), spent: n(L.spent) - n(L.returned), returnedFromFailed: n(L.returned), reversedByRefunds: n(L.reversed), outstanding: n(B.t), outstandingUsdLiabilityMinor: n(B.t) * 10, ledgerMatches: n(B.t) === n(L.net) },
    cash: { live: pick(false), test: pick(true), failedOrders: orders.filter((o) => o.status === "failed").reduce((a, r) => a + r.c, 0), reviewOrders: orders.filter((o) => o.status === "review").reduce((a, r) => a + r.c, 0) },
    crypto: {
      purchased: { USDT: formatBase(by(["pending", "processing", "completed"], "USDT"), "USDT"), BTC: formatBase(by(["pending", "processing", "completed"], "BTC"), "BTC") },
      delivered: { USDT: formatBase(by(["completed"], "USDT"), "USDT"), BTC: formatBase(by(["completed"], "BTC"), "BTC") },
      owedPending: { USDT: formatBase(by(["pending", "processing"], "USDT"), "USDT"), BTC: formatBase(by(["pending", "processing"], "BTC"), "BTC") },
      pendingCount: cnt(["pending", "processing"]), failedCount: cnt(["failed"]), refundedCount: cnt(["refunded"]),
      serviceFeesEarnedMinor: reds.filter((r) => r.status === "completed").reduce((a, r) => a + n(r.fee), 0),
      reserves: await reserves(),
    },
    config: { cardReady: cxpayReady(), cardWebhook: cxpayWebhookReady(), cardMode: c.production ? "production" : "test", bankReady: false, cryptoMode: cc.mode, fulfillment: cc.fulfillment },
  };
}

const TR: Record<string, { from: string[]; to: string }> = {
  processing: { from: ["pending"], to: "processing" }, complete: { from: ["pending", "processing"], to: "completed" },
  fail: { from: ["pending", "processing"], to: "failed" }, refund: { from: ["pending", "processing"], to: "refunded" },
};

async function redemptionAction(admin: AuthUser, id: string, action: string, body: any) {
  const t = TR[action];
  if (!t) return error(404, "Unknown action");
  const reason = String(body.reason || "").trim().slice(0, 500);
  const txHash = String(body.txHash || "").trim();
  const fref = body.fulfillmentReference ? String(body.fulfillmentReference).trim().slice(0, 200) : null;
  if ((action === "fail" || action === "refund") && !reason) return error(422, "Enter a reason.");
  let verification: string | null = null;
  if (action === "complete") {
    const [r0] = await db.select().from(cryptoRedemptions).where(eq(cryptoRedemptions.id, id));
    if (!r0) return error(404, "Not found");
    if (!validateTxHash(r0.network, txHash)) return error(422, `Enter the real ${r0.network} transaction hash for this transfer.`);
    const v = await verifyOnChain(r0, txHash);
    if (v && !v.ok) return error(422, `Blockchain verification failed: ${v.detail}`);
    if (!v && body.attest !== true) return error(422, "Automatic verification is not available for this network. Confirm you verified the transaction on a block explorer (correct wallet, amount, confirmed).");
    verification = v ? v.detail : `manual: ${admin.email} attested explorer verification`;
  }
  const out = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(cryptoRedemptions).where(eq(cryptoRedemptions.id, id)).for("update");
    if (!r) return { err: error(404, "Not found") };
    if (!t.from.includes(r.status)) return { err: error(409, `Cannot ${action} a redemption that is ${r.status}.`) };
    const now = new Date();
    if (action === "complete") {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"reserve:" + r.asset + ":" + r.network}))`);
      const bal = await reserveBalance(tx, r.asset, r.network);
      if (bal < r.cryptoBaseUnits) return { err: error(422, `Recorded ${r.asset} ${r.network} reserves (${formatBase(bal, r.asset)}) are lower than this delivery. Record the reserve funding first.`) };
      await tx.insert(cryptoReserveMovements).values({ asset: r.asset, network: r.network, direction: "out", baseUnits: r.cryptoBaseUnits, redemptionId: r.id, txHash, memo: `Delivered ${r.reference}`, actorEmail: admin.email });
    }
    if (action === "fail" || action === "refund") {
      await lockCoinBalance(tx, r.userId);
      await moveCoins(tx, { userId: r.userId, delta: r.coins, kind: "redemption_refund", memo: `${r.reference} ${t.to}: coins returned · ${reason}`, withdrawalId: r.id });
    }
    const [u] = await tx.update(cryptoRedemptions).set({
      status: t.to, updatedAt: now, handledBy: admin.email,
      ...(fref ? { fulfillmentReference: fref } : {}), ...(reason ? { failureReason: reason } : {}),
      ...(action === "complete" ? { txHash, verification, completedAt: now } : {}),
    }).where(eq(cryptoRedemptions.id, r.id)).returning();
    await audit(tx, { actorId: admin.id, actorEmail: admin.email, action: `crypto_redemption_${t.to}`, entityType: "crypto_redemption", entityId: r.id, details: { from: r.status, txHash: txHash || null, verification, reason: reason || null } });
    return { u };
  });
  if ("err" in out) return out.err!;
  return json({ redemption: out.u });
}

/** Handles the IP Coin / crypto admin resources. Returns null for unknown resources. */
export async function coinAdmin(admin: AuthUser, req: Request, resource: string, id: string | undefined, action: string | undefined, body: any, url: URL): Promise<Response | null> {
  const isWrite = req.method !== "GET";
  switch (resource) {
    case "coins": return json(await coinSummary());
    case "coin-orders": {
      if (!id && !isWrite) return json({ orders: await db.select().from(coinOrders).orderBy(desc(coinOrders.createdAt)).limit(300) });
      if (id && action === "refund" && req.method === "POST") {
        const reason = String(body.reason || "").trim();
        if (!reason || body.confirm !== true) return error(422, "Enter the refund reason and confirm. Issue the refund in the CX Pay portal first.");
        return json(await reverseCoinOrder(id, reason, admin));
      }
      return error(405, "Method not allowed");
    }
    case "redemptions": {
      if (!id && !isWrite) {
        const st = url.searchParams.get("status");
        const q = db.select().from(cryptoRedemptions);
        const rows = await (st ? q.where(eq(cryptoRedemptions.status, st)) : q).orderBy(desc(cryptoRedemptions.createdAt)).limit(300);
        return json({ redemptions: rows.map((r) => ({ ...r, cryptoAmount: formatBase(r.cryptoBaseUnits, r.asset) })) });
      }
      if (id && action && req.method === "POST") return redemptionAction(admin, id, action, body);
      return error(405, "Method not allowed");
    }
    case "reserves": {
      if (!isWrite) return json({ reserves: await reserves(), movements: await db.select().from(cryptoReserveMovements).orderBy(desc(cryptoReserveMovements.id)).limit(200) });
      const asset = String(body.asset), network = String(body.network), amount = String(body.amount || "").trim();
      if (!networkOf(asset, network)) return error(422, "Choose asset and network.");
      const d = decimalsOf(asset as any);
      if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${d}})?$`).test(amount)) return error(422, `Enter an amount with up to ${d} decimals.`);
      const [w, f = ""] = amount.split(".");
      const units = Number(w) * 10 ** d + Number((f + "0".repeat(d)).slice(0, d));
      const memo = String(body.memo || "").trim().slice(0, 300);
      const txHash = String(body.txHash || "").trim() || null;
      if (!memo) return error(422, "Describe the source (e.g. exchange purchase reference / custody account).");
      if (units <= 0) return error(422, "Amount must be positive.");
      const [m] = await db.insert(cryptoReserveMovements).values({ asset, network, direction: body.direction === "out" ? "out" : "in", baseUnits: units, txHash, memo, actorEmail: admin.email }).returning();
      await audit(null, { actorId: admin.id, actorEmail: admin.email, action: "crypto_reserve_recorded", entityType: "crypto_reserve", entityId: String(m.id), details: { asset, network, amount, direction: m.direction, txHash } });
      return json({ movement: m }, 201);
    }
    case "customers": {
      if (!id) {
        const q = `%${(url.searchParams.get("q") || "").trim().slice(0, 100)}%`;
        const rows = await db.select().from(profiles).where(or(ilike(profiles.email, q), ilike(profiles.fullName, q), ilike(profiles.userId, q))).orderBy(desc(profiles.createdAt)).limit(50);
        const bals = await db.select().from(customerBalances);
        return json({ customers: rows.map((p) => ({ ...p, coins: n(bals.find((b) => b.userId === p.userId && b.currency === COIN)?.availableMinor), credits: n(bals.find((b) => b.userId === p.userId && b.currency !== COIN)?.availableMinor) })) });
      }
      const [p] = await db.select().from(profiles).where(eq(profiles.userId, id));
      if (!p) return error(404, "Not found");
      return json({
        profile: p, balances: await db.select().from(customerBalances).where(eq(customerBalances.userId, id)),
        coinOrders: await db.select().from(coinOrders).where(eq(coinOrders.userId, id)).orderBy(desc(coinOrders.createdAt)),
        redemptions: (await db.select().from(cryptoRedemptions).where(eq(cryptoRedemptions.userId, id)).orderBy(desc(cryptoRedemptions.createdAt))).map((r) => ({ ...r, cryptoAmount: formatBase(r.cryptoBaseUnits, r.asset) })),
        deposits: await db.select().from(deposits).where(eq(deposits.userId, id)).orderBy(desc(deposits.createdAt)),
        ledger: await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, id)).orderBy(desc(ledgerEntries.id)).limit(300),
      });
    }
  }
  return null;
}
