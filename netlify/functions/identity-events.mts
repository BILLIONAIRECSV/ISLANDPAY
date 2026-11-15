import type { UserSignupEvent } from "@netlify/functions";
import { sendEmail, templates } from "../../lib/email.js";

// Every signup gets the "customer" role. Admin is granted only by an existing administrator
// in Netlify Identity (or to the configured ADMIN_EMAIL owner(s), who must still verify the address).
export default {
  async userSignup(event: UserSignupEvent) {
    const email = (event.user.email || "").toLowerCase();
    const owners = (process.env.ADMIN_EMAIL || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const existing = Array.isArray((event.user.appMetadata as any)?.roles) ? (event.user.appMetadata as any).roles : [];
    const roles = Array.from(new Set([...existing.filter((r: string) => r !== "admin"), "customer", ...(owners.includes(email) ? ["admin"] : [])]));
    const name = (event.user.userMetadata as any)?.full_name as string | undefined;
    if (email) await sendEmail(email, templates.welcome({ name }), "welcome", event.user.id);
    return { user: { ...event.user, appMetadata: { ...event.user.appMetadata, roles } } };
  },
};
