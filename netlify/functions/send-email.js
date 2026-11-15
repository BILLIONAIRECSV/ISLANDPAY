import { Resend } from "resend";
import { json } from "./_shared.js";

export default async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  // Do not expose a public email-sending endpoint. Trigger email from trusted server
  // workflows after verified events, not directly from arbitrary browser requests.
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return json(503, { error: "Email service is not configured" });
  }
  return json(403, {
    error: "Direct email sending is disabled.",
    message: "Invoke Resend from the authenticated payment/webhook workflow after verification."
  });
};
