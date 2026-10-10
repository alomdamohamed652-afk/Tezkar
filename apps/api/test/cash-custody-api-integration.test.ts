import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(value: string) {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "test DB must be local");
  assert.equal(url.pathname.slice(1), "postgres",
    "test DB admin connection must target disposable admin database postgres");
}

test("cash custody API enforces employee scope, duplicate confirmation, balance and audit trail", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_cash_custody_api_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;
  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir, env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-cash-custody-session-secret";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { custodyRoutes }, { advanceRoutes }, { accountingRoutes },
      { hashPassword }, poolModule] = await Promise.all([
      import("fastify"), import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/custody/custody.routes.js"),
      import("../src/modules/advances/advances.routes.js"),
      import("../src/modules/accounting/accounting.routes.js"),
      import("../src/modules/auth/auth.service.js"),
      import("../src/db/pool.js")
    ]);
    apiPool = poolModule.pool;
    const app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(custodyRoutes);
    await app.register(advanceRoutes);
    await app.register(accountingRoutes);

    try {
      const employeeA = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Test Employee A') RETURNING id"
      )).rows[0];
      const employeeB = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Test Employee B') RETURNING id"
      )).rows[0];
      const workerUsername = "cashwrk-" + randomBytes(4).toString("hex");
      const managerUsername = "cashmgr-" + randomBytes(4).toString("hex");
      const workerPassword = "Test-Cash-Worker-2026!";
      const managerPassword = "Test-Cash-Manager-2026!";
      const worker = (await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [workerUsername, hashPassword(workerPassword), employeeA.id]
      )).rows[0];
      const manager = (await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [managerUsername, hashPassword(managerPassword), employeeB.id]
      )).rows[0];
      const unprivilegedEmployee = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Unprivileged Employee') RETURNING id"
      )).rows[0];
      const ownScopeEmployee = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Own Scope Test Employee') RETURNING id"
      )).rows[0];
      const unprivilegedUsername = "cashnoperm-" + randomBytes(4).toString("hex");
      const unprivilegedPassword = "Test-Cash-No-Permission-2026!";
      await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE)",
        [unprivilegedUsername, hashPassword(unprivilegedPassword), unprivilegedEmployee.id]
      );
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker' ON CONFLICT DO NOTHING",
        [worker.id]
      );
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [manager.id]
      );
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );
      // Keep the granted all-scope permissions but remove the finance role name.
      // Access scope must follow RBAC permissions, not a hard-coded list of role codes.
      await apiPool.query("UPDATE roles SET code='cash_supervisor_test' WHERE code='manager'");

      const ownScopeRole=(await apiPool.query(
        "INSERT INTO roles(code,name,is_system) VALUES('own_scope_test','اختبار نطاق ذاتي',FALSE) RETURNING id"
      )).rows[0];
      const ownScopeUsername="ownscope-"+randomBytes(4).toString("hex");
      const ownScopePassword="Test-Own-Scope-2026!";
      const ownScopeUser=(await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [ownScopeUsername,hashPassword(ownScopePassword),ownScopeEmployee.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)",
        [ownScopeUser.id,ownScopeRole.id]
      );
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code IN ('custody.view_own','advances.view_own') ON CONFLICT DO NOTHING",
        [ownScopeRole.id]
      );

      // Seed records for distinct employees; each login is linked to only one employee.
      await apiPool.query(
        "INSERT INTO employee_custodies(employee_id,custody_type,description,quantity,unit_value,total_value,created_by) VALUES($1,'Test','Own scope custody',1,30,30,$2)",
        [ownScopeEmployee.id,ownScopeUser.id]
      );
      await apiPool.query(
        "INSERT INTO employee_custodies(employee_id,custody_type,description,quantity,unit_value,total_value,created_by) VALUES($1,'Test','Assigned custody without permission',2,15,30,$2)",
        [unprivilegedEmployee.id,manager.id]
      );
      await apiPool.query(
        "INSERT INTO employee_custodies(employee_id,custody_type,description,quantity,unit_value,total_value,created_by) VALUES($1,'Test','Employee A custody',1,10,10,$2),($3,'Test','Employee B custody',1,20,20,$4)",
        [employeeA.id,worker.id,employeeB.id,manager.id]
      );
      const advanceCreateScope=(await apiPool.query("SELECT scope FROM permissions WHERE code='advances.create'")).rows[0];
      assert.equal(advanceCreateScope?.scope,"all","advance creation must be an all-scope permission for administrative roles");

      async function login(username: string, password: string) {
        const response = await app.inject({
          method: "POST", url: "/api/auth/login", payload: { username, password }
        });
        assert.equal(response.statusCode, 200, response.body);
        const setCookie = response.headers["set-cookie"];
        assert.ok(setCookie);
        return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
      }

      const workerCookie = await login(workerUsername, workerPassword);
      const managerCookie = await login(managerUsername, managerPassword);
      const unprivilegedCookie = await login(unprivilegedUsername, unprivilegedPassword);
      const ownScopeCookie = await login(ownScopeUsername, ownScopePassword);

      // An employee with no custody permission can view only their assigned active custody.
      const assignedCustody = await app.inject({method:"GET",url:"/api/custodies",headers:{cookie:unprivilegedCookie}});
      assert.equal(assignedCustody.statusCode,200,assignedCustody.body);
      assert.equal(assignedCustody.json().data.length,1);
      assert.equal(assignedCustody.json().data[0].description,"Assigned custody without permission");
      const unprivilegedCustodyId=(await apiPool.query("SELECT id FROM employee_custodies WHERE employee_id=$1 AND description='Assigned custody without permission'",[unprivilegedEmployee.id])).rows[0].id;
      const closeAssignedCustody=await app.inject({method:"POST",url:"/api/custodies/"+unprivilegedCustodyId+"/settlements",headers:{cookie:managerCookie},payload:{returnedQuantity:2,lostQuantity:0,damageValue:0,shortageValue:0}});
      assert.equal(closeAssignedCustody.statusCode,201,closeAssignedCustody.body);
      const assignedAfterClose=await app.inject({method:"GET",url:"/api/custodies",headers:{cookie:unprivilegedCookie}});
      assert.equal(assignedAfterClose.statusCode,403,assignedAfterClose.body);

      const managerAdvance = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: managerCookie },
        payload: { employeeId: employeeA.id, amount: 50, reason: "RBAC integration test", repaymentMethod: "CUSTOM" }
      });
      assert.equal(managerAdvance.statusCode, 201, managerAdvance.body);

      const ownCustodies = await app.inject({
        method: "GET", url: "/api/custodies", headers: { cookie: ownScopeCookie }
      });
      assert.equal(ownCustodies.statusCode, 200, ownCustodies.body);
      assert.equal(ownCustodies.json().data.length, 1);
      assert.equal(ownCustodies.json().data[0].employee_id, ownScopeEmployee.id);

      const employeeACustody=(await apiPool.query(
        "SELECT id FROM employee_custodies WHERE employee_id=$1 AND description='Employee A custody'",
        [employeeA.id]
      )).rows[0];
      const custodyTransfer=await app.inject({
        method:"POST",url:"/api/custodies/"+employeeACustody.id+"/transfer",headers:{cookie:managerCookie},
        payload:{toEmployeeId:employeeB.id,notes:"Transfer integration test"}
      });
      assert.equal(custodyTransfer.statusCode,201,custodyTransfer.body);
      assert.equal(custodyTransfer.json().data.custody.employee_id,employeeB.id);
      assert.equal(Number(custodyTransfer.json().data.remainingQuantity),1);
      const transferHistory=await app.inject({method:"GET",url:"/api/custodies/"+employeeACustody.id+"/transfers",headers:{cookie:managerCookie}});
      assert.equal(transferHistory.statusCode,200,transferHistory.body);
      assert.equal(transferHistory.json().data.length,1);
      const lostCustody = await app.inject({
        method: "POST", url: "/api/custodies/"+employeeACustody.id+"/settlements",
        headers: { cookie: managerCookie },
        payload: { returnedQuantity: 0, lostQuantity: 1, damageValue: 0, shortageValue: 0 }
      });
      assert.equal(lostCustody.statusCode, 201, lostCustody.body);
      assert.equal(lostCustody.json().data.custody.status, "LOST");
      assert.equal(Number(lostCustody.json().data.remainingQuantity), 0);

      await apiPool.query(
        "INSERT INTO advance_requests(employee_id,amount,reason,requested_by) VALUES($1,75,'Own scope integration test',$2)",
        [ownScopeEmployee.id,manager.id]
      );
      const ownAdvances = await app.inject({
        method: "GET", url: "/api/advances", headers: { cookie: ownScopeCookie }
      });
      assert.equal(ownAdvances.statusCode, 200, ownAdvances.body);
      assert.equal(ownAdvances.json().data.length, 1);
      assert.equal(ownAdvances.json().data[0].employee_id, ownScopeEmployee.id);

      const unauthenticated = await app.inject({ method: "GET", url: "/api/cash-custody" });
      assert.equal(unauthenticated.statusCode, 401);

      const forbiddenRead = await app.inject({
        method: "GET", url: "/api/cash-custody", headers: { cookie: unprivilegedCookie }
      });
      assert.equal(forbiddenRead.statusCode, 403, forbiddenRead.body);
      const forbiddenWrite = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: unprivilegedCookie },
        payload: {
          direction: "IN", amount: 999, transactionDate: "2099-01-10",
          description: "Must be blocked without cash custody permission"
        }
      });
      assert.equal(forbiddenWrite.statusCode, 403, forbiddenWrite.body);

      const ownIncoming = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "IN", amount: 100, transactionDate: "2099-01-10",
          description: "Test custody advance received"
        }
      });
      assert.equal(ownIncoming.statusCode, 201, ownIncoming.body);

      const ownOutgoing = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Test custody cash spent"
        }
      });
      assert.equal(ownOutgoing.statusCode, 201, ownOutgoing.body);

      const duplicate = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Accidental duplicate"
        }
      });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
      assert.equal(duplicate.json().error.code, "DUPLICATE_CASH_CUSTODY");

      const confirmedDuplicate = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Intentionally repeated transaction", confirmDuplicate: true
        }
      });
      assert.equal(confirmedDuplicate.statusCode, 201, confirmedDuplicate.body);
      assert.equal(confirmedDuplicate.json().data.confirmed_duplicate, true);

      const concurrentDuplicates = await Promise.all([1, 2].map(index => app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 17, transactionDate: "2099-01-10",
          description: `Concurrent duplicate attempt ${index}`
        }
      })));
      assert.equal(concurrentDuplicates.filter(response => response.statusCode === 201).length, 1,
        concurrentDuplicates.map(response => `${response.statusCode}: ${response.body}`).join("\\n"));
      assert.equal(concurrentDuplicates.filter(response =>
        response.statusCode === 409 && response.json().error.code === "DUPLICATE_CASH_CUSTODY").length, 1);

      const overdraft = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 24, transactionDate: "2099-01-10",
          description: "Must not exceed the remaining cash custody balance"
        }
      });
      assert.equal(overdraft.statusCode, 409, overdraft.body);
      assert.equal(overdraft.json().error.code, "INSUFFICIENT_CASH_CUSTODY_BALANCE");

      const outOfScope = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          employeeId: employeeB.id, direction: "IN", amount: 500,
          transactionDate: "2099-01-10", description: "Attempt to edit another employee"
        }
      });
      assert.equal(outOfScope.statusCode, 403, outOfScope.body);
      assert.equal(outOfScope.json().error.code, "OWN_SCOPE_ONLY");

      const workerRows = await app.inject({
        method: "GET", url: "/api/cash-custody", headers: { cookie: workerCookie }
      });
      assert.equal(workerRows.statusCode, 200, workerRows.body);
      assert.equal(workerRows.json().data.length, 4);
      assert.ok(workerRows.json().data.every((row: { employee_id: string }) => row.employee_id === employeeA.id));
      assert.deepEqual(
        workerRows.json().data.map((row: { balance: string }) => Number(row.balance)).sort((a: number, b: number) => a - b),
        [23, 40, 70, 100],
        "each transaction must show the running balance immediately after that movement"
      );

      const managerEntry = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: managerCookie },
        payload: {
          employeeId: employeeA.id, direction: "IN", amount: 25,
          transactionDate: "2099-01-11", description: "Manager records additional custody"
        }
      });
      assert.equal(managerEntry.statusCode, 201, managerEntry.body);

      const audit = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM audit_log WHERE module='cash_custody' AND entity_type='cash_custody_transaction' AND actor_user_id=$1",
        [worker.id]
      );
      assert.equal(audit.rows[0].count, 4, "all successfully created worker transactions must be audited");

      const cashTransfer=await app.inject({
        method:"POST",url:"/api/cash-custody/transfers",headers:{cookie:managerCookie},
        payload:{fromEmployeeId:employeeA.id,toEmployeeId:employeeB.id,amount:10,transactionDate:"2099-01-10",description:"Test cash custody transfer"}
      });
      assert.equal(cashTransfer.statusCode,201,cashTransfer.body);
      assert.equal(Number(cashTransfer.json().data.transfer.amount),10);
      assert.equal(cashTransfer.json().data.outgoing.direction,"OUT");
      assert.equal(cashTransfer.json().data.incoming.direction,"IN");
      assert.equal(cashTransfer.json().data.outgoing.transfer_id,cashTransfer.json().data.incoming.transfer_id);
      const custodyPaidExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"مصروف إداري",description:"Negative custody expense integration test",amount:1000,expenseType:"ADMINISTRATIVE",paidFromEmployeeId:employeeB.id,expenseDate:"2099-01-10"}
      });
      assert.equal(custodyPaidExpense.statusCode,201,custodyPaidExpense.body);
      assert.equal(custodyPaidExpense.json().data.expense_type,"ADMINISTRATIVE");
      assert.equal(custodyPaidExpense.json().data.paid_from_employee_id,employeeB.id);
      assert.ok(custodyPaidExpense.json().data.cash_custody_transaction_id);
      const negativeCustody=await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",
        [employeeB.id]
      );
      assert.ok(Number(negativeCustody.rows[0].balance)<0,"an approved expense may make custody negative");

      const period=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Integration test period",periodStart:"2099-02-01",periodEnd:"2099-02-28"}
      });
      assert.equal(period.statusCode,201,period.body);
      const closedPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods/"+period.json().data.id+"/close",headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(closedPeriod.statusCode,200,closedPeriod.body);
      assert.equal(closedPeriod.json().data.status,"CLOSED");
    } finally {
      await app.close();
    }
  } finally {
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});
