import { getDb, type DbExecutor } from "../db/client.js";
import { audit_log } from "../db/schema.js";
import { ValidationError } from "../errors.js";
import type { UserRef } from "../types.js";

export interface AuditEvent {
  /** Who did it. null means system-initiated, for example a webhook. */
  actorUser: UserRef | null;
  /** Dotted event name, for example "organization.approved" or "user.invited". */
  action: string;
  /** What kind of thing was acted on, for example "organization", "user", "consignment". */
  targetType: string;
  targetId: string;
  /** Action-specific details. */
  metadata?: Record<string, unknown>;
}

const ACTION_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Appends one row to audit_log.
 *
 * Every service function that mutates state must call this. Pass the open transaction as `db`
 * so the audit row commits or rolls back together with the mutation it describes: a mutation
 * without its audit row, or an audit row for a mutation that rolled back, are both wrong.
 */
export async function recordAudit(event: AuditEvent, db: DbExecutor = getDb()): Promise<void> {
  if (!ACTION_FORMAT.test(event.action)) {
    throw new ValidationError(`Audit action must be a dotted lowercase event name, got "${event.action}"`);
  }
  if (!event.targetType) {
    throw new ValidationError("Audit targetType is required");
  }

  await db.insert(audit_log).values({
    actor_user_id: event.actorUser?.id ?? null,
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId,
    metadata: event.metadata ?? {},
  });
}
