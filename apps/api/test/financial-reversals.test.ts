import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {randomBytes,randomUUID} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";
const adminUrl=process.env.TEST_DATABASE_URL;
const apiDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("manual advance repayment reversal is append-only and reverses ledger and custody", {skip:!adminUrl&&"TEST_DATABASE_URL not set"}, async()=>{
 assert.ok(adminUrl);
 const url=new URL(adminUrl);assert.ok(["localhost","127.0.0.1","::1"].includes(url.hostname));assert.equal(url.pathname.slice(1),"postgres");
 const name="tezkar_reverse_"+randomBytes(5).toString("hex");
 const admin=new pg.Client({connectionString:adminUrl});await admin.connect();try{await admin.query(`CREATE DATABASE ${name}`)}finally{await admin.end()}
 const target=new URL(adminUrl);target.pathname="/"+name;let db:typeof import("../src/db/pool.js").pool|undefined;let app:{close:()=>Promise<void>}|undefined;
 try{
  const migration=spawnSync(process.execPath,["--import","tsx","src/db/migrate.ts"],{cwd:apiDir,env:{...process.env,DATABASE_URL:target.toString()},encoding:"utf8"});
  assert.equal(migration.status,0,migration.stderr||migration.stdout);
  process.env.DATABASE_URL=target.toString();process.env.WEB_ORIGIN="http://localhost:3000";process.env.SESSION_SECRET="reversal-integration-test-secret-long-enough";process.env.NODE_ENV="test";
  const [{default:Fastify},{default:cookie},{authRoutes},{accountingRoutes},{hashPassword},poolModule]=await Promise.all([import("fastify"),import("@fastify/cookie"),import("../src/modules/auth/auth.routes.js"),import("../src/modules/accounting/accounting.routes.js"),import("../src/modules/auth/auth.service.js"),import("../src/db/pool.js")]);
  db=poolModule.pool;const server=Fastify();app=server;await server.register(cookie,{secret:process.env.SESSION_SECRET});
  server.setErrorHandler((e,_q,reply)=>reply.code(typeof e.statusCode==="number"&&e.statusCode<500?e.statusCode:500).send({error:{code:e.code??"ERROR",message:e.message}}));
  await server.register(authRoutes);await server.register(accountingRoutes);
  const emp=(await db.query("INSERT INTO employees(full_name) VALUES('Reverse Test') RETURNING id")).rows[0].id;
  const password="Reversal-Test-2026!";const user=(await db.query("INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",[ "reverse-"+randomBytes(4).toString("hex"),hashPassword(password),emp])).rows[0].id;
  const username=(await db.query("SELECT username FROM users WHERE id=$1",[user])).rows[0].username;
  await db.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'",[user]);
  await db.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING");
  const adv=(await db.query("INSERT INTO advance_requests(employee_id,amount,reason,requested_by,status,paid_by,paid_at,repayment_status) VALUES($1,50,'test',$2,'PAID',$2,now(),'SETTLED') RETURNING id",[emp,user])).rows[0].id;
  const rep=(await db.query("INSERT INTO advance_repayments(advance_id,amount,repayment_type,created_by) VALUES($1,50,'CUSTOM',$2) RETURNING id",[adv,user])).rows[0].id;
  await db.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,advance_repayment_id) VALUES($1,'ADJUSTMENT',50,$2,$3)",[emp,user,rep]);
  await db.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by,source_type,source_id) VALUES($1,'IN',50,'test receipt',$2,'ADVANCE_REPAYMENT',$3)",[emp,user,rep]);
  const login=await server.inject({method:"POST",url:"/api/auth/login",payload:{username,password}});assert.equal(login.statusCode,200,login.body);
  const sc=login.headers["set-cookie"];assert.ok(sc);const cookieHeader=(Array.isArray(sc)?sc[0]:sc).split(";")[0];
  const payload={sourceType:"ADVANCE_REPAYMENT",sourceId:rep,amount:20,reason:"تصحيح السداد",idempotencyKey:randomUUID()};
  const response=await server.inject({method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload});assert.equal(response.statusCode,201,response.body);
  const check=await db.query("SELECT (SELECT COUNT(*) FROM advance_repayments WHERE id=$1) AS source_count,(SELECT SUM(amount) FROM financial_reversal_lines WHERE source_id=$1) AS reversed,(SELECT SUM(debit_amount) FROM employee_earnings_ledger WHERE employee_id=$2 AND notes LIKE '%عكس سداد سلفة%') AS debit,(SELECT SUM(amount) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$3 AND direction='OUT') AS custody,(SELECT repayment_status FROM advance_requests WHERE id=$4) AS status",[rep,emp,response.json().data.reversal.id,adv]);
  assert.equal(Number(check.rows[0].source_count),1);assert.equal(Number(check.rows[0].reversed),20);assert.equal(Number(check.rows[0].debit),20);assert.equal(Number(check.rows[0].custody),20);assert.equal(check.rows[0].status,"OPEN");
  assert.equal((await server.inject({method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload})).statusCode,200);
 }finally{if(app)await app.close();if(db)await db.end();const c=new pg.Client({connectionString:adminUrl});await c.connect();try{await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await c.end()}}
});
