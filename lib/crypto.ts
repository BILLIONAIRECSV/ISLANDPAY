import { createHash } from "node:crypto";

export type Asset = "USDT" | "BTC";
export const NETWORKS: Record<Asset, Array<{ id: string; label: string; decimals: number }>> = {
  USDT: [
    { id: "TRC20", label: "Tron (TRC20)", decimals: 6 },
    { id: "ERC20", label: "Ethereum (ERC20)", decimals: 6 },
    { id: "BEP20", label: "BNB Smart Chain (BEP20)", decimals: 6 },
  ],
  BTC: [{ id: "BTC", label: "Bitcoin", decimals: 8 }],
};
export const decimalsOf = (asset: Asset) => (asset === "BTC" ? 8 : 6);
export const networkOf = (asset: string, network: string) => (NETWORKS as any)[asset]?.find((n: any) => n.id === network) ?? null;

export const cryptoConfig = () => ({
  mode: (process.env.CRYPTO_SHOP_MODE || "test").toLowerCase() as "off" | "test" | "live",
  serviceFeeBps: Number(process.env.CRYPTO_SERVICE_FEE_BPS || 300),
  networkFeeMinor: {
    TRC20: Number(process.env.NETWORK_FEE_TRC20_MINOR || 150), ERC20: Number(process.env.NETWORK_FEE_ERC20_MINOR || 500),
    BEP20: Number(process.env.NETWORK_FEE_BEP20_MINOR || 50), BTC: Number(process.env.NETWORK_FEE_BTC_MINOR || 300),
  } as Record<string, number>,
  minCoins: Number(process.env.CRYPTO_MIN_COINS || 250),
  maxCoins: Number(process.env.CRYPTO_MAX_COINS || 50_000),
  quoteSeconds: 120,
  fulfillment: process.env.CRYPTO_FULFILLMENT_PROVIDER || "admin_queue",
});

// ---- address validation (format + checksum) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58check(s: string): Buffer | null {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const lead = s.match(/^1*/)![0].length;
  const buf = Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")]);
  if (buf.length < 5) return null;
  const payload = buf.subarray(0, -4), sum = buf.subarray(-4);
  const h = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest();
  return h.subarray(0, 4).equals(sum) ? payload : null;
}
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(v: number[]) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const x of v) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
function bech32Valid(addr: string) {
  const a = addr.toLowerCase();
  if (addr !== a && addr !== addr.toUpperCase()) return false;
  const pos = a.lastIndexOf("1");
  if (pos < 1 || a.slice(0, pos) !== "bc" || a.length > 90) return false;
  const data = [...a.slice(pos + 1)].map((c) => BECH.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return false;
  const hrp = [...a.slice(0, pos)];
  const exp = [...hrp.map((c) => c.charCodeAt(0) >> 5), 0, ...hrp.map((c) => c.charCodeAt(0) & 31)];
  const pm = bech32Polymod([...exp, ...data]);
  const witver = data[0];
  return (witver === 0 && pm === 1) || (witver > 0 && witver <= 16 && pm === 0x2bc830a3); // bech32 / bech32m
}

export function validateAddress(asset: string, network: string, address: string): string | null {
  const a = address.trim();
  if (!networkOf(asset, network)) return "Unsupported asset or network.";
  if (network === "BTC") {
    if (/^bc1/i.test(a)) return bech32Valid(a) ? null : "Invalid Bitcoin bech32 address (checksum failed).";
    if (/^[13]/.test(a)) { const p = base58check(a); return p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05) ? null : "Invalid Bitcoin address (checksum failed)."; }
    return "Enter a Bitcoin mainnet address starting with bc1, 1 or 3.";
  }
  if (network === "TRC20") { const p = /^T/.test(a) ? base58check(a) : null; return p && p.length === 21 && p[0] === 0x41 ? null : "Invalid Tron (TRC20) address."; }
  if (network === "ERC20" || network === "BEP20") return /^0x[0-9a-fA-F]{40}$/.test(a) ? null : `Invalid ${network} address (expected 0x followed by 40 hex characters).`;
  return "Unsupported network.";
}

export function validateTxHash(network: string, hash: string): boolean {
  if (network === "ERC20" || network === "BEP20") return /^0x[0-9a-fA-F]{64}$/.test(hash);
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

// ---- live rates (public market data, server-side) ----
let cache: { at: number; rates: Record<Asset, number>; source: string } | null = null;
export async function liveRates(): Promise<{ rates: Record<Asset, number>; source: string }> {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const t = (ms: number) => AbortSignal.timeout(ms);
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=usd", { signal: t(5000), headers: { accept: "application/json" } });
    const d: any = await r.json();
    if (d?.bitcoin?.usd > 0 && d?.tether?.usd > 0) cache = { at: Date.now(), rates: { BTC: d.bitcoin.usd, USDT: d.tether.usd }, source: "CoinGecko" };
  } catch {}
  if (!cache || Date.now() - cache.at >= 30_000) {
    const get = async (p: string) => Number((await (await fetch(`https://api.coinbase.com/v2/prices/${p}/spot`, { signal: t(5000) })).json())?.data?.amount);
    const [btc, usdt] = await Promise.all([get("BTC-USD"), get("USDT-USD")]);
    if (!(btc > 0 && usdt > 0)) throw new Error("Live exchange rates are unavailable. Please try again shortly.");
    cache = { at: Date.now(), rates: { BTC: btc, USDT: usdt }, source: "Coinbase" };
  }
  return cache!;
}

export function formatBase(units: number, asset: string) {
  const d = decimalsOf(asset as Asset);
  const s = String(units).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** On-chain verification. BTC via mempool.space (public). Returns null when no automatic verifier exists for the network. */
export async function verifyOnChain(r: { network: string; walletAddress: string; cryptoBaseUnits: number }, txHash: string): Promise<{ ok: boolean; detail: string } | null> {
  if (r.network !== "BTC") return null;
  try {
    const res = await fetch(`https://mempool.space/api/tx/${txHash}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `Transaction not found on Bitcoin mainnet (HTTP ${res.status}).` };
    const tx: any = await res.json();
    const paid = (tx.vout || []).filter((o: any) => o.scriptpubkey_address === r.walletAddress).reduce((a: number, o: any) => a + Number(o.value), 0);
    if (paid < r.cryptoBaseUnits) return { ok: false, detail: `Output to customer wallet is ${paid} sats; expected at least ${r.cryptoBaseUnits}.` };
    if (!tx.status?.confirmed) return { ok: false, detail: "Transaction found but not yet confirmed. Try again after 1 confirmation." };
    return { ok: true, detail: `mempool.space: confirmed in block ${tx.status.block_height}, ${paid} sats to customer wallet` };
  } catch (e: any) {
    return { ok: false, detail: `Could not reach blockchain explorer: ${String(e?.message || e)}` };
  }
}
