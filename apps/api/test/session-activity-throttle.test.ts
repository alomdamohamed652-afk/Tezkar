import assert from "node:assert/strict";
import test from "node:test";
import { getSessionUser } from "../src/modules/auth/session.service.js";

function fakeClient(lastSeenAt: Date) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("SELECT u.id AS user_id")) {
        return {
          rows: [{
            user_id: "user-1",
            employee_id: "employee-1",
            username: "worker",
            full_name: "Worker",
            is_bootstrap: false,
            must_complete_setup: false,
            must_change_password: false,
            last_seen_at: lastSeenAt,
            role_codes: ["worker"],
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as import("pg").PoolClient;
  return { calls, client };
}

test("session authentication does not write last_seen_at on every request", async () => {
  const client = fakeClient(new Date(Date.now() - 10_000));
  const user = await getSessionUser(client.client, "opaque-session-token");

  assert.equal(user?.userId, "user-1");
  assert.deepEqual(user?.roleCodes, ["worker"]);
  assert.equal(client.calls.length, 1);
});

test("session activity is touched after the one-minute activity window", async () => {
  const client = fakeClient(new Date(Date.now() - 120_000));
  const user = await getSessionUser(client, "opaque-session-token");

  assert.equal(user?.userId, "user-1");
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].sql, /last_seen_at < now\(\) - interval '1 minute'/);
});
