import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db, profiles, customerBalances } from "../../db/index.js";
import { requireUser } from "../../lib/auth.js";
import { assertSameOrigin, error, json, readJson } from "../../lib/http.js";
import { depositCurrency } from "../../lib/money.js";
import { audit } from "../../lib/audit.js";

export default async (req: Request) => {
  const user = await requireUser();
  if (user instanceof Response) return user;

  await db.insert(profiles).values({ userId: user.id, email: user.email, fullName: user.name ?? null })
    .onConflictDoUpdate({ target: profiles.userId, set: { email: user.email } });

  if (req.method === "PATCH") {
    const bad = assertSameOrigin(req);
    if (bad) return bad;
    const body = await readJson(req);
    const clean = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
    const fullName = clean(body.fullName, 120);
    const phone = clean(body.phone, 40);
    const country = clean(body.country, 60);
    if (phone && !/^[+()\d\s-]{6,40}$/.test(phone)) return error(422, "Enter a valid phone number.");
    await db.update(profiles).set({ fullName, phone, country, updatedAt: new Date() }).where(eq(profiles.userId, user.id));
    await audit(null, { actorId: user.id, actorEmail: user.email, action: "profile_updated", entityType: "profile", entityId: user.id });
  } else if (req.method !== "GET") {
    return error(405, "Method not allowed");
  }

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id));
  const balances = await db.select().from(customerBalances).where(eq(customerBalances.userId, user.id));
  const currency = depositCurrency();
  const main = balances.find((b) => b.currency === currency)?.availableMinor ?? 0;
  return json({
    user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
    profile: { fullName: profile?.fullName ?? null, phone: profile?.phone ?? null, country: profile?.country ?? null, createdAt: profile?.createdAt },
    balance: { currency, availableMinor: main },
    balances: balances.map((b) => ({ currency: b.currency, availableMinor: b.availableMinor })),
  });
};

export const config: Config = { path: "/api/me" };
