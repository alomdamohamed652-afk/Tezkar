import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("task transfer history migration stores transfer audit data and validates reasons", {
  skip: !testDatabaseUrl
}, async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = "task_transfer_test_" + randomUUID().replaceAll("-", "");
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE users (id UUID PRIMARY KEY, username TEXT NOT NULL)");
    await client.query("CREATE TABLE employees (id UUID PRIMARY KEY, full_name TEXT NOT NULL, code TEXT NOT NULL)");
    await client.query("CREATE TABLE tasks (id UUID PRIMARY KEY)");
    const sql = await readFile(new URL("../src/db/migrations/1025_task_transfer_history.sql", import.meta.url), "utf8");
    await client.query(sql);

    const userId = randomUUID();
    const oldEmployeeId = randomUUID();
    const newEmployeeId = randomUUID();
    const taskId = randomUUID();
    await client.query("INSERT INTO users(id,username) VALUES($1,'transfer-test')", [userId]);
    await client.query("INSERT INTO employees(id,full_name,code) VALUES($1,'Old Employee','E001'),($2,'New Employee','E002')", [oldEmployeeId,newEmployeeId]);
    await client.query("INSERT INTO tasks(id) VALUES($1)", [taskId]);

    const saved = await client.query(
      "INSERT INTO task_transfer_history(task_id,from_assignees,to_employee_id,reason,transferred_by) VALUES($1,$2::jsonb,$3,$4,$5) RETURNING *",
      [taskId, JSON.stringify([{employee_id:oldEmployeeId,employee_name:"Old Employee",employee_code:"E001"}]), newEmployeeId, "توزيع عبء العمل", userId]
    );
    assert.equal(saved.rowCount, 1);
    assert.equal(saved.rows[0].to_employee_id, newEmployeeId);
    assert.equal(saved.rows[0].from_assignees[0].employee_id, oldEmployeeId);
    assert.equal(saved.rows[0].reason, "توزيع عبء العمل");
    await assert.rejects(
      client.query("INSERT INTO task_transfer_history(task_id,to_employee_id,reason,transferred_by) VALUES($1,$2,'  ',$3)", [taskId,newEmployeeId,userId]),
      /task_transfer_history_reason_check/
    );
    const rls = await client.query(
      "SELECT relrowsecurity FROM pg_class WHERE oid = 'task_transfer_history'::regclass"
    );
    assert.equal(rls.rows[0].relrowsecurity, true);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
