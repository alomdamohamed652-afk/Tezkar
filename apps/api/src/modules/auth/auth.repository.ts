import type pg from "pg";

export async function findUserForLogin(
  client: pg.PoolClient,
  username: string
) {
  const result = await client.query(
    `SELECT u.id, u.username, u.password_hash, u.employee_id, u.is_active,
            COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.username = $1
     GROUP BY u.id`,
    [username]
  );
  return result.rows[0] ?? null;
}
