import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, coinOrders, cryptoQuotes, cryptoRedemptions, customerBalances } from "../../db/index.js";
import { requireUser } from "../../lib/auth.js";
import { assertSameOrigin, error, isUuid, json, readJson } from "../../lib/http.js";
import { audit } from "../../lib/audit.js";
import { COIN, PACKAGES, coinsToUsdMinor, lockCoinBalance, moveCoins } from "../../lib/coins.js";
import { CXPAY, cxpayConfig, cxpayReady, cxpaySale, estimateCardFee } from "../../lib/cxpay.js";
import { NETWORKS, cryptoConfig, decimalsOf, formatBase, liveRates, networkOf, validateAddress, type Asset } from "../../lib/crypto.js";
import { adminEmails, sendEmail, templates } from "../../lib/email.js";

const ref = () => "IPX-" + randomBytes(6).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "X").slice(0, 8);
const pubOrder = (o: typeof coinOrders.$inferSelect) => ({ id: o.id, packageId: o.packageId, amountMinor: o.amountMinor, coins: o.coins, status: o.status, method: o.method, testMode: o.testMode, providerTransactionId: o.providerTransactionId, failureReason: o.failureReason, createdAt: o.createdAt, paidAt: o.paidAt });
const pubRed = (r: typeof cryptoRedemptions.$inferSelect) => ({ ...r, cryptoAmount: formatBase(r.cryptoBaseUnits, r.asset), userId: undefined, idempotencyKey: undefined, handledBy: undefined });

