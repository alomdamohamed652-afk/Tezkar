import type pg from "pg";

type AuditInput = {
  actorUserId: string | null;
  actorEmployeeId: string | null;
  action: string;
  module: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: Record<string, unknown>;
};

export async function writeAudit(client: pg.PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (
       actor_user_id, actor_employee_id, action, module, entity_type, entity_id,
       request_id, ip_address, user_agent, before_data, after_data, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.actorUserId, input.actorEmployeeId, input.action, input.module, input.entityType,
      input.entityId ?? null, input.requestId ?? null, input.ipAddress ?? null,
      input.userAgent ?? null, input.beforeData ?? null, input.afterData ?? null,
      input.metadata ?? {}
    ]
  );
}
