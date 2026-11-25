import { and, eq, sql } from "drizzle-orm";
import { db, coinOrders, customerBalances, ledgerEntries } from "../db/index.js";
import { audit } from "./audit.js";

export const COIN = "IPC"; // IP Coin balance "currency" in customer_balances / ledger_entries
export const COINS_PER_USD = 10;
export const PACKAGES = [
  { id: "p25", amountMinor: 2_500, coins: 250 },
  { id: "p50", amountMinor: 5_000, coins: 500 },
  { id: "p100", amountMinor: 10_000, coins: 1_000 },
  { id: "p250", amountMinor: 25_000, coins: 2_500 },
  { id: "p500", amountMinor: 50_000, coins: 5_000 },
];
export const coinsToUsdMinor = (coins: number) => (coins * 100) / COINS_PER_USD; // 1 coin = 10 cents

type Tx = any;
export async function lockCoinBalance(tx: Tx, userId: string): Promise<number> {
  await tx.insert(customerBalances).values({ userId, currency: COIN, availableMinor: 0 }).onConflictDoNothing();
  const [row] = await tx.select().from(customerBalances).where(and(eq(customerBalances.userId, userId), eq(customerBalances.currency, COIN))).for("update");
  return Number(row.availableMinor);
}

/** Adds (positive) or removes (negative) coins with a matching immutable ledger entry. Caller must hold the row lock. */
export async function moveCoins(tx: Tx, e: { userId: string; delta: number; kind: string; memo: string; depositId?: string | null; withdrawalId?: string | null }) {
  await tx.update(customerBalances).set({ availableMinor: sql`${customerBalances.availableMinor} + ${e.delta}`, updatedAt: new Date() })
    .where(and(eq(customerBalances.userId, e.userId), eq(customerBalances.currency, COIN)));
  await tx.insert(ledgerEntries).values({
    userId: e.userId, currency: COIN, account: "coin_wallet", direction: e.delta > 0 ? "credit" : "debit", kind: e.kind,
    amountMinor: Math.abs(e.delta), memo: e.memo, depositId: e.depositId ?? null, withdrawalId: e.withdrawalId ?? null,
  });
}

/** Reverses a paid coin order after a verified refund/void/chargeback. Never drives a balance negative. */
export async function reverseCoinOrder(orderId: string, reason: string, actor: { id?: string; email?: string } | null, refundedMinor?: number) {
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(coinOrders).where(eq(coinOrders.id, orderId)).for("update");
    if (!o) return { result: "not_found" };
    if (o.status === "refunded") return { result: "duplicate", order: o };
    if (o.status !== "paid") return { result: `not_paid:${o.status}`, order: o };
    const bal = await lockCoinBalance(tx, o.userId);
    const now = new Date();
    if (bal < o.coins) {
      const [u] = await tx.update(coinOrders).set({ status: "review", failureReason: `Refund received but customer holds only ${bal} of ${o.coins} coins: ${reason}`, updatedAt: now }).where(eq(coinOrders.id, o.id)).returning();
      await audit(tx, { actorId: actor?.id, actorEmail: actor?.email, action: "coin_refund_needs_review", entityType: "coin_order", entityId: o.id, details: { reason, balance: bal } });
      return { result: "review", order: u };
    }
    await moveCoins(tx, { userId: o.userId, delta: -o.coins, kind: "coin_refund", memo: `Coin purchase refunded: ${reason}`, depositId: o.id });
    const [u] = await tx.update(coinOrders).set({ status: "refunded", refundedMinor: refundedMinor ?? o.amountMinor, failureReason: reason, updatedAt: now }).where(eq(coinOrders.id, o.id)).returning();
    await audit(tx, { actorId: actor?.id, actorEmail: actor?.email, action: "coin_order_refunded", entityType: "coin_order", entityId: o.id, details: { reason, coins: o.coins } });
    return { result: "refunded", order: u };
  });
}
