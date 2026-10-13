import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
      // Migration 1024 must remove the worker role's default generic OUT permission.
      const workerGenericWrite=(await apiPool.query("SELECT COUNT(*)::int AS count FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='worker' AND p.code='cash_custody.create_own'")).rows[0];
      assert.equal(workerGenericWrite.count,0,"workers must not inherit generic custody write access");
      // Preserve one explicitly granted generic write in this fixture to test that explicit grants still work.
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='cash_custody.create_own' WHERE r.code='worker' ON CONFLICT DO NOTHING"
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
        "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code IN ('custody.view_own','cash_custody.view_own','advances.view_own') ON CONFLICT DO NOTHING",
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


      // View access must not imply permission to create generic or order-linked cash movements.
      const ownCashLedger=await app.inject({method:"GET",url:"/api/cash-custody",headers:{cookie:ownScopeCookie}});
      assert.equal(ownCashLedger.statusCode,200,ownCashLedger.body);
      const viewOnlyGenericWrite=await app.inject({method:"POST",url:"/api/cash-custody",headers:{cookie:ownScopeCookie},payload:{direction:"OUT",amount:1,transactionDate:"2099-01-10",description:"Must remain view-only"}});
      assert.equal(viewOnlyGenericWrite.statusCode,403,viewOnlyGenericWrite.body);
      const viewOnlyCollection=await app.inject({method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:ownScopeCookie},payload:{orderId:randomUUID(),amount:1,transactionDate:"2099-01-10",description:"Unauthorized collection",idempotencyKey:randomUUID()}});
      assert.equal(viewOnlyCollection.statusCode,403,viewOnlyCollection.body);
      const viewOnlyExpense=await app.inject({method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:ownScopeCookie},payload:{orderId:randomUUID(),amount:1,transactionDate:"2099-01-10",category:"Test",description:"Unauthorized order expense",idempotencyKey:randomUUID()}});
      assert.equal(viewOnlyExpense.statusCode,403,viewOnlyExpense.body);

      // Own-scope order actions must resolve the employee from the signed-in account and reject cross-employee targets.
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code IN ('cash_custody.order_collection_own','cash_custody.order_expense_own') ON CONFLICT DO NOTHING",
        [ownScopeRole.id]
      );
      const ownOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'IN_PROGRESS') RETURNING id",
        ["Own-scope collection integration order",manager.id]
      )).rows[0];
      const ownCollection=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:ownScopeCookie},
        payload:{orderId:ownOrder.id,amount:5,transactionDate:"2099-04-01",description:"Own-scope collection",idempotencyKey:randomUUID()}
      });
      assert.equal(ownCollection.statusCode,201,ownCollection.body);
      assert.equal(ownCollection.json().data.cashCustody.employee_id,ownScopeEmployee.id);
      const crossEmployeeCollection=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:ownScopeCookie},
        payload:{orderId:ownOrder.id,employeeId:employeeA.id,amount:5,transactionDate:"2099-04-01",description:"Cross-employee collection denied",idempotencyKey:randomUUID()}
      });
      assert.equal(crossEmployeeCollection.statusCode,403,crossEmployeeCollection.body);
      assert.equal(crossEmployeeCollection.json().error.code,"OWN_SCOPE_ONLY");
      const ownExpenseOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'IN_PROGRESS') RETURNING id",
        ["Own-scope expense integration order",manager.id]
      )).rows[0];
      const ownOrderExpense=await app.inject({
        method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:ownScopeCookie},
        payload:{orderId:ownExpenseOrder.id,amount:7,transactionDate:"2099-04-01",category:"Test",description:"Own-scope expense",idempotencyKey:randomUUID()}
      });
      assert.equal(ownOrderExpense.statusCode,201,ownOrderExpense.body);
      assert.equal(ownOrderExpense.json().data.cashCustody.employee_id,ownScopeEmployee.id);
      const crossEmployeeExpense=await app.inject({
        method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:ownScopeCookie},
        payload:{orderId:ownExpenseOrder.id,employeeId:employeeA.id,amount:7,transactionDate:"2099-04-01",category:"Test",description:"Cross-employee expense denied",idempotencyKey:randomUUID()}
      });
      assert.equal(crossEmployeeExpense.statusCode,403,crossEmployeeExpense.body);
      assert.equal(crossEmployeeExpense.json().error.code,"OWN_SCOPE_ONLY");
      const ownEligibleEmployees=await app.inject({method:"GET",url:"/api/custodies/eligible-employees",headers:{cookie:ownScopeCookie}});
      assert.equal(ownEligibleEmployees.statusCode,200,ownEligibleEmployees.body);
      assert.deepEqual(ownEligibleEmployees.json().data.map((x:{id:string})=>x.id),[ownScopeEmployee.id]);
      const ownEligibleOrders=await app.inject({method:"GET",url:"/api/cash-custody/eligible-orders",headers:{cookie:ownScopeCookie}});
      assert.equal(ownEligibleOrders.statusCode,200,ownEligibleOrders.body);
      assert.ok(ownEligibleOrders.json().data.some((x:{id:string})=>x.id===ownOrder.id));
      assert.ok(ownEligibleOrders.json().data.some((x:{id:string})=>x.id===ownExpenseOrder.id));

      // An employee without an explicit custody-view permission cannot read even their own custody.
      const assignedCustody = await app.inject({method:"GET",url:"/api/custodies",headers:{cookie:unprivilegedCookie}});
      assert.equal(assignedCustody.statusCode,403,assignedCustody.body);
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
      assert.equal(ownIncoming.statusCode, 403, ownIncoming.body);
      assert.equal(ownIncoming.json().error.code,"FINANCE_SCOPE_REQUIRED");
      const initialManagerTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,amount:100,transactionDate:"2099-01-10",description:"Opening employee custody balance"}
      });
      assert.equal(initialManagerTopUp.statusCode,201,initialManagerTopUp.body);

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
          description: "Factory expense temporarily covered by personal funds"
        }
      });
      assert.equal(overdraft.statusCode, 201, overdraft.body);
      assert.equal(overdraft.json().data.direction, "OUT");

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
      assert.equal(workerRows.json().data.length, 5);
      assert.ok(workerRows.json().data.every((row: { employee_id: string }) => row.employee_id === employeeA.id));
      assert.deepEqual(
        workerRows.json().data.map((row: { balance: string }) => Number(row.balance)).sort((a: number, b: number) => a - b),
        [-1, 23, 40, 70, 100],
        "running balances may go negative when factory expenses are covered by personal funds"
      );

      const managerEntry = await app.inject({
        method: "POST", url: "/api/cash-custody/top-ups", headers: { cookie: managerCookie },
        payload: {
          employeeId: employeeA.id, amount: 25,
          transactionDate: "2099-01-11", description: "Manager records additional custody"
        }
      });
      assert.equal(managerEntry.statusCode, 201, managerEntry.body);
      const unlinkedCashIn=await app.inject({
        method:"POST",url:"/api/cash-custody",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,direction:"IN",amount:26,transactionDate:"2099-01-12",description:"Must use the dedicated custody funding or order collection route"}
      });
      assert.equal(unlinkedCashIn.statusCode,409,unlinkedCashIn.body);
      assert.equal(unlinkedCashIn.json().error.code,"USE_CUSTODY_TOP_UP_OR_COLLECTION","manual IN movements must use a classified funding or collection flow");

      const audit = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM audit_log WHERE module='cash_custody' AND entity_type='cash_custody_transaction' AND actor_user_id=$1",
        [worker.id]
      );
      assert.equal(audit.rows[0].count, 4, "all successfully created worker transactions, including the overdraft, must be audited; external funding is manager-only");

      const profitabilityOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status,contract_value) VALUES($1,$2,'PLANNED',1000) RETURNING id",
        ["Custody funding profitability exclusion",manager.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by) VALUES($1,'REV-REAL-ORDER-TEST',25,'2099-01-12','MANUAL','genuine order revenue',$2)",
        [profitabilityOrder.id,manager.id]
      );
      const summaryBeforeLegacyFunding=await app.inject({method:"GET",url:"/api/accounting/summary",headers:{cookie:managerCookie}});
      assert.equal(summaryBeforeLegacyFunding.statusCode,200,summaryBeforeLegacyFunding.body);
      const legacyFunding=(await apiPool.query(
        "INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by) VALUES($1,'REV-LEGACY-FUNDING-TEST',99.99,'2099-01-12','EXTERNAL_CUSTODY_TOP_UP','legacy external custody funding',$2) RETURNING id",
        [profitabilityOrder.id,manager.id]
      )).rows[0];
      const legacyLowercaseFunding=(await apiPool.query(
        "INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by) VALUES($1,'REV-LEGACY-FUNDING-LOWER-TEST',49.99,'2099-01-12','external_custody_top_up','legacy lowercase external custody funding',$2) RETURNING id",
        [profitabilityOrder.id,manager.id]
      )).rows[0];
      const summaryAfterLegacyFunding=await app.inject({method:"GET",url:"/api/accounting/summary",headers:{cookie:managerCookie}});
      assert.equal(summaryAfterLegacyFunding.statusCode,200,summaryAfterLegacyFunding.body);
      assert.equal(Number(summaryAfterLegacyFunding.json().data.total_in),Number(summaryBeforeLegacyFunding.json().data.total_in),"legacy custody funding in either letter case must not inflate company revenue totals");
      const revenueCountBeforeTopUp=Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM order_revenues")).rows[0].count);
      const summaryBeforeTopUp=await app.inject({method:"GET",url:"/api/accounting/summary",headers:{cookie:managerCookie}});
      assert.equal(summaryBeforeTopUp.statusCode,200,summaryBeforeTopUp.body);
      const totalInBeforeTopUp=Number(summaryBeforeTopUp.json().data.total_in);
      const externalTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,amount:333.33,transactionDate:"2099-01-13",description:"External funding test",notes:"Company revenue and employee custody inflow"}
      });
      assert.equal(externalTopUp.statusCode,201,externalTopUp.body);
      assert.equal(externalTopUp.json().data.direction,"IN");
      assert.equal(externalTopUp.json().data.source_type,"EXTERNAL_TOP_UP");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM order_revenues")).rows[0].count),revenueCountBeforeTopUp,"external custody funding must not create a company revenue record");
      assert.equal(externalTopUp.json().data.revenue_code,undefined);
      const topUpRevenue=(await apiPool.query("SELECT * FROM order_revenues WHERE source='EXTERNAL_CUSTODY_TOP_UP' AND amount=333.33 AND revenue_date='2099-01-13'")).rows[0];
      assert.equal(topUpRevenue,undefined,"new external funding must not be posted to the sales revenue ledger");
      const topUpSummary=await app.inject({method:"GET",url:"/api/accounting/summary",headers:{cookie:managerCookie}});
      assert.equal(topUpSummary.statusCode,200,topUpSummary.body);
      assert.equal(Number(topUpSummary.json().data.total_in),totalInBeforeTopUp,"external custody funding must not increase company revenue");
      const revenueList=await app.inject({method:"GET",url:"/api/accounting/revenues",headers:{cookie:managerCookie}});
      assert.equal(revenueList.statusCode,200,revenueList.body);
      assert.equal(revenueList.json().data.some((row:{id:string})=>row.id===legacyFunding.id),false,"legacy custody funding must be excluded from the sales revenue list");
      assert.equal(revenueList.json().data.some((row:{id:string})=>row.id===legacyLowercaseFunding.id),false,"legacy lowercase custody funding must also be excluded from the sales revenue list");
      const orderDashboard=await app.inject({method:"GET",url:"/api/accounting/orders-dashboard",headers:{cookie:managerCookie}});
      assert.equal(orderDashboard.statusCode,200,orderDashboard.body);
      const orderDashboardRow=orderDashboard.json().data.find((row:{id:string})=>row.id===profitabilityOrder.id);
      assert.ok(orderDashboardRow,"the isolated test order must appear in the profitability dashboard");
      assert.equal(Number(orderDashboardRow.revenue),25,"the order dashboard must exclude both uppercase and lowercase legacy custody funding");
      const orderProfitability=await app.inject({method:"GET",url:"/api/accounting/orders/"+profitabilityOrder.id+"/profitability",headers:{cookie:managerCookie}});
      assert.equal(orderProfitability.statusCode,200,orderProfitability.body);
      assert.equal(Number(orderProfitability.json().data.revenue),25,"single-order profitability must exclude legacy custody funding");

      const allocationOrderA=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status,contract_value) VALUES($1,$2,'PLANNED',0) RETURNING id",
        ["Administrative allocation test order A",manager.id]
      )).rows[0];
      const allocationOrderB=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status,contract_value) VALUES($1,$2,'PLANNED',0) RETURNING id",
        ["Administrative allocation test order B",manager.id]
      )).rows[0];
      for (const [orderId,amount,description] of [
        [allocationOrderA.id,100,"Allocation cost basis A"],
        [allocationOrderB.id,300,"Allocation cost basis B"]
      ] as const) {
        const directCost=await app.inject({
          method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
          payload:{orderId,category:"Test direct cost",description,amount,expenseType:"DIRECT",expenseDate:"2099-04-05"}
        });
        assert.equal(directCost.statusCode,201,directCost.body);
      }
      const adminAllocationExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"Test administrative cost",description:"Allocation rounding and override test",amount:10,expenseType:"ADMINISTRATIVE",expenseDate:"2099-04-10"}
      });
      assert.equal(adminAllocationExpense.statusCode,201,adminAllocationExpense.body);
      const allocationPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Administrative allocation test",periodStart:"2099-04-01",periodEnd:"2099-04-30"}
      });
      assert.equal(allocationPeriod.statusCode,201,allocationPeriod.body);
      const allocationPeriodId=allocationPeriod.json().data.id;
      const autoAllocation=await app.inject({
        method:"POST",url:"/api/accounting/periods/"+allocationPeriodId+"/auto-allocate",headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(autoAllocation.statusCode,200,autoAllocation.body);
      const autoAllocationRows=(await apiPool.query(
        "SELECT order_id,amount FROM accounting_expense_allocations WHERE period_id=$1 AND expense_id=$2",
        [allocationPeriodId,adminAllocationExpense.json().data.id]
      )).rows;
      const allocationShareA=Number(autoAllocationRows.find((row:{order_id:string})=>row.order_id===allocationOrderA.id)?.amount);
      const allocationShareB=Number(autoAllocationRows.find((row:{order_id:string})=>row.order_id===allocationOrderB.id)?.amount);
      assert.ok(autoAllocationRows.length>=2,"automatic allocation should include both cost-bearing test orders");
      assert.ok(allocationShareA>0&&allocationShareB>0,"both test orders must receive a positive cost-weighted share");
      assert.ok(Math.abs(allocationShareB-allocationShareA*3)<=0.04,"the 300-cost order should receive approximately three times the share of the 100-cost order, with only cent-rounding differences");
      assert.equal(Math.round(autoAllocationRows.reduce((sum,row)=>sum+Number(row.amount),0)*100),1000,"automatic allocation must preserve the exact original administrative expense total to the cent");
      const adjustedAllocation=await app.inject({
        method:"PUT",url:"/api/accounting/periods/"+allocationPeriodId+"/allocations",headers:{cookie:managerCookie},
        payload:{allocations:[
          {expenseId:adminAllocationExpense.json().data.id,orderId:allocationOrderA.id,amount:4},
          {expenseId:adminAllocationExpense.json().data.id,orderId:allocationOrderB.id,amount:6}
        ]}
      });
      assert.equal(adjustedAllocation.statusCode,200,adjustedAllocation.body);
      const closeAllocationPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods/"+allocationPeriodId+"/close",headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(closeAllocationPeriod.statusCode,200,closeAllocationPeriod.body);
      const allocationProfitA=await app.inject({method:"GET",url:"/api/accounting/orders/"+allocationOrderA.id+"/profitability",headers:{cookie:managerCookie}});
      const allocationProfitB=await app.inject({method:"GET",url:"/api/accounting/orders/"+allocationOrderB.id+"/profitability",headers:{cookie:managerCookie}});
      assert.equal(allocationProfitA.statusCode,200,allocationProfitA.body);
      assert.equal(allocationProfitB.statusCode,200,allocationProfitB.body);
      assert.equal(Number(allocationProfitA.json().data.administrativeAllocation),4,"profitability must use the manually adjusted closed-period allocation");
      assert.equal(Number(allocationProfitB.json().data.administrativeAllocation),6,"the adjusted allocation must remain balanced to the original administrative expense");

      for (const reservedSource of ["EXTERNAL_CUSTODY_TOP_UP", "external_custody_top_up"]) {
        const misclassifiedFunding=await app.inject({
          method:"POST",url:"/api/accounting/revenues",headers:{cookie:managerCookie},
          payload:{amount:15,revenueDate:"2099-01-13",source:reservedSource,notes:"Must use custody funding endpoint"}
        });
        assert.equal(misclassifiedFunding.statusCode,422,misclassifiedFunding.body);
        assert.equal(misclassifiedFunding.json().error.code,"VALIDATION_ERROR");
      }
      const topUpAudit=await apiPool.query("SELECT after_data,metadata FROM audit_log WHERE module='cash_custody' AND entity_type='cash_custody_transaction' AND entity_id=$1",[externalTopUp.json().data.id]);
      assert.equal(topUpAudit.rowCount,1);
      assert.equal(topUpAudit.rows[0].metadata.companyRevenue,false,"audit must classify external top-up as funding, not revenue");
      const repeatedTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,amount:333.33,transactionDate:"2099-01-13",description:"Duplicate external funding test"}
      });
      assert.equal(repeatedTopUp.statusCode,409,repeatedTopUp.body);
      const confirmedRepeatedTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,amount:333.33,transactionDate:"2099-01-13",description:"A second, separately confirmed funding event",confirmDuplicate:true}
      });
      assert.equal(confirmedRepeatedTopUp.statusCode,201,confirmedRepeatedTopUp.body);
      assert.equal(confirmedRepeatedTopUp.json().data.confirmed_duplicate,true,"legitimate repeated funding must be allowed after explicit duplicate confirmation");
      const workerTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:workerCookie},
        payload:{employeeId:employeeA.id,amount:50,transactionDate:"2099-01-14",description:"Must be forbidden"}
      });
      assert.equal(workerTopUp.statusCode,403,workerTopUp.body);

      const transferSourceTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeB.id,amount:20,transactionDate:"2099-01-08",description:"Fund transfer source for integration test"}
      });
      assert.equal(transferSourceTopUp.statusCode,201,transferSourceTopUp.body);

      const cashTransfer=await app.inject({
        method:"POST",url:"/api/cash-custody/transfers",headers:{cookie:managerCookie},
        payload:{fromEmployeeId:employeeB.id,toEmployeeId:employeeA.id,amount:10,transactionDate:"2099-01-09",description:"Test cash custody transfer"}
      });
      assert.equal(cashTransfer.statusCode,201,cashTransfer.body);
      assert.equal(Number(cashTransfer.json().data.transfer.amount),10);
      assert.equal(cashTransfer.json().data.outgoing.direction,"OUT");
      assert.equal(cashTransfer.json().data.incoming.direction,"IN");
      assert.equal(cashTransfer.json().data.outgoing.transfer_id,cashTransfer.json().data.incoming.transfer_id);
      const custodyBeforeExpense=await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1 AND transaction_date<='2099-01-10'",
        [employeeB.id]
      );
      const custodyPaidExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"مصروف إداري",description:"Custody may go negative for factory expenses",amount:Number(custodyBeforeExpense.rows[0].balance)+1000,expenseType:"ADMINISTRATIVE",paidFromEmployeeId:employeeB.id,expenseDate:"2099-01-10"}
      });
      assert.equal(custodyPaidExpense.statusCode,201,custodyPaidExpense.body);
      assert.equal(custodyPaidExpense.json().data.expense_type,"ADMINISTRATIVE");
      assert.equal(custodyPaidExpense.json().data.paid_from_employee_id,employeeB.id);
      assert.ok(custodyPaidExpense.json().data.cash_custody_transaction_id);
      const negativeCustody=await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",
        [employeeB.id]
      );
      assert.ok(Number(negativeCustody.rows[0].balance)<0,"personal funds may temporarily cover a factory expense and make custody negative");

      // A later inflow must first settle the employee's negative custody balance.
      const negativeBalanceBeforeRecovery=Number(negativeCustody.rows[0].balance);
      const recoveryTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeB.id,amount:Math.abs(negativeBalanceBeforeRecovery),transactionDate:"2099-01-11",description:"Settle negative custody from later inflow"}
      });
      assert.equal(recoveryTopUp.statusCode,201,recoveryTopUp.body);
      const recoveredCustody=await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",
        [employeeB.id]
      );
      assert.ok(Math.abs(Number(recoveredCustody.rows[0].balance))<1e-7,"later custody inflow must settle the negative balance");

      const overdrawnTransfer=await app.inject({
        method:"POST",url:"/api/cash-custody/transfers",headers:{cookie:managerCookie},
        payload:{fromEmployeeId:employeeB.id,toEmployeeId:employeeA.id,amount:1,transactionDate:"2099-01-12",description:"Must not transfer without available balance"}
      });
      assert.equal(overdrawnTransfer.statusCode,409,overdrawnTransfer.body);
      assert.equal(overdrawnTransfer.json().error.code,"INSUFFICIENT_CASH_CUSTODY_BALANCE");

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

      const closedPeriodExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"مصروف إداري",description:"Must be rejected in closed period",amount:5,expenseType:"ADMINISTRATIVE",expenseDate:"2099-02-05"}
      });
      assert.equal(closedPeriodExpense.statusCode,409,closedPeriodExpense.body);
      assert.equal(closedPeriodExpense.json().error.code,"ACCOUNTING_PERIOD_CLOSED");

      const closedPeriodTopUp=await app.inject({
        method:"POST",url:"/api/cash-custody/top-ups",headers:{cookie:managerCookie},
        payload:{employeeId:employeeA.id,amount:11,transactionDate:"2099-02-05",description:"Must be rejected in closed period"}
      });
      assert.equal(closedPeriodTopUp.statusCode,409,closedPeriodTopUp.body);
      assert.equal(closedPeriodTopUp.json().error.code,"ACCOUNTING_PERIOD_CLOSED");

      const cancelledOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'CANCELLED') RETURNING id",
        ["Cancelled order finance guard",manager.id]
      )).rows[0];
      const cancelledOrderExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{orderId:cancelledOrder.id,category:"مصروف مباشر",description:"Must not post to cancelled order",amount:5,expenseType:"DIRECT",expenseDate:"2099-03-01"}
      });
      assert.equal(cancelledOrderExpense.statusCode,409,cancelledOrderExpense.body);
      assert.equal(cancelledOrderExpense.json().error.code,"ORDER_CANCELLED");
      const cancelledOrderRevenue=await app.inject({
        method:"POST",url:"/api/accounting/revenues",headers:{cookie:managerCookie},
        payload:{orderId:cancelledOrder.id,amount:5,revenueDate:"2099-03-01",source:"MANUAL"}
      });
      assert.equal(cancelledOrderRevenue.statusCode,409,cancelledOrderRevenue.body);
      assert.equal(cancelledOrderRevenue.json().error.code,"ORDER_CANCELLED");

      // A collection retry with the same idempotency key must return the original pair,
      // while a separate operation with identical amount/date/business fields is valid.
      const collectionOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'IN_PROGRESS') RETURNING id",
        ["Idempotency integration order",manager.id]
      )).rows[0];
      const draftOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'DRAFT') RETURNING id",
        ["Draft order must reject custody postings",manager.id]
      )).rows[0];
      for (const blockedStatus of ["DRAFT","COMPLETED","CANCELLED"]) {
        const blockedOrder=blockedStatus==="DRAFT"?draftOrder:(await apiPool.query(
          "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,$3) RETURNING id",
          [`Order ${blockedStatus} must reject custody posting`,manager.id,blockedStatus]
        )).rows[0];
        const blockedCollection=await app.inject({
          method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},
          payload:{orderId:blockedOrder.id,employeeId:employeeA.id,amount:10,transactionDate:"2099-03-10",description:`Collection on ${blockedStatus}`,idempotencyKey:randomUUID()}
        });
        assert.equal(blockedCollection.statusCode,409,blockedCollection.body);
        assert.equal(blockedCollection.json().error.code,"ORDER_NOT_COLLECTIBLE");
        const blockedExpense=await app.inject({
          method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:managerCookie},
          payload:{orderId:blockedOrder.id,employeeId:employeeA.id,amount:10,transactionDate:"2099-03-10",category:"Test",description:`Expense on ${blockedStatus}`,idempotencyKey:randomUUID()}
        });
        assert.equal(blockedExpense.statusCode,409,blockedExpense.body);
        assert.equal(blockedExpense.json().error.code,blockedStatus==="CANCELLED"?"ORDER_CANCELLED":"ORDER_NOT_EXPENSABLE");
        if(blockedStatus==="COMPLETED"){
          const completedAccountingExpense=await app.inject({
            method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
            payload:{orderId:blockedOrder.id,amount:10,expenseDate:"2099-03-10",category:"Test",description:"Completed order expense must be rejected",expenseType:"DIRECT",idempotencyKey:randomUUID()}
          });
          assert.equal(completedAccountingExpense.statusCode,409,completedAccountingExpense.body);
          assert.equal(completedAccountingExpense.json().error.code,"ORDER_NOT_EXPENSABLE");
          const completedAccountingRevenue=await app.inject({
            method:"POST",url:"/api/accounting/revenues",headers:{cookie:managerCookie},
            payload:{orderId:blockedOrder.id,amount:10,revenueDate:"2099-03-10",source:"MANUAL",notes:"Completed order revenue must be rejected",idempotencyKey:randomUUID()}
          });
          assert.equal(completedAccountingRevenue.statusCode,409,completedAccountingRevenue.body);
          assert.equal(completedAccountingRevenue.json().error.code,"ORDER_NOT_COLLECTIBLE");
        }
      }

      const expenseOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'IN_PROGRESS') RETURNING id",
        ["Idempotent custody expense order",manager.id]
      )).rows[0];
      const expensePayload={orderId:expenseOrder.id,employeeId:employeeA.id,amount:500,transactionDate:"2099-03-10",category:"مصروفات تشغيل",description:"Expense idempotency integration",notes:"retry safely",idempotencyKey:randomUUID()};
      const expenseFirst=await app.inject({method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:managerCookie},payload:expensePayload});
      assert.equal(expenseFirst.statusCode,201,expenseFirst.body);
      assert.ok(expenseFirst.json().data.expense.cash_custody_transaction_id);
      const expenseRetry=await app.inject({method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:managerCookie},payload:expensePayload});
      assert.equal(expenseRetry.statusCode,201,expenseRetry.body);
      assert.equal(expenseRetry.json().data.expense.id,expenseFirst.json().data.expense.id);
      assert.equal(expenseRetry.json().data.cashCustody.id,expenseFirst.json().data.cashCustody.id);
      const changedExpense=await app.inject({method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:managerCookie},payload:{...expensePayload,amount:501}});
      assert.equal(changedExpense.statusCode,409,changedExpense.body);
      assert.equal(changedExpense.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      const expenseCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",[expensePayload.idempotencyKey]);
      assert.equal(expenseCount.rows[0].count,1);
      const linkedCashCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='ACCOUNTING_EXPENSE' AND source_id=$1",[expenseFirst.json().data.expense.id]);
      assert.equal(linkedCashCount.rows[0].count,1);

      const concurrentOrderExpensePayload={orderId:expenseOrder.id,employeeId:employeeA.id,amount:1,transactionDate:"2099-03-12",category:"Test",description:"Concurrent order expense retry",idempotencyKey:randomUUID()};
      const concurrentOrderExpenses=await Promise.all([1,2].map(()=>app.inject({
        method:"POST",url:"/api/cash-custody/order-expenses",headers:{cookie:managerCookie},payload:concurrentOrderExpensePayload
      })));
      assert.ok(concurrentOrderExpenses.every(x=>x.statusCode===201),concurrentOrderExpenses.map(x=>x.body).join("\\n"));
      assert.equal(concurrentOrderExpenses[0].json().data.expense.id,concurrentOrderExpenses[1].json().data.expense.id);
      const concurrentOrderExpenseCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",[concurrentOrderExpensePayload.idempotencyKey]);
      assert.equal(concurrentOrderExpenseCount.rows[0].count,1,"concurrent custody expense retries must create exactly one expense");

      const genericExpensePayload={orderId:expenseOrder.id,amount:22.50,expenseDate:"2099-03-11",category:"نقل",description:"Accounting expense idempotency integration",expenseType:"DIRECT",paidFromEmployeeId:employeeB.id,idempotencyKey:randomUUID()};
      const genericExpenseFirst=await app.inject({method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},payload:genericExpensePayload});
      assert.equal(genericExpenseFirst.statusCode,201,genericExpenseFirst.body);
      assert.ok(genericExpenseFirst.json().data.cash_custody_transaction_id);
      const genericExpenseRetry=await app.inject({method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},payload:genericExpensePayload});
      assert.equal(genericExpenseRetry.statusCode,201,genericExpenseRetry.body);
      assert.equal(genericExpenseRetry.json().data.id,genericExpenseFirst.json().data.id);
      assert.equal(genericExpenseRetry.json().data.cash_custody_transaction_id,genericExpenseFirst.json().data.cash_custody_transaction_id);
      const genericExpenseChanged=await app.inject({method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},payload:{...genericExpensePayload,amount:23}});
      assert.equal(genericExpenseChanged.statusCode,409,genericExpenseChanged.body);
      assert.equal(genericExpenseChanged.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      const genericExpenseCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",[genericExpensePayload.idempotencyKey]);
      assert.equal(genericExpenseCount.rows[0].count,1);
      const genericCashCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='ACCOUNTING_EXPENSE' AND source_id=$1",[genericExpenseFirst.json().data.id]);
      assert.equal(genericCashCount.rows[0].count,1);

      const invalidPrecisionCollection=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},
        payload:{orderId:collectionOrder.id,employeeId:employeeA.id,amount:125.501,transactionDate:"2099-03-10",description:"Invalid precision collection",idempotencyKey:randomUUID()}
      });
      assert.equal(invalidPrecisionCollection.statusCode,422,invalidPrecisionCollection.body);
      const collectionPayload={
        orderId:collectionOrder.id,employeeId:employeeA.id,amount:125.50,
        transactionDate:"2099-03-10",description:"Customer collection idempotency test",
        notes:"Same request retry",idempotencyKey:randomUUID()
      };
      const collectionFirst=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},payload:collectionPayload
      });
      assert.equal(collectionFirst.statusCode,201,collectionFirst.body);
      const collectionRetry=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},payload:collectionPayload
      });
      assert.equal(collectionRetry.statusCode,201,collectionRetry.body);
      assert.equal(collectionRetry.json().data.revenue.id,collectionFirst.json().data.revenue.id);
      assert.equal(collectionRetry.json().data.cashCustody.id,collectionFirst.json().data.cashCustody.id);
      const collectionChanged={...collectionPayload,amount:126};
      const reusedKey=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},payload:collectionChanged
      });
      assert.equal(reusedKey.statusCode,409,reusedKey.body);
      assert.equal(reusedKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      const independentCollection=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},
        payload:{...collectionPayload,idempotencyKey:randomUUID()}
      });
      assert.equal(independentCollection.statusCode,201,independentCollection.body);
      assert.notEqual(independentCollection.json().data.revenue.id,collectionFirst.json().data.revenue.id);
      // A retry of a collection already committed before period close must still
      // return its original records; it must not attempt a new posting.
      const collectionPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Collection retry closed period",periodStart:"2099-03-01",periodEnd:"2099-03-31"}
      });
      assert.equal(collectionPeriod.statusCode,201,collectionPeriod.body);
      const closeCollectionPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods/"+collectionPeriod.json().data.id+"/close",headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(closeCollectionPeriod.statusCode,200,closeCollectionPeriod.body);
      const closedPeriodCollectionRetry=await app.inject({
        method:"POST",url:"/api/cash-custody/order-collections",headers:{cookie:managerCookie},payload:collectionPayload
      });
      assert.equal(closedPeriodCollectionRetry.statusCode,201,closedPeriodCollectionRetry.body);
      assert.equal(closedPeriodCollectionRetry.json().data.revenue.id,collectionFirst.json().data.revenue.id);
      assert.equal(closedPeriodCollectionRetry.json().data.cashCustody.id,collectionFirst.json().data.cashCustody.id);
      const collectionCounts=await apiPool.query(
        "SELECT COUNT(*)::int AS revenue_count FROM order_revenues WHERE order_id=$1 AND source='CUSTOMER_COLLECTION'",
        [collectionOrder.id]
      );
      assert.equal(collectionCounts.rows[0].revenue_count,2);
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
