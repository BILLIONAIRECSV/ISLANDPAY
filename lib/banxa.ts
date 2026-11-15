// Banxa Hosted Checkout (v2) adapter, built from Banxa's published documentation:
//   POST /{partnerRef}/v2/buy           (x-api-key)  -> { id, checkoutUrl, ... }
//   GET  /{partnerRef}/v2/orders/{id}   (x-api-key)  -> authoritative order status
//   Webhooks: Authorization: Bearer KEY:SIGNATURE:NONCE,
//             SIGNATURE = hex HMAC-SHA256(secret, "POST\n{webhookPath}\n{nonce}\n{rawBody}")
// Credits are only issued for orders whose looked-up status is "complete".
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { minorToDecimal, parseDecimalToMinor } from "./money.js";

export const PROVIDER = "banxa";

export function banxaConfig() {
  const env = (process.env.BANXA_ENV || "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
  const cfg = {
    env,
    baseUrl: (process.env.BANXA_BASE_URL || (env === "production" ? "https://api.banxa.com" : "https://api.banxa-sandbox.com")).replace(/\/$/, ""),
    partnerRef: process.env.BANXA_PARTNER_REF || "",
    apiKey: process.env.BANXA_API_KEY || "",
    hmacKey: process.env.BANXA_HMAC_KEY || "",
    hmacSecret: process.env.BANXA_HMAC_SECRET || "",
    crypto: process.env.BANXA_CRYPTO || "USDT",
    blockchain: process.env.BANXA_BLOCKCHAIN || "",
    walletAddress: process.env.BANXA_WALLET_ADDRESS || "",
    webhookPath: process.env.BANXA_WEBHOOK_PATH || "/api/webhooks/banxa",
  };
  return cfg;
}

export function banxaCheckoutReady() {
  const c = banxaConfig();
  return Boolean(c.partnerRef && c.apiKey && c.walletAddress && c.hmacSecret);
}
export function banxaWebhookReady() {
  const c = banxaConfig();
  return Boolean(c.hmacKey && c.hmacSecret && c.apiKey && c.partnerRef);
}

function ipBinding(ip: string | undefined, secret: string) {
  if (!ip) return null;
  let addr = ip.trim();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) addr = mapped[1];
  const family = isIP(addr);
  if (!family) return null;
  if (family === 6) addr = new URL(`http://[${addr}]`).hostname.slice(1, -1); // RFC 5952 short form
  return [{ method: "hash", family: family === 4 ? "v4" : "v6", value: createHmac("sha256", secret).update(addr).digest("hex") }];
}

async function banxaFetch(path: string, init: RequestInit = {}) {
  const c = banxaConfig();
  const res = await fetch(`${c.baseUrl}/${encodeURIComponent(c.partnerRef)}/v2${path}`, {
    ...init,
    headers: { "x-api-key": c.apiKey, "content-type": "application/json", accept: "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

export async function createBuyOrder(p: {
  depositId: string; userId: string; email: string; grossMinor: number; currency: string; redirectUrl: string; ip?: string; originalUrl?: string;
}) {
  const c = banxaConfig();
  const body: Record<string, unknown> = {
    crypto: c.crypto,
    fiat: p.currency,
    fiatAmount: minorToDecimal(p.grossMinor),
    walletAddress: c.walletAddress,
    redirectUrl: p.redirectUrl,
    externalCustomerId: p.userId,
    externalOrderId: p.depositId,
    email: p.email,
  };
  if (c.blockchain) body.blockchain = c.blockchain;
  if (p.originalUrl) body.originalUrl = p.originalUrl;
  const binding = ipBinding(p.ip, c.hmacSecret);
  if (binding) body.ipBinding = binding;
  const r = await banxaFetch("/buy", { method: "POST", body: JSON.stringify(body) });
  if (!r.ok || !r.data?.id || !r.data?.checkoutUrl) {
    const msg = r.data?.message || r.data?.error?.message || r.data?.errors?.[0]?.message || `Banxa returned HTTP ${r.status}`;
    throw new Error(String(msg));
  }
  return { orderId: String(r.data.id), checkoutUrl: String(r.data.checkoutUrl), raw: r.data };
}

export type BanxaOrder = {
  id: string; status: string; externalOrderId: string | null; fiat: string; fiatAmountMinor: number | null;
  processingFeeMinor: number; networkFeeMinor: number; crypto: string | null; cryptoAmount: string | null;
  walletAddress: string | null; transactionHash: string | null;
};

export async function getOrder(orderId: string): Promise<BanxaOrder> {
  const r = await banxaFetch(`/orders/${encodeURIComponent(orderId)}`);
  if (!r.ok || !r.data) throw new Error(`Banxa order lookup failed (HTTP ${r.status})`);
  const o = r.data.data?.order ?? r.data.order ?? r.data;
  return {
    id: String(o.id),
    status: String(o.status),
    externalOrderId: o.externalOrderId ?? null,
    fiat: String(o.fiat || "").toUpperCase(),
    fiatAmountMinor: parseDecimalToMinor(o.fiatAmount),
    processingFeeMinor: parseDecimalToMinor(o.processingFee) ?? 0,
    networkFeeMinor: parseDecimalToMinor(o.networkFee) ?? 0,
    crypto: typeof o.crypto === "object" && o.crypto ? o.crypto.id ?? null : o.crypto ?? null,
    cryptoAmount: o.cryptoAmount ?? null,
    walletAddress: o.walletAddress ?? null,
    transactionHash: o.transactionHash ?? null,
  };
}

/** Verifies Banxa's webhook HMAC signature exactly as documented (timing-safe). */
export function verifyWebhookSignature(authHeader: string | null, rawBody: string): boolean {
  const c = banxaConfig();
  if (!authHeader || !c.hmacSecret || !c.hmacKey) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const parts = token.split(":");
  if (parts.length !== 3) return false;
  const [key, signature, nonce] = parts;
  if (key !== c.hmacKey || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", c.hmacSecret).update(`POST\n${c.webhookPath}\n${nonce}\n${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Maps a Banxa order status to the Island Pay deposit lifecycle. */
export function classifyStatus(status: string): "success" | "failure" | "refund" | "expired" | "pending" {
  switch (status) {
    case "complete": return "success";
    case "cancelled":
    case "declined": return "failure";
    case "refunded": return "refund";
    case "expired": return "expired";
    default: return "pending"; // pendingPayment, waitingPayment, paymentReceived, inProgress, cryptoTransferred, extraVerification
  }
}
