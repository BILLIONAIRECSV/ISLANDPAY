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
    const type = body.destinationType;
    const label = String(body.destinationLabel || "").trim();
    if (!/^[A-Z]{3}$/.test(currency) || !["bank", "crypto"].includes(type) || !label) {
      return json(400, { error: "Invalid withdrawal request" });
    }

    // This starter intentionally records a request only. Add server-side admin-role
    // checks, approval workflow, available-balance reservation and approved payout API
    // before allowing real withdrawals. Customer JWT alone is not admin authorization.
    return json(403, {
      error: "Company withdrawal requests are restricted to authorized administrators.",
      message: "No funds were transferred."
    });
  } catch (e) {
    return json(400, { error: e.message || "Invalid request" });
  }
};
