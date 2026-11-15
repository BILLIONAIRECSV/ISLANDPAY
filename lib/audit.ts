import { db, auditLog } from "../db/index.js";

export async function audit(
  executor: any,
  entry: { actorId?: string | null; actorEmail?: string | null; action: string; entityType?: string; entityId?: string; details?: unknown },
) {
  await (executor ?? db).insert(auditLog).values({
    actorId: entry.actorId ?? null,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details: (entry.details ?? null) as any,
  });
}
