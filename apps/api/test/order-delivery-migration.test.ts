import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("order-price and delivery-detail migrations apply safely in an isolated schema", {
  skip: !testDatabaseUrl
}, async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = "order_delivery_migration_test_" + randomUUID().replaceAll("-", "");
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await client.query("CREATE TABLE users (id UUID PRIMARY KEY)");
    await client.query("CREATE TABLE employees (id UUID PRIMARY KEY, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await client.query("CREATE TABLE production_orders (id UUID PRIMARY KEY)");
    await client.query("CREATE TABLE order_stages (id UUID PRIMARY KEY)");
    await client.query("CREATE TABLE production_entries (id UUID PRIMARY KEY)");
    await client.query("CREATE TABLE delivery_permissions (id UUID PRIMARY KEY, order_id UUID, destination TEXT, notes TEXT, status TEXT, created_by UUID)");
    await client.query("CREATE TABLE delivery_permission_lines (id UUID PRIMARY KEY, delivery_permission_id UUID, product_id UUID, warehouse_id UUID, location_id UUID, quantity NUMERIC, unit_id UUID, carton_code TEXT)");

    for (const [file, version] of [
      ["1013_order_price_changes_and_delivery_details.sql", "1013_order_price_changes_and_delivery_details"],
      ["1014_production_shift_leader.sql", "1014_production_shift_leader"],
      ["1015_employee_payout_preferences.sql", "1015_employee_payout_preferences"],
      ["1016_user_notifications.sql", "1016_user_notifications"]
    ]) {
      const sql = await readFile(new URL("../src/db/migrations/" + file, import.meta.url), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING", [version]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const columns = await client.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1",
      [schema]
    );
    const available = new Set(columns.rows.map((x: {table_name:string;column_name:string}) => x.table_name + "." + x.column_name));
    for (const column of [
      "delivery_permissions.total_weight", "delivery_permissions.piece_count",
      "delivery_permissions.sample_quantity", "delivery_permissions.details",
      "delivery_permission_lines.carton_weight", "delivery_permission_lines.piece_count",
      "delivery_permission_lines.sample_quantity", "delivery_permission_lines.details",
      "production_entries.shift_leader_employee_id", "employees.instapay_handle", "employees.vodafone_cash_number", "employees.preferred_payment_method", "order_price_changes.scope",
      "order_price_change_items.delta_amount", "order_price_change_items.ledger_adjustment"
    ]) assert.ok(available.has(column), "missing migrated column " + column);

    const userId = randomUUID(), employeeId = randomUUID(), orderId = randomUUID(), stageId = randomUUID(), entryId = randomUUID();
    await client.query("INSERT INTO users(id) VALUES($1)", [userId]);
    await client.query("INSERT INTO employees(id) VALUES($1)", [employeeId]);
    await client.query("INSERT INTO production_orders(id) VALUES($1)", [orderId]);
    await client.query("INSERT INTO order_stages(id) VALUES($1)", [stageId]);
    await client.query("INSERT INTO production_entries(id,shift_leader_employee_id) VALUES($1,$2)", [entryId, employeeId]);
    const change = await client.query(
      "INSERT INTO order_price_changes(order_id,order_stage_id,new_rate,scope,reason,created_by) VALUES($1,$2,12.5,'ALL','تعديل سعر تجريبي',$3) RETURNING id",
      [orderId, stageId, userId]
    );
    await client.query(
      "INSERT INTO order_price_change_items(price_change_id,production_entry_id,employee_id,previous_earning,revised_earning,delta_amount,applied_rate) VALUES($1,$2,$3,10,12.5,2.5,12.5)",
      [change.rows[0].id, entryId, employeeId]
    );
    await assert.rejects(
      client.query("INSERT INTO order_price_changes(order_id,order_stage_id,new_rate,scope,reason,created_by) VALUES($1,$2,12.5,'INVALID','اختبار',$3)", [orderId, stageId, userId]),
      /order_price_changes_scope_check/
    );
    const applied = await client.query("SELECT version FROM schema_migrations WHERE version IN ('1013_order_price_changes_and_delivery_details','1014_production_shift_leader','1015_employee_payout_preferences','1016_user_notifications')");
    assert.equal(applied.rowCount, 4);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
