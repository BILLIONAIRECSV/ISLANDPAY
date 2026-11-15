export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, status);

/**
 * CSRF guard for cookie-authenticated, state-changing requests. Requires a custom header
 * (forces a CORS preflight) and, when present, an Origin matching the request host.
 */
export function assertSameOrigin(req: Request): Response | null {
  if (req.headers.get("x-islandpay-request") !== "1") return error(403, "Invalid request origin");
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) return error(403, "Invalid request origin");
  return null;
}

export async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export const isUuid = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const siteUrl = (req?: Request) =>
  (process.env.SITE_URL || process.env.URL || (req ? new URL(req.url).origin : "")).replace(/\/$/, "");
