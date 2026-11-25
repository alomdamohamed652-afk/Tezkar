import test from "node:test";
import assert from "node:assert/strict";
import { getAdminHealth, maskIp, maskUsername, recordServerError } from "../src/modules/health/admin-health.service.js";

function mockDb(handlers: Array<[string, unknown[]]>) {
  return { async query(sql: string) {
    for (const [needle, rows] of handlers) if (sql.includes(needle)) return { rows };
    throw new Error("Unexpected query: " + sql);
  } };
}

test("admin health aggregates database, migrations, backup, failed logins", async () => {
  const db = mockDb([
    ["SELECT 1 AS ok", [{ ok: 1 }]],
    ["information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'applied_at'", [{ exists: 1 }]],
    ["FROM schema_migrations\n       WHERE version ~ '^[0-9]{10}_'", [{ version: "2026112302_cross_midnight", applied_at: "2026-11-23T10:00:00.000Z" }]],
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
  assert.equal(health.recentFailedLogins[0].username, "a***");
  assert.equal(health.recentFailedLogins[0].ip, "1.2.*.*");
});

test("admin health reports degraded when the database is down and never throws", async () => {
  const db = { async query() { throw new Error("connection refused"); } };
  const health = await getAdminHealth(db as any);
  assert.equal(health.status, "degraded");
  assert.equal(health.database.status, "down");
  assert.equal(health.database.latencyMs, null);
  assert.equal(health.migrations.last, null);
  assert.equal(health.lastBackupAt, null);
  assert.equal(health.diagnostics.migrations.countAvailable, false);
  assert.equal(health.diagnostics.backupExportAudit.available, false);
  assert.equal(health.diagnostics.failedLoginCount.available, false);
  assert.equal(health.diagnostics.recentFailedLogins.available, false);
});

test("admin health reads a production-shaped ledger without applied_at and still reports the latest dated migration", async () => {
  const captured: string[] = [];
  const db = { async query(sql: string) {
    captured.push(sql);
    if (sql.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }] };
    if (sql.includes("information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'applied_at'")) return { rows: [] };
    if (sql.includes("FROM schema_migrations\n       WHERE version ~ '^[0-9]{10}_'")) return { rows: [{ version: "2026112408_attendance_unpaid_leave_day_status" }] };
    if (sql.includes("count(*)::int AS n FROM schema_migrations")) return { rows: [{ n: 166 }] };
    if (sql.includes("entity_type = 'system_backup'")) return { rows: [] };
    if (sql.includes("interval '24 hours'")) return { rows: [{ n: 0 }] };
    if (sql.includes("ORDER BY occurred_at DESC LIMIT 10")) return { rows: [] };
    throw new Error("Unexpected query: " + sql);
  } };
  const health = await getAdminHealth(db as any);
  assert.equal(health.migrations.last?.version, "2026112408_attendance_unpaid_leave_day_status");
  assert.equal(health.migrations.last?.appliedAt, null);
  assert.equal(health.diagnostics.migrations.latestAvailable, true);
  const latestQuery = captured.find(sql => sql.includes("FROM schema_migrations\n       WHERE"));
  assert.ok(latestQuery && latestQuery.includes("ORDER BY substring(version from '^[0-9]+')::bigint DESC"), "latest query must order by the numeric date prefix");
  assert.ok(latestQuery && !latestQuery.includes("applied_at"), "query must not reference applied_at when the column is missing");
});

test("recordServerError keeps the newest errors first and caps the buffer", async () => {
  for (let i = 0; i < 60; i++) recordServerError({ route: "/api/x/" + i, method: "GET", name: "Error" });
  const db = mockDb([
    ["SELECT 1 AS ok", [{ ok: 1 }]],
    ["information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'applied_at'", [{ exists: 1 }]],
    ["FROM schema_migrations\n       WHERE version ~ '^[0-9]{10}_'", []],
    ["count(*)::int AS n FROM schema_migrations", [{ n: 0 }]],
    ["entity_type = 'system_backup'", []],
    ["interval '24 hours'", [{ n: 0 }]],
    ["ORDER BY occurred_at DESC LIMIT 10", []],
  ]);
  const health = await getAdminHealth(db as any);
  assert.equal(health.recentErrors.length, 20);
  assert.equal(health.recentErrors[0].route, "/api/x/59");
  assert.equal(health.recentErrors[19].route, "/api/x/40");
  assert.equal(health.recentErrors[0].name, "Error");
  assert.ok(!("message" in health.recentErrors[0]), "raw error messages must not be exposed");
});

test("maskUsername and maskIp minimize failed sign-in identifiers", () => {
  assert.equal(maskUsername("admin"), "a***");
  assert.equal(maskUsername("  mohamed  "), "m***");
  assert.equal(maskUsername(""), null);
  assert.equal(maskUsername(null), null);
  assert.equal(maskIp("197.32.14.200"), "197.32.*.*");
  assert.equal(maskIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::*");
  assert.equal(maskIp("not-an-ip"), "***");
  assert.equal(maskIp(null), null);
});
