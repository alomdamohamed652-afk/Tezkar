import test from "node:test";
import assert from "node:assert/strict";
import { getAdminHealth, recordServerError } from "../src/modules/health/admin-health.service.js";

function mockDb(handlers: Array<[string, unknown[]]>) {
  return { async query(sql: string) {
    for (const [needle, rows] of handlers) if (sql.includes(needle)) return { rows };
    throw new Error("Unexpected query: " + sql);
  } };
}

test("admin health aggregates database, migrations, backup, failed logins", async () => {
  const db = mockDb([
    ["SELECT 1 AS ok", [{ ok: 1 }]],
    ["FROM schema_migrations ORDER BY version DESC", [{ version: "2026112302_cross_midnight", applied_at: "2026-11-23T10:00:00.000Z" }]],
    ["count(*)::int AS n FROM schema_migrations", [{ n: 42 }]],
    ["entity_type = 'system_backup'", [{ occurred_at: "2026-11-24T03:00:00.000Z" }]],
    ["interval '24 hours'", [{ n: 3 }]],
    ["ORDER BY occurred_at DESC LIMIT 10", [{ occurred_at: "2026-11-24T05:00:00.000Z", username: "admin", ip: "1.2.3.4" }]],
  ]);
  const health = await getAdminHealth(db as any);
  assert.equal(health.status, "ok");
  assert.equal(health.database.status, "ok");
  assert.ok(health.database.latencyMs !== null && health.database.latencyMs >= 0);
  assert.equal(health.migrations.count, 42);
  assert.equal(health.migrations.last?.version, "2026112302_cross_midnight");
  assert.equal(health.lastBackupAt, "2026-11-24T03:00:00.000Z");
  assert.equal(health.failedLogins24h, 3);
  assert.equal(health.recentFailedLogins.length, 1);
  assert.equal(health.recentFailedLogins[0].username, "admin");
});

test("admin health reports degraded when the database is down and never throws", async () => {
  const db = { async query() { throw new Error("connection refused"); } };
  const health = await getAdminHealth(db as any);
  assert.equal(health.status, "degraded");
  assert.equal(health.database.status, "down");
  assert.equal(health.database.latencyMs, null);
  assert.equal(health.migrations.last, null);
  assert.equal(health.lastBackupAt, null);
});

test("recordServerError keeps the newest errors first and caps the buffer", async () => {
  for (let i = 0; i < 60; i++) recordServerError({ route: "/api/x/" + i, method: "GET", message: "boom " + i });
  const db = mockDb([
    ["SELECT 1 AS ok", [{ ok: 1 }]],
    ["schema_migrations ORDER BY version DESC", []],
    ["count(*)::int AS n FROM schema_migrations", [{ n: 0 }]],
    ["entity_type = 'system_backup'", []],
    ["interval '24 hours'", [{ n: 0 }]],
    ["ORDER BY occurred_at DESC LIMIT 10", []],
  ]);
  const health = await getAdminHealth(db as any);
  assert.equal(health.recentErrors.length, 20);
  assert.equal(health.recentErrors[0].route, "/api/x/59");
  assert.equal(health.recentErrors[19].route, "/api/x/40");
});
