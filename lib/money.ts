// Island Pay allocation: 8.88% company fee, 91.12% customer credits.
// Integer minor units only; half-up rounding on the fee, credits take the remainder,
// so fee + credits always equals the gross deposit exactly.
export const FEE_BPS = 888;
export const CUSTOMER_BPS = 10_000 - FEE_BPS;

export function splitDeposit(grossMinor: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0) throw new Error("Invalid amount");
  const companyFeeMinor = Math.floor((grossMinor * FEE_BPS + 5_000) / 10_000);
  return { grossMinor, companyFeeMinor, customerCreditMinor: grossMinor - companyFeeMinor };
}

export const depositCurrency = () => (process.env.DEPOSIT_CURRENCY || "USD").toUpperCase();
export const minDepositMinor = () => Number(process.env.MIN_DEPOSIT_MINOR || 1_000); // $10.00
export const maxDepositMinor = () => Number(process.env.MAX_DEPOSIT_MINOR || 1_000_000); // $10,000.00
export const alertThresholdMinor = () => Number(process.env.ALERT_THRESHOLD_MINOR || 500_000); // $5,000.00

/** Parses a decimal string like "100" or "100.5" into minor units without float error. */
export function parseDecimalToMinor(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}