export default async (req: Request, context: Context) => {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const action = context.params?.action ?? "";
  if (req.method !== "GET") { const bad = assertSameOrigin(req); if (bad) return bad; }
  const body = req.method === "POST" ? await readJson(req) : {};
  const cc = cryptoConfig();

  if (req.method === "GET" && !action) {
    const [bal] = await db.select().from(customerBalances).where(and(eq(customerBalances.userId, user.id), eq(customerBalances.currency, COIN)));
    const orders = await db.select().from(coinOrders).where(eq(coinOrders.userId, user.id)).orderBy(desc(coinOrders.createdAt)).limit(100);
    const reds = await db.select().from(cryptoRedemptions).where(eq(cryptoRedemptions.userId, user.id)).orderBy(desc(cryptoRedemptions.createdAt)).limit(100);
    const c = cxpayConfig();
    return json({
      coins: Number(bal?.availableMinor ?? 0), coinsPerUsd: 10, packages: PACKAGES,
      card: { provider: "CX Pay (Aruba Bank)", ready: cxpayReady(), testMode: !c.production, tokenizationKey: cxpayReady() ? c.tokenizationKey : null, collectJsUrl: `${c.baseUrl}/token/Collect.js` },
      bank: { provider: "Sentoo", ready: false },
      crypto: { mode: cc.mode, networks: NETWORKS, serviceFeeBps: cc.serviceFeeBps, networkFeeMinor: cc.networkFeeMinor, minCoins: cc.minCoins, maxCoins: cc.maxCoins },
      orders: orders.map(pubOrder), redemptions: reds.map(pubRed),
    });
  }

  // ---- buy an IP Coin package by card (CX Pay). Coins credited only on an approved server-side sale. ----
  if (req.method === "POST" && action === "purchase") {
    const pkg = PACKAGES.find((p) => p.id === body.packageId);
    const key = String(body.idempotencyKey || "");
    const token = String(body.paymentToken || "");
    if (!pkg) return error(422, "Choose a coin package.");
    if (!isUuid(key)) return error(422, "Missing request key. Refresh and try again.");
    if (!cxpayReady()) return error(503, "Card payments are not enabled yet. No payment was taken.", { code: "provider_not_configured" });
    if (!/^[\w-]{8,200}$/.test(token)) return error(422, "Card details were not captured. Please try again.");
    const c = cxpayConfig();

    await db.insert(coinOrders).values({ userId: user.id, email: user.email, provider: CXPAY, method: "card", packageId: pkg.id, idempotencyKey: key, amountMinor: pkg.amountMinor, coins: pkg.coins, testMode: !c.production, status: "created" }).onConflictDoNothing();
    // Claim the order atomically: only one request per idempotency key may charge the card.
    const [order] = await db.update(coinOrders).set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(coinOrders.userId, user.id), eq(coinOrders.idempotencyKey, key), eq(coinOrders.status, "created"))).returning();
    if (!order) {
      const [ex] = await db.select().from(coinOrders).where(and(eq(coinOrders.userId, user.id), eq(coinOrders.idempotencyKey, key)));
      return ex?.status === "paid" ? json({ order: pubOrder(ex), duplicate: true }) : error(409, "This payment is already being processed.");
    }
    if (order.packageId !== pkg.id) return error(409, "Request key reused for a different package.");

    let sale;
    try { sale = await cxpaySale({ token, amountMinor: pkg.amountMinor, currency: "USD", orderId: order.id, email: user.email, description: `Island Pay ${pkg.coins} IP Coins` }); }
    catch (e: any) {
      // Outcome unknown (network error) — hold for review instead of failing, so a possibly-captured payment is reconciled manually.
      await db.update(coinOrders).set({ status: "review", failureReason: `Gateway unreachable: ${String(e?.message || e).slice(0, 200)}`, updatedAt: new Date() }).where(eq(coinOrders.id, order.id));
      await audit(null, { actorId: user.id, actorEmail: user.email, action: "coin_order_gateway_error", entityType: "coin_order", entityId: order.id });
      return error(502, "We could not confirm the payment with the card processor. Our team will review it; you will not be charged twice.");
    }
    if (!sale.approved || !sale.transactionId || (sale.orderId && sale.orderId !== order.id)) {
      const [f] = await db.update(coinOrders).set({ status: "failed", providerResponse: `${sale.response}:${sale.code}`, providerTransactionId: sale.transactionId, failureReason: sale.text || "Declined", updatedAt: new Date() }).where(eq(coinOrders.id, order.id)).returning();
      await audit(null, { actorId: user.id, actorEmail: user.email, action: "coin_order_declined", entityType: "coin_order", entityId: order.id, details: { response: sale.response, code: sale.code } });
      return error(402, `Payment declined: ${sale.text || "please use another card"}. No coins were added.`, { order: pubOrder(f) });
    }
    const paid = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(coinOrders).where(eq(coinOrders.id, order.id)).for("update");
      if (o.status === "paid") return o;
      await lockCoinBalance(tx, user.id);
      await moveCoins(tx, { userId: user.id, delta: o.coins, kind: "coin_purchase", memo: `${o.coins} IP Coins purchased · CX Pay ${sale.transactionId}${o.testMode ? " (TEST)" : ""}`, depositId: o.id });
      const [u] = await tx.update(coinOrders).set({ status: "paid", paidAt: new Date(), updatedAt: new Date(), providerTransactionId: sale.transactionId, providerResponse: `${sale.response}:${sale.code}`, providerFeeMinor: estimateCardFee(o.amountMinor) }).where(eq(coinOrders.id, o.id)).returning();
      await audit(tx, { actorId: user.id, actorEmail: user.email, action: "coin_order_paid", entityType: "coin_order", entityId: o.id, details: { coins: o.coins, amountMinor: o.amountMinor, tx: sale.transactionId, testMode: o.testMode } });
      return u;
    });
    return json({ order: pubOrder(paid) }, 201);
  }

  // ---- crypto: server-side quote (locks live rate + fees for 2 minutes) ----
  if (req.method === "POST" && action === "quote") {
    if (cc.mode === "off") return error(503, "The crypto shop is currently unavailable.");
    const asset = String(body.asset) as Asset, network = String(body.network), coins = Number(body.coins);
    if (!networkOf(asset, network)) return error(422, "Choose a supported asset and network.");
    if (!Number.isSafeInteger(coins) || coins < cc.minCoins || coins > cc.maxCoins) return error(422, `Enter between ${cc.minCoins} and ${cc.maxCoins} IP Coins.`);
    const { rates, source } = await liveRates().catch((e) => ({ rates: null as any, source: String(e.message) }));
    if (!rates) return error(503, source);
    const usdMinor = coinsToUsdMinor(coins);
    const serviceFeeMinor = Math.ceil((usdMinor * cc.serviceFeeBps) / 10_000);
    const networkFeeMinor = cc.networkFeeMinor[network] ?? 0;
    const netMinor = usdMinor - serviceFeeMinor - networkFeeMinor;
    if (netMinor <= 0) return error(422, "Amount is too small to cover fees.");
    const cryptoBaseUnits = Math.floor((netMinor / 100 / rates[asset]) * 10 ** decimalsOf(asset));
    const [q] = await db.insert(cryptoQuotes).values({ userId: user.id, asset, network, coins, usdMinor, serviceFeeMinor, networkFeeMinor, rateUsd: String(rates[asset]), rateSource: source, cryptoBaseUnits, expiresAt: new Date(Date.now() + cc.quoteSeconds * 1000) }).returning();
    return json({ quote: { ...q, userId: undefined, cryptoAmount: formatBase(cryptoBaseUnits, asset), netMinor } });
  }

  // ---- crypto: confirm purchase — validates wallet, deducts coins atomically, queues for fulfillment ----
  if (req.method === "POST" && action === "redeem") {
    if (cc.mode === "off") return error(503, "The crypto shop is currently unavailable.");
    const key = String(body.idempotencyKey || ""), address = String(body.walletAddress || "").trim();
    if (!isUuid(body.quoteId) || !isUuid(key)) return error(422, "Quote expired. Please review the price again.");
    if (body.confirm !== true) return error(422, "Please confirm the wallet address, network and amount.");
    const dup = await db.select().from(cryptoRedemptions).where(and(eq(cryptoRedemptions.userId, user.id), eq(cryptoRedemptions.idempotencyKey, key)));
    if (dup[0]) return json({ redemption: pubRed(dup[0]), duplicate: true });

    const out = await db.transaction(async (tx) => {
      const [q] = await tx.select().from(cryptoQuotes).where(and(eq(cryptoQuotes.id, body.quoteId), eq(cryptoQuotes.userId, user.id))).for("update");
      if (!q || q.usedAt) return { err: error(409, "This quote was already used. Please review the price again.") };
      if (q.expiresAt.getTime() < Date.now()) return { err: error(409, "The price quote expired. Please review the updated price.") };
      const bad = validateAddress(q.asset, q.network, address);
      if (bad) return { err: error(422, bad) };
      const bal = await lockCoinBalance(tx, user.id);
      if (bal < q.coins) return { err: error(422, `Insufficient IP Coins: you have ${bal}, this purchase needs ${q.coins}.`) };
      await tx.update(cryptoQuotes).set({ usedAt: new Date() }).where(eq(cryptoQuotes.id, q.id));
      const [r] = await tx.insert(cryptoRedemptions).values({
        reference: ref(), userId: user.id, email: user.email, idempotencyKey: key, quoteId: q.id, asset: q.asset, network: q.network, walletAddress: address,
        coins: q.coins, usdMinor: q.usdMinor, serviceFeeMinor: q.serviceFeeMinor, networkFeeMinor: q.networkFeeMinor, rateUsd: q.rateUsd, cryptoBaseUnits: q.cryptoBaseUnits,
        status: "pending", fulfillment: cc.fulfillment,
      }).returning();
      await moveCoins(tx, { userId: user.id, delta: -q.coins, kind: "crypto_redemption", memo: `${r.reference}: ${formatBase(q.cryptoBaseUnits, q.asset)} ${q.asset} (${q.network})`, withdrawalId: r.id });
      await audit(tx, { actorId: user.id, actorEmail: user.email, action: "crypto_redemption_created", entityType: "crypto_redemption", entityId: r.id, details: { reference: r.reference, asset: q.asset, network: q.network, coins: q.coins, crypto: formatBase(q.cryptoBaseUnits, q.asset), mode: cc.mode } });
      return { r };
    });
    if ("err" in out) return out.err!;
    const r = out.r;
    context.waitUntil(sendEmail(adminEmails(), templates.adminSuspicious({ reason: `New crypto purchase awaiting fulfillment (${cc.mode} mode).`, details: [["Reference", r.reference], ["Customer", r.email], ["Deliver", `${formatBase(r.cryptoBaseUnits, r.asset)} ${r.asset} on ${r.network}`], ["Wallet", r.walletAddress]] }), "admin_crypto_redemption", r.id));
    return json({ redemption: pubRed(r) }, 201);
  }
  return error(404, "Not found");
};

export const config: Config = { path: ["/api/wallet", "/api/wallet/:action"] };
