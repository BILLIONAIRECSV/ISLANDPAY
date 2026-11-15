import { getUser } from "@netlify/identity";
import { error } from "./http.js";

export type AuthUser = { id: string; email: string; name?: string; roles: string[]; isAdmin: boolean };

/** Resolves the Netlify Identity user from the request (nf_jwt cookie). Server-side only. */
export async function currentUser(): Promise<AuthUser | null> {
  const u = await getUser();
  if (!u || !u.email) return null;
  const roles = Array.isArray(u.roles) ? u.roles : [];
  return { id: u.id, email: u.email, name: u.name, roles, isAdmin: roles.includes("admin") };
}

export async function requireUser(): Promise<AuthUser | Response> {
  const u = await currentUser();
  return u ?? error(401, "Please log in to continue.");
}

/** Admin authorization is enforced here, on the server, from Identity app_metadata roles. */
export async function requireAdmin(): Promise<AuthUser | Response> {
  const u = await currentUser();
  if (!u) return error(401, "Please log in to continue.");
  if (!u.isAdmin) return error(403, "Administrator access required.");
  return u;
}
