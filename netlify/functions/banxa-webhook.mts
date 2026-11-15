import type { Config, Context } from "@netlify/functions";
import { and, eq } from "drizzle-orm";
import { db, webhookEvents } from "../../db/index.js";
import { banxaWebhookReady, getOrder, PROVIDER, verifyWebhookSignature } from "../../lib/banxa.js";
import { applyProviderOrder, runEmails } from "../../lib/ledger.js";
import { audit } from "../../lib/audit.js";
import { error, json } from "../../lib/http.js";

/**
 * Banxa order webhook. Credits are only issued when:
 *  1. the HMAC signature verifies against our webhook path, nonce and raw body;
 *  2. the order is re-fetched from Banxa's API (the webhook body is never trusted for money);
 *  3. the order matches our deposit reference, amount and currency;
 *  4. the database transaction succeeds. Duplicate deliveries are ignored (order_id + status).
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return error(405, "Method not allowed");
  if (!banxaWebhookReady()) return error(503, "Webhook not configured. No balances were changed.");

  const raw = await req.text();
  if (!verifyWebhookSignature(req.headers.get("authorization"), raw)) {
    console.warn("Rejected Banxa webhook with invalid signature");
    return error(401, "Invalid signature");
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return error(400, "Invalid JSON"); }
  const orderId = typeof payload?.order_id === "string" ? payload.order_id : null;
  const status = typeof payload?.status === "string" ? payload.status : "";
  if (!orderId) {
    // Signed KYC / account events: acknowledge and record only.
    await audit(null, { action: "banxa_non_order_event", entityType: "webhook", details: payload });
    return json({ ok: true, ignored: true });
  }

  const eventKey = `${orderId}:${status}`;
  await db.insert(webhookEvents).values({ provider: PROVIDER, eventKey, signatureValid: true, payload }).onConflictDoNothing();
  const [evt] = await db.select().from(webhookEvents).where(and(eq(webhookEvents.provider, PROVIDER), eq(webhookEvents.eventKey, eventKey)));
  if (evt?.processedAt) return json({ ok: true, duplicate: true });

  try {
    const order = await getOrder(orderId);
    const out = await applyProviderOrder(order, "webhook");
    await db.update(webhookEvents).set({ processedAt: new Date(), result: out.result }).where(eq(webhookEvents.id, evt.id));
    context.waitUntil(runEmails(out.emails));
    return json({ ok: true, result: out.result });
  } catch (e: any) {
    console.error("Banxa webhook processing failed", e);
    await db.update(webhookEvents).set({ result: `error: ${String(e?.message || e).slice(0, 300)}` }).where(eq(webhookEvents.id, evt.id));
    return error(500, "Processing failed; please retry"); // Banxa retries non-2xx deliveries
  }
};

export const config: Config = { path: "/api/webhooks/banxa" };
