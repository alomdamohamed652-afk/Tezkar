import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { getSessionUser } from "../src/modules/auth/session.service.js";

function sessionClient() {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM user_sessions s")) {
        return {
          rows: [{
            user_id: "user-1",
            employee_id: null,
            username: "manager",
            full_name: "Manager",
            is_bootstrap: false,
            must_complete_setup: false,
            must_change_password: false,
            last_seen_at: new Date(0),
            role_codes: ["manager"]
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  return { client: client as unknown as pg.PoolClient, statements };
}

test("session authentication can validate a session without writing last_seen_at", async () => {
  const { client, statements } = sessionClient();
  const user = await getSessionUser(client, "session-token", { touchLastSeen: false });

  assert.equal(user?.userId, "user-1");
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /FROM user_sessions s/);
  assert.equal(statements.some(sql => /UPDATE user_sessions/i.test(sql)), false);
});

test("ordinary session authentication keeps the existing last_seen_at refresh behavior", async () => {
  const { client, statements } = sessionClient();
  const user = await getSessionUser(client, "session-token");

  assert.equal(user?.userId, "user-1");
  assert.equal(statements.length, 2);
  assert.match(statements[1]!, /UPDATE user_sessions SET last_seen_at/);
});
