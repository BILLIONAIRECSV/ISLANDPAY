import { createClient } from "@supabase/supabase-js";

export function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server environment is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function getBearer(event) {
  const h = event.headers?.authorization || event.headers?.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
export async function requireUser(event, supabase) {
  const token = getBearer(event);
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error ? null : data.user;
}
export function minorUnits(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("amountMinor must be a positive integer");
  return value;
}
