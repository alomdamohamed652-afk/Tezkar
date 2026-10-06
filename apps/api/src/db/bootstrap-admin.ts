import { pool, withTransaction } from "./pool.js";
import { hashPassword } from "../modules/auth/auth.service.js";

const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (!username || !password) {
  throw new Error("BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required");
}
if (password.length < 12) {
  throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
}

await withTransaction(async (client) => {
  const existing = await client.query("SELECT id FROM users WHERE username = $1", [username]);
  if (existing.rows[0]) {
    console.log("Bootstrap admin already exists; no changes made.");
    return;
  }

  const user = await client.query(
    `INSERT INTO users (username, password_hash, is_bootstrap, must_complete_setup)
     VALUES ($1, $2, TRUE, TRUE)
     RETURNING id, username`,
    [username, hashPassword(password)]
  );

  await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = 'manager'
     ON CONFLICT DO NOTHING`,
    [user.rows[0].id]
  );

  console.log(`Bootstrap manager created: ${user.rows[0].username}. First login must complete admin setup.`);
});

await pool.end();
