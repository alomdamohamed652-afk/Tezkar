import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl=process.env.TEST_DATABASE_URL;
const apiDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

function assertDisposableDatabaseUrl(value:string){
  const url=new URL(value);
  assert.ok(url.protocol==="postgres:"||url.protocol==="postgresql:");
  assert.ok(["localhost","127.0.0.1","::1"].includes(url.hostname.toLowerCase()),"test DB must be local");
  assert.equal(url.pathname.slice(1),"postgres","test DB admin connection must target postgres");
}

test("approving a worker payout atomically marks it paid and debits the available balance",{
  skip:!adminUrl&&"TEST_DATABASE_URL not set"
},async()=>{
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const name="tezkar_payment_api_"+randomBytes(6).toString("hex");
  const admin=new pg.Client({connectionString:adminUrl});
  await admin.connect();
  try{await admin.query(`CREATE DATABASE ${name}`)}finally{await admin.end()}
  const target=new URL(adminUrl);target.pathname="/"+name;
  let apiPool:typeof import("../src/db/pool.js").pool|undefined;
  try{
    const migration=spawnSync(process.execPath,["--import","tsx","src/db/migrate.ts"],{
      cwd:apiDir,env:{...process.env,DATABASE_URL:target.toString()},encoding:"utf8"
    });
    assert.equal(migration.status,0,migration.stderr||migration.stdout);
    process.env.DATABASE_URL=target.toString();
    process.env.WEB_ORIGIN="http://localhost:3000";
    process.env.SESSION_SECRET="test-only-payment-session-secret-long-enough";
    process.env.NODE_ENV="test";
    const [{default:Fastify},{default:cookie},{authRoutes},{paymentsRoutes},{hashPassword},poolModule]=await Promise.all([
      import("fastify"),import("@fastify/cookie"),import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/payments/payments.routes.js"),import("../src/modules/auth/auth.service.js"),
      import("../src/db/pool.js")
    ]);
    apiPool=poolModule.pool;
    const app=Fastify();
    await app.register(cookie,{secret:process.env.SESSION_SECRET});
    app.setErrorHandler((error,_request,reply)=>{
      const status=typeof error.statusCode==="number"&&error.statusCode<500?error.statusCode:500;
      reply.code(status).send({error:{code:error.code??"ERROR",message:error.message}});
    });
    await app.register(authRoutes);
    await app.register(paymentsRoutes);
    try{
      const managerEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Finance Manager') RETURNING id")).rows[0];
      const workerEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Payout Worker') RETURNING id")).rows[0];
      const managerUsername="paymgr-"+randomBytes(4).toString("hex");
      const workerUsername="paywrk-"+randomBytes(4).toString("hex");
      const manager=(await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [managerUsername,hashPassword("Test-Manager-Password-2026!"),managerEmployee.id])).rows[0];
      const worker=(await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [workerUsername,hashPassword("Test-Worker-Password-2026!"),workerEmployee.id])).rows[0];
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",[manager.id]);
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker' ON CONFLICT DO NOTHING",[worker.id]);
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING");
      await apiPool.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',1000,'test opening cash custody',$2)",[managerEmployee.id,manager.id]);
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',500,$2,'test-only earned balance')",
        [workerEmployee.id,manager.id]);

      async function login(username:string,password:string){
        const response=await app.inject({method:"POST",url:"/api/auth/login",payload:{username,password}});
        assert.equal(response.statusCode,200,response.body);
        const setCookie=response.headers["set-cookie"];assert.ok(setCookie);
        return (Array.isArray(setCookie)?setCookie[0]:setCookie).split(";")[0];
      }
      const workerCookie=await login(workerUsername,"Test-Worker-Password-2026!");
      const managerCookie=await login(managerUsername,"Test-Manager-Password-2026!");
      const request=await app.inject({
        method:"POST",url:"/api/payment-requests",headers:{cookie:workerCookie},
        payload:{amount:150,method:"INSTAPAY",transferReference:"IP-TEST-2026-001"}
      });
      assert.equal(request.statusCode,201,request.body);
      assert.equal(request.json().data.transfer_reference,"IP-TEST-2026-001");
      const requestId=request.json().data.id;
      const approved=await app.inject({
        method:"POST",url:`/api/payment-requests/${requestId}/approve`,headers:{cookie:managerCookie}
      });
      assert.equal(approved.statusCode,200,approved.body);
      assert.equal(approved.json().data.request.status,"PAID");
      assert.ok(approved.json().data.request.paid_payment_id);
      assert.equal(approved.json().data.payment.transfer_reference,"IP-TEST-2026-001");
      const custodyDebit=await apiPool.query("SELECT direction,amount,source_type,source_id,description FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[approved.json().data.payment.id]);
      assert.equal(custodyDebit.rowCount,1,"payment must create exactly one linked cash-custody debit");
      assert.equal(custodyDebit.rows[0].direction,"OUT");
      assert.equal(Number(custodyDebit.rows[0].amount),150);
      assert.equal(custodyDebit.rows[0].source_id,approved.json().data.payment.id);
      assert.match(custodyDebit.rows[0].description,/REQ-|طلب قبض/);

      const balance=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(balance.statusCode,200,balance.body);
      assert.equal(Number(balance.json().data.balance),350);
      const ledger=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount),0) AS credits,COALESCE(SUM(debit_amount),0) AS debits,COUNT(*) FILTER(WHERE entry_type='WORKER_PAYMENT')::int AS payment_entries FROM employee_earnings_ledger WHERE employee_id=$1",
        [workerEmployee.id]);
      assert.equal(Number(ledger.rows[0].credits),500);
      assert.equal(Number(ledger.rows[0].debits),150);
      assert.equal(Number(ledger.rows[0].payment_entries),1);

      const nextRequest=await app.inject({
        method:"POST",url:"/api/payment-requests",headers:{cookie:workerCookie},
        payload:{amount:150,method:"CASH"}
      });
      assert.equal(nextRequest.statusCode,201,nextRequest.body,"paid requests must not block a new request");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE payment_request_id=$1",[requestId])).rows[0].count),1);
    }finally{await app.close()}
  }finally{
    if(apiPool)await apiPool.end();
    const cleanup=new pg.Client({connectionString:adminUrl});
    try{await cleanup.connect();await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await cleanup.end()}
  }
});
