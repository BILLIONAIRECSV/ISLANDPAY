// CX Pay (Aruba Bank acquiring) card adapter — CX Pay Payment Gateway "Payment API" + Collect.js.
// Per the CX Pay integration portal (cxpay.transactiongateway.com/merchants/resources/integration):
//   Browser: Collect.js (hosted, iframe/lightbox card fields) -> single-use payment_token. Card data never touches Island Pay.
//   Server:  POST {base}/api/transact.php  security_key, type=sale, payment_token, amount, currency, orderid  (x-www-form-urlencoded)
//            response=1 approved | 2 declined | 3 error; transactionid identifies the charge.
//   Webhooks: header "Webhook-Signature: t=<nonce>,s=<hex HMAC-SHA256(signingKey, nonce + '.' + rawBody)>"
// test_mode=enabled is sent while CXPAY_MODE != "production" so no real money moves.
import { createHmac, timingSafeEqual } from "node:crypto";
import { minorToDecimal } from "./money.js";

export const CXPAY = "cxpay";

export function cxpayConfig() {
  const production = (process.env.CXPAY_MODE || "test").toLowerCase() === "production";
  return {
    production,
    baseUrl: (process.env.CXPAY_BASE_URL || "https://cxpay.transactiongateway.com").replace(/\/$/, ""),
    securityKey: process.env.CXPAY_SECURITY_KEY || "", // private, server-only
    tokenizationKey: process.env.CXPAY_TOKENIZATION_KEY || "", // public by design (Collect.js)
    webhookSigningKey: process.env.CXPAY_WEBHOOK_SIGNING_KEY || "",
    feeBps: Number(process.env.CARD_FEE_BPS || 350), // estimate for reporting until the merchant pricing is confirmed
    feeFixedMinor: Number(process.env.CARD_FEE_FIXED_MINOR || 30),
  };
}
export const cxpayReady = () => { const c = cxpayConfig(); return Boolean(c.securityKey && c.tokenizationKey); };
export const cxpayWebhookReady = () => Boolean(cxpayConfig().webhookSigningKey);
export const estimateCardFee = (amountMinor: number) => { const c = cxpayConfig(); return Math.round((amountMinor * c.feeBps) / 10_000) + c.feeFixedMinor; };

export type SaleResult = { approved: boolean; response: string; text: string; transactionId: string | null; orderId: string | null; code: string | null };

export async function cxpaySale(p: { token: string; amountMinor: number; currency: string; orderId: string; email: string; description: string }): Promise<SaleResult> {
  const c = cxpayConfig();
  const body = new URLSearchParams({
    security_key: c.securityKey, type: "sale", payment_token: p.token, amount: minorToDecimal(p.amountMinor),
    currency: p.currency, orderid: p.orderId, order_description: p.description, email: p.email,
  });
  if (!c.production) body.set("test_mode", "enabled");
  const res = await fetch(`${c.baseUrl}/api/transact.php`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`CX Pay HTTP ${res.status}`);
  const r = new URLSearchParams(text);
  return {
    approved: r.get("response") === "1", response: r.get("response") || "", text: r.get("responsetext") || "",
    transactionId: r.get("transactionid") || null, orderId: r.get("orderid") || null, code: r.get("response_code"),
  };
}

/** Timing-safe verification of the CX Pay webhook signature. */
export function verifyCxpayWebhook(header: string | null, rawBody: string): boolean {
  const key = cxpayConfig().webhookSigningKey;
  if (!key || !header) return false;
  const m = header.match(/t=([^,]+),\s*s=([0-9a-f]+)/i);
  if (!m) return false;
  const expected = createHmac("sha256", key).update(`${m[1]}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex"), b = Buffer.from(m[2], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
