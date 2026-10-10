import type { PoolClient } from "pg";

export type NotificationType =
  | "TASK_ASSIGNED"
  | "PRODUCTION_APPROVED"
  | "PAYMENT_REQUEST_APPROVED"
  | "PAYMENT_REQUEST_REJECTED"
  | "PAYMENT_PAID"
  | "SYSTEM";

export async function createUserNotification(
  client: PoolClient,
  input: { userId: string; type: NotificationType; title: string; body?: string; href?: string | null; entityType?: string | null; entityId?: string | null }
): Promise<void> {
  await client.query(
    `INSERT INTO user_notifications(user_id,notification_type,title,body,href,entity_type,entity_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [input.userId, input.type, input.title.trim().slice(0, 180), (input.body ?? "").trim().slice(0, 1000), input.href ?? null, input.entityType ?? null, input.entityId ?? null]
  );
}
