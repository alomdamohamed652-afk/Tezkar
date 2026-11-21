import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("user notification migration supports per-user unread inbox records", {
  skip: !testDatabaseUrl
}, async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = "user_notifications_test_" + randomUUID().replaceAll("-", "");
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())");
    await client.query("CREATE TABLE users (id UUID PRIMARY KEY)");
    const sql = await readFile(new URL("../src/db/migrations/1027_user_notifications.sql", import.meta.url), "utf8");
    await client.query(sql);

    const userId = randomUUID();
    await client.query("INSERT INTO users(id) VALUES($1)", [userId]);
    const inserted = await client.query(
      "INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id) VALUES($1,'TASK_TRANSFER','تم إسناد مهمة إليك','تم إسناد مهمة تجريبية إليك','task',$2) RETURNING id,read_at",
      [userId, randomUUID()]
    );
    assert.equal(inserted.rowCount, 1);
    assert.equal(inserted.rows[0].read_at, null);
    const unread = await client.query("SELECT count(*)::int AS count FROM user_notifications WHERE user_id=$1 AND read_at IS NULL", [userId]);
    assert.equal(unread.rows[0].count, 1);
    await client.query("UPDATE user_notifications SET read_at=now() WHERE id=$1 AND user_id=$2", [inserted.rows[0].id,userId]);
    const read = await client.query("SELECT read_at FROM user_notifications WHERE id=$1", [inserted.rows[0].id]);
    assert.ok(read.rows[0].read_at);
    const rls = await client.query("SELECT relrowsecurity FROM pg_class WHERE oid='user_notifications'::regclass");
    assert.equal(rls.rows[0].relrowsecurity, true);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
