import type pg from "pg";

export async function hasPermission(client: pg.PoolClient, userId: string, permissionCode: string): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1
         AND p.code = $2
         AND (p.scope IS NULL OR p.scope = 'all')
         AND r.is_active = TRUE
     ) AS allowed`,
    [userId, permissionCode]
  );
  return Boolean(result.rows[0]?.allowed);
}
