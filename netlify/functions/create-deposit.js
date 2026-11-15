import { json, supabaseAdmin, requireUser, minorUnits } from "./_shared.js";

export default async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  try {
    const supabase = supabaseAdmin();
    const user = await requireUser(event, supabase);
    if (!user) return json(401, { error: "Authentication required" });

    const body = JSON.parse(event.body || "{}");
    const amountMinor = minorUnits(body.amountMinor);
    const currency = String(body.currency || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return json(400, { error: "Use a valid ISO currency code" });

    // Provider checkout creation must be implemented from the provider's official API docs.
    // Fail closed: never create a fake checkout or issue credits from this endpoint.
    if (!process.env.PAYMENT_PROVIDER || process.env.PAYMENT_PROVIDER === "unconfigured") {
      return json(503, { error: "Payment provider is not configured. No payment or credits were created." });
    }
    return json(501, {
      error: "Provider checkout adapter is not implemented.",
      message: "Connect the approved provider API using its current merchant documentation."
    });
  } catch (e) {
    return json(400, { error: e.message || "Invalid request" });
  }
};
