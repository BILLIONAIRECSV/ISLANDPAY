import type { Config } from "@netlify/functions";
import { and, eq } from "drizzle-orm";
import { db, coinOrders, webhookEvents } from "../../db/index.js";
import { CXPAY, cxpayWebhookReady, verifyCxpayWebhook } from "../../lib/cxpay.js";
import { reverseCoinOrder } from "../../lib/coins.js";
import { audit } from "../../lib/audit.js";
import { error, isUuid, json } from "../../lib/http.js";
import { parseDecimalToMinor } from "../../lib/money.js";

/** CX Pay gateway webhook: signature-verified, de-duplicated by event_id. Refunds/voids/chargebacks reverse coins. */
export default async (req: Request) => {
  if (req.method !== "POST") return error(405, "Method not allowed");
  if (!cxpayWebhookReady()) return error(503, "Webhook not configured. No balances were changed.");
  const raw = await req.text();
  if (!verifyCxpayWebhook(req.headers.get("webhook-signature"), raw)) return error(401, "Invalid signature");
  let p: any; try { p = JSON.parse(raw); } catch { return error(400, "Invalid JSON"); }
  const eventKey = String(p.event_id || "");
  const type = String(p.event_type || "");
  if (!eventKey) return error(400, "Missing event_id");
  const ins = await db.insert(webhookEvents).values({ provider: CXPAY, eventKey, signatureValid: true, payload: p }).onConflictDoNothing().returning();
  if (!ins.length) {
    const [e] = await db.select().from(webhookEvents).where(and(eq(webhookEvents.provider, CXPAY), eq(webhookEvents.eventKey, eventKey)));
    if (e?.processedAt) return json({ ok: true, duplicate: true });
  }
  const b = p.event_body || {};
  const orderId = String(b.order_id || b.orderid || "");
  let result = "recorded";
  if (/refund\.success|void\.success|chargeback/i.test(type) && isUuid(orderId)) {
    const [o] = await db.select().from(coinOrders).where(eq(coinOrders.id, orderId));
    if (o) result = (await reverseCoinOrder(o.id, `CX Pay ${type}`, null, parseDecimalToMinor(b.action?.amount ?? b.requested_amount) ?? undefined)).result;
    else result = "unmatched";
  }
  await audit(null, { action: "cxpay_webhook", entityType: "webhook", entityId: eventKey, details: { type, orderId, result } });
  await db.update(webhookEvents).set({ processedAt: new Date(), result }).where(and(eq(webhookEvents.provider, CXPAY), eq(webhookEvents.eventKey, eventKey)));
  return json({ ok: true, result });
};

export const config: Config = { path: "/api/webhooks/cxpay" };
