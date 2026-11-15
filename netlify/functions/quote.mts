import type { Config } from "@netlify/functions";
import { error, json } from "../../lib/http.js";
import { depositCurrency, maxDepositMinor, minDepositMinor, parseDecimalToMinor, splitDeposit } from "../../lib/money.js";
import { banxaCheckoutReady, banxaConfig } from "../../lib/banxa.js";

// Public, read-only. The authoritative split is recalculated again when the deposit is created.
export default async (req: Request) => {
  const url = new URL(req.url);
  const currency = depositCurrency();
  const base = {
    currency, feePercent: "8.88", creditPercent: "91.12",
    minMinor: minDepositMinor(), maxMinor: maxDepositMinor(),
    presetsMinor: [2_500, 5_000, 10_000, 25_000, 50_000, 100_000],
    provider: { name: "Banxa", ready: banxaCheckoutReady(), environment: banxaConfig().env },
  };
  const amount = url.searchParams.get("amount");
  if (amount == null) return json(base);
  const gross = parseDecimalToMinor(amount);
  if (gross == null) return error(422, "Enter a valid amount with up to 2 decimals.");
  if (gross < base.minMinor || gross > base.maxMinor) return error(422, "Amount is outside the allowed range.", base);
  const s = splitDeposit(gross);
  return json({ ...base, ...s, totalPaymentMinor: s.grossMinor });
};

export const config: Config = { path: "/api/quote" };
