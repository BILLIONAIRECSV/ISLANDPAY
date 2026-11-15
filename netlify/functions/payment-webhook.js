import { json } from "./_shared.js";

export default async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  // SECURITY: Banxa's exact signature header, canonical payload and verification method
  // must come from its current merchant documentation. Do not guess these details.
  // This endpoint intentionally fails closed until a provider-specific verifier and
  // event-to-database mapping have been implemented and tested.
  return json(501, {
    error: "Webhook adapter not configured",
    message: "No credits or company revenue were changed. Implement and test provider signature verification first."
  });
};
