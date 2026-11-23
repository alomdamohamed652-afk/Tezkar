import type pg from "pg";
import { AppError } from "../../http/errors.js";

export async function hasPermission(
  client: pg.PoolClient,
  userId: string,
  permissionCode: string,
  requestedScope: 'all' | 'own' = 'all'
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1
         AND p.code = $2
         AND (p.scope IS NULL OR p.scope = 'all' OR p.scope = $3)
         AND r.is_active = TRUE
     ) AS allowed`,
    [userId, permissionCode, requestedScope]
  );
  return Boolean(result.rows[0]?.allowed);
}

// When at least one account is listed for a permission, only those accounts may use it.
// An empty list keeps plain role-based behavior. Role permission is required either way.
export async function assertPermissionAccountAllowed(
  client: pg.PoolClient,
  permissionCode: string,
  userId: string
): Promise<void> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total,
            BOOL_OR(user_id = $2) AS listed
       FROM permission_account_restrictions
      WHERE permission_code = $1`,
    [permissionCode, userId]
  );
  const total = Number(result.rows[0]?.total ?? 0);
  if (total > 0 && !result.rows[0]?.listed) {
    throw new AppError("PERMISSION_ACCOUNT_RESTRICTED", "هذه الصلاحية مقيدة لحسابات محددة من الإدارة؛ حسابك غير مخول لها", 403);
  }
}
