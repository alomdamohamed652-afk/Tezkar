import type pg from "pg";

export async function findUserForLogin(client: pg.PoolClient, username: string) {
  const result = await client.query(
    `SELECT u.id, u.username, u.password_hash, u.employee_id, u.is_active,
            u.is_bootstrap, u.must_complete_setup, u.must_change_password,
            COALESCE(u.full_name, e.full_name) AS full_name,
            COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.username = $1
        OR (
          length(regexp_replace(COALESCE(e.phone, ''), '[^0-9]', '', 'g')) >= 10
          AND RIGHT(regexp_replace(COALESCE(e.phone, ''), '[^0-9]', '', 'g'), 10)
              = RIGHT(regexp_replace($1, '[^0-9]', '', 'g'), 10)
          AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10
        )
     GROUP BY u.id, e.full_name
     ORDER BY CASE WHEN u.username = $1 THEN 0 ELSE 1 END
     LIMIT 2`,
    [username]
  );
  if (result.rows.length > 1 && result.rows[0].username !== username) return null;
  return result.rows[0] ?? null;
}

export async function isFirstRunSetupRequired(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM users
       WHERE is_active = TRUE AND is_bootstrap = TRUE AND must_complete_setup = TRUE
     ) AS required`
  );
  return Boolean(result.rows[0]?.required);
}
