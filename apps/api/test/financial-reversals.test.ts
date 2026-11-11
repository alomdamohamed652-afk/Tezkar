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
  const indexCheck=await poolModule.pool.query("SELECT to_regclass('public.uq_advance_repayments_source_payroll_item_advance') AS old_index,to_regclass('public.uq_advance_repayments_source_payment_advance') AS new_index");
  assert.equal(indexCheck.rows[0].old_index,null,"legacy payroll-item uniqueness must be removed to permit re-settlement");
  assert.ok(indexCheck.rows[0].new_index,"repayments must be unique per actual payroll payment and advance");
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

  // Payroll reversal must validate every linked advance ledger posting before
  // writing any reversal rows, then reverse the complete payroll/advance bundle.
  const payrollPeriod=(await db.query(
    "INSERT INTO payroll_periods(period_month,status,generated_by,approved_by,approved_at) VALUES('2099-06-01','APPROVED',$1,$1,now()) RETURNING id",[user]
  )).rows[0].id;
  const payrollItem=(await db.query(
    "INSERT INTO payroll_items(period_id,employee_id,base_salary,status) VALUES($1,$2,100,'PAID') RETURNING id",
    [payrollPeriod,emp]
  )).rows[0].id;
  const payrollPayment=(await db.query(
    "INSERT INTO payroll_payments(payroll_item_id,amount,payment_date,payment_method,settlement_source,paid_by,idempotency_key,idempotency_fingerprint) VALUES($1,100,'2099-06-30','CASH','CURRENT_CUSTODY',$2,$3,'reversal-test') RETURNING id",
    [payrollItem,user,randomUUID()]
  )).rows[0].id;
  const payrollAdvance=(await db.query(
    "INSERT INTO advance_requests(employee_id,amount,reason,requested_by,status,paid_by,paid_at,repayment_status) VALUES($1,20,'payroll reversal test',$2,'PAID',$2,now(),'SETTLED') RETURNING id",
    [emp,user]
  )).rows[0].id;
  const payrollRepayment=(await db.query(
    "INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,created_by,source_payroll_item_id,source_payroll_payment_id) VALUES($1,20,'FIXED_INSTALLMENT','2099-06-30',$2,$3,$4) RETURNING id",
    [payrollAdvance,user,payrollItem,payrollPayment]
  )).rows[0].id;
  await db.query(
    "INSERT INTO payroll_advance_deductions(payroll_item_id,advance_id,amount,repayment_type) VALUES($1,$2,20,'FIXED_INSTALLMENT')",
    [payrollItem,payrollAdvance]
  );
  await db.query(
    "INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes,payroll_payment_id) VALUES($1,'ADJUSTMENT',120,$2,'payroll plus advance offset',$3)",
    [emp,user,payrollPayment]
  );
  await db.query(
    "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes,advance_repayment_id) VALUES($1,'ADJUSTMENT',20,$2,'advance repayment',$3)",
    [emp,user,payrollRepayment]
  );
  await db.query(
    "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id) VALUES($1,'IN',20,'2099-06-30','advance offset',$2,'PAYROLL_ADVANCE_REPAYMENT_OFFSET',$3)",
    [emp,user,payrollPayment]
  );
  await db.query(
    "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id) VALUES($1,'OUT',120,'2099-06-30','payroll cash out',$2,'PAYROLL_PAYMENT',$3)",
    [emp,user,payrollPayment]
  );
  // A bad linked repayment ledger must abort atomically and leave no reversal header.
  await db.query("UPDATE employee_earnings_ledger SET credit_amount=19 WHERE advance_repayment_id=$1",[payrollRepayment]);
  const rejectedPayrollReversal=await server.inject({
    method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},
    payload:{sourceType:"PAYROLL_PAYMENT",sourceId:payrollPayment,amount:100,reason:"عكس راتب اختباري",idempotencyKey:randomUUID()}
  });
  assert.equal(rejectedPayrollReversal.statusCode,409,rejectedPayrollReversal.body);
  assert.equal(rejectedPayrollReversal.json().error.code,"REVERSAL_ADVANCE_LEDGER_MISMATCH");
  assert.equal(Number((await db.query("SELECT COUNT(*)::int AS count FROM financial_reversals")).rows[0].count),1,
    "a failed payroll reversal must not leave a partial reversal header");
  await db.query("UPDATE employee_earnings_ledger SET credit_amount=20 WHERE advance_repayment_id=$1",[payrollRepayment]);
  const payrollReversalPayload={sourceType:"PAYROLL_PAYMENT",sourceId:payrollPayment,amount:100,reason:"عكس راتب اختباري",idempotencyKey:randomUUID()};
  const payrollReversal=await server.inject({
    method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload:payrollReversalPayload
  });
  assert.equal(payrollReversal.statusCode,201,payrollReversal.body);
  assert.equal(payrollReversal.json().data.lines.length,2,"payroll and its linked repayment must reverse as one bundle");
  const payrollReversalReplay=await server.inject({
    method:"POST",url:"/api/accounting/reversals",headers:{cookie:cookieHeader},payload:payrollReversalPayload
  });
  assert.equal(payrollReversalReplay.statusCode,200,payrollReversalReplay.body);
  assert.equal(payrollReversalReplay.json().data.reversal.id,payrollReversal.json().data.reversal.id,
    "replaying a payroll reversal must not duplicate its bundle");
  const payrollReversalState=await db.query(
    `SELECT
      (SELECT COUNT(*)::int FROM payroll_payments WHERE id=$1) AS payment_count,
      (SELECT COUNT(*)::int FROM advance_repayments WHERE id=$2) AS repayment_count,
      (SELECT COUNT(*)::int FROM financial_reversal_lines WHERE reversal_id=$3) AS line_count,
      (SELECT repayment_status FROM advance_requests WHERE id=$4) AS advance_status,
      (SELECT COUNT(*)::int FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$3) AS reversal_custody_count,
      (SELECT COALESCE(SUM(credit_amount),0) FROM employee_earnings_ledger WHERE notes LIKE '%عكس صرف راتب%' AND notes LIKE '%' || $1::text || '%') AS payroll_ledger_credit,
      (SELECT COALESCE(SUM(debit_amount),0) FROM employee_earnings_ledger WHERE notes LIKE '%عكس سداد سلفة%' AND notes LIKE '%' || $2::text || '%') AS advance_ledger_debit,
      (SELECT COALESCE(SUM(amount),0) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$3 AND direction='IN') AS custody_in,
      (SELECT COALESCE(SUM(amount),0) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$3 AND direction='OUT') AS custody_out`,
    [payrollPayment,payrollRepayment,payrollReversal.json().data.reversal.id,payrollAdvance]
  );
  assert.equal(Number(payrollReversalState.rows[0].payment_count),1,"original payroll payment must remain immutable");
  assert.equal(Number(payrollReversalState.rows[0].repayment_count),1,"original advance repayment must remain immutable");
  assert.equal(Number(payrollReversalState.rows[0].line_count),2);
  assert.equal(payrollReversalState.rows[0].advance_status,"OPEN","reversing payroll must restore the advance balance");
  assert.equal(Number(payrollReversalState.rows[0].reversal_custody_count),2,
    "cash reversal must separately restore payroll cash and undo the advance offset");
  assert.equal(Number(payrollReversalState.rows[0].payroll_ledger_credit),120,
    "the payroll ledger debit must be fully reversed, including the advance offset");
  assert.equal(Number(payrollReversalState.rows[0].advance_ledger_debit),20,
    "the advance repayment credit must be reversed independently");
  assert.equal(Number(payrollReversalState.rows[0].custody_in),120);
  assert.equal(Number(payrollReversalState.rows[0].custody_out),20);

  // Worker-payment reversal restores the exact gross ledger balance, linked advance,
  // current custodian cash, and the source expense without mutating original rows.
  const workerPaymentKey=randomUUID();
  const workerPayment=(await db.query(
    `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,idempotency_key,idempotency_fingerprint)
     VALUES($1,80,100,20,'CASH',$2,$3,'worker-payment-reversal-test') RETURNING id`,
    [emp,user,workerPaymentKey]
  )).rows[0].id;
  const workerSettlement=(await db.query(
    `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
     VALUES($1,100,80,20,'2099-07-01','تسوية طلب قبض صرف مباشر بدون طلب قبض',$2,$3) RETURNING id`,
    [emp,user,workerPayment]
  )).rows[0].id;
  const workerAdvance=(await db.query(
    `INSERT INTO advance_requests(employee_id,amount,reason,requested_by,status,paid_by,paid_at,repayment_status)
     VALUES($1,20,'worker payment reversal',$2,'PAID',$2,now(),'SETTLED') RETURNING id`,
    [emp,user]
  )).rows[0].id;
  const workerRepayment=(await db.query(
    `INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,created_by,source_worker_payment_id,settlement_id)
     VALUES($1,20,'CUSTOM','2099-07-01',$2,$3,$4) RETURNING id`,
    [workerAdvance,user,workerPayment,workerSettlement]
  )).rows[0].id;
  await db.query(
    `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,worker_payment_id,settlement_id,created_by,notes)
     VALUES($1,'WORKER_PAYMENT',100,$2,$3,$4,'worker payment gross debit')`,
    [emp,workerPayment,workerSettlement,user]
  );
  await db.query(
    `INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,advance_repayment_id,created_by,notes)
     VALUES($1,'ADJUSTMENT',20,$2,$3,'worker payment advance offset')`,
    [emp,workerRepayment,user]
  );
  const workerCustodyOut=(await db.query(
    `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
     VALUES($1,'OUT',80,'2099-07-01','worker payment cash out',$2,'WORKER_PAYMENT',$3) RETURNING id`,
    [emp,user,workerPayment]
  )).rows[0].id;
  await db.query(
    `INSERT INTO accounting_expenses(category,description,amount,expense_date,payment_method,created_by,expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash,cash_custody_transaction_id,allocation_type,source_worker_payment_id)
     VALUES('WORKER_PAYMENT','worker payment reversal expense',100,'2099-07-01','CASH',$1,'DIRECT',$2,$3,'worker-payment-expense-test',$4,'GENERAL',$5)`,
    [user,emp,randomUUID(),workerCustodyOut,workerPayment]
  );
  const workerPayload={sourceType:'WORKER_PAYMENT',sourceId:workerPayment,amount:100,reason:'عكس دفعة عامل اختبارية',idempotencyKey:randomUUID()};
  const workerReversal=await server.inject({method:'POST',url:'/api/accounting/reversals',headers:{cookie:cookieHeader},payload:workerPayload});
  assert.equal(workerReversal.statusCode,201,workerReversal.body);
  assert.equal(workerReversal.json().data.lines.length,2,'worker payment and linked advance repayment must be reversed together');
  const workerReplay=await server.inject({method:'POST',url:'/api/accounting/reversals',headers:{cookie:cookieHeader},payload:workerPayload});
  assert.equal(workerReplay.statusCode,200,workerReplay.body);
  const workerState=await db.query(
    `SELECT
      (SELECT COUNT(*)::int FROM worker_payments WHERE id=$1) AS original_payment_count,
      (SELECT COUNT(*)::int FROM advance_repayments WHERE id=$2) AS original_repayment_count,
      (SELECT COUNT(*)::int FROM accounting_expense_reversals WHERE source_worker_payment_id=$1) AS expense_reversal_count,
      (SELECT COALESCE(SUM(amount),0) FROM accounting_expense_reversals WHERE source_worker_payment_id=$1) AS expense_reversed,
      (SELECT COALESCE(SUM(credit_amount),0) FROM employee_earnings_ledger WHERE notes LIKE '%عكس دفعة العامل%' AND notes LIKE '%' || $1::text || '%') AS worker_ledger_credit,
      (SELECT COALESCE(SUM(debit_amount),0) FROM employee_earnings_ledger WHERE notes LIKE '%عكس سداد سلفة%' AND notes LIKE '%' || $2::text || '%') AS advance_ledger_debit,
      (SELECT COALESCE(SUM(amount),0) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$3 AND direction='IN') AS custody_in,
      (SELECT repayment_status FROM advance_requests WHERE id=$4) AS advance_status`,
    [workerPayment,workerRepayment,workerReversal.json().data.reversal.id,workerAdvance]
  );
  assert.equal(Number(workerState.rows[0].original_payment_count),1);
  assert.equal(Number(workerState.rows[0].original_repayment_count),1);
  assert.equal(Number(workerState.rows[0].expense_reversal_count),1);
  assert.equal(Number(workerState.rows[0].expense_reversed),100);
  assert.equal(Number(workerState.rows[0].worker_ledger_credit),100);
  assert.equal(Number(workerState.rows[0].advance_ledger_debit),20);
  assert.equal(Number(workerState.rows[0].custody_in),80);
  assert.equal(workerState.rows[0].advance_status,'OPEN');

  // Previous-custody settlements have no current cash OUT and must not create a
  // fictitious cash IN when reversed.
  const previousPayment=(await db.query(
    `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,idempotency_key,idempotency_fingerprint)
     VALUES($1,50,50,0,'CASH',$2,$3,'previous-custody-reversal-test') RETURNING id`,
    [emp,user,randomUUID()]
  )).rows[0].id;
  const previousSettlement=(await db.query(
    `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
     VALUES($1,50,50,0,'2099-07-02','تسوية طلب قبض تسوية من عهدة سابقة',$2,$3) RETURNING id`,
    [emp,user,previousPayment]
  )).rows[0].id;
  await db.query(
    `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,worker_payment_id,settlement_id,created_by,notes)
     VALUES($1,'WORKER_PAYMENT',50,$2,$3,$4,'previous custody worker payment')`,
    [emp,previousPayment,previousSettlement,user]
  );
  await db.query(
    `INSERT INTO accounting_expenses(category,description,amount,expense_date,payment_method,created_by,expense_type,idempotency_key,idempotency_payload_hash,allocation_type,source_worker_payment_id)
     VALUES('WORKER_PAYMENT','previous custody expense',50,'2099-07-02','CASH',$1,'DIRECT',$2,'previous-custody-expense-test','GENERAL',$3)`,
    [user,randomUUID(),previousPayment]
  );
  const previousPayload={sourceType:'WORKER_PAYMENT',sourceId:previousPayment,amount:50,reason:'عكس تسوية عهدة سابقة اختبارية',idempotencyKey:randomUUID()};
  const previousReversal=await server.inject({method:'POST',url:'/api/accounting/reversals',headers:{cookie:cookieHeader},payload:previousPayload});
  assert.equal(previousReversal.statusCode,201,previousReversal.body);
  const previousCash=await db.query(
    "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$1",
    [previousReversal.json().data.reversal.id]
  );
  assert.equal(Number(previousCash.rows[0].count),0,'previous-custody reversal must not create a cash movement');
 }finally{if(app)await app.close();if(db)await db.end();const c=new pg.Client({connectionString:adminUrl});await c.connect();try{await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await c.end()}}
});
