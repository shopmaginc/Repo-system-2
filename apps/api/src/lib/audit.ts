import type { DbClient } from '../db.js';

export type AuditResult = 'success' | 'denied' | 'failure';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
  result: AuditResult;
  details?: Record<string, unknown> | null;
}

/**
 * Write one audit row. Audit logging must never break the request it
 * describes, so failures are swallowed after being reported to the logger.
 */
export async function logAudit(
  db: DbClient,
  entry: AuditEntry,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        ipAddress: entry.ipAddress ?? null,
        result: entry.result,
        details: entry.details ?? undefined,
      },
    });
  } catch (err) {
    // Audit failure is itself a security-relevant event; surface it where
    // operators will see it, but never throw into the request path.
    if (onError) onError(err);
    else console.error('[audit] failed to write audit log:', err);
  }
}
