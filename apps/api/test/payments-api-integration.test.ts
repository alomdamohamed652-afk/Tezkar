import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
    const [{default:Fastify},{default:cookie},{authRoutes},{paymentsRoutes},{historicalProductionSettlementRoutes},{globalSearchRoutes},{accountingRoutes},{operationsMasterRoutes},{warehouseRoutes},{orderRoutes},{productionRoutes},{reportsRoutes},{allocatePendingWorkerPaymentDifferencesForProduction,processMaturedWorkerPaymentDifferences},{taskRoutes},{hashPassword},poolModule]=await Promise.all([
      import("fastify"),import("@fastify/cookie"),import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/payments/payments.routes.js"),import("../src/modules/payments/historical-production-settlements.routes.js"),import("../src/modules/search/global-search.routes.js"),import("../src/modules/accounting/accounting.routes.js"),import("../src/modules/operations-master/operations-master.routes.js"),import("../src/modules/warehouse/warehouse.routes.js"),import("../src/modules/orders/orders.routes.js"),import("../src/modules/production/production.routes.js"),
      import("../src/modules/reports/reports.routes.js"),import("../src/modules/payments/worker-payment-differences.service.js"),import("../src/modules/tasks/tasks.routes.js"),import("../src/modules/auth/auth.service.js"),
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
    await app.register(historicalProductionSettlementRoutes);
    await app.register(globalSearchRoutes);
    await app.register(accountingRoutes);
    await app.register(operationsMasterRoutes);
    await app.register(warehouseRoutes);
    await app.register(orderRoutes);
    await app.register(productionRoutes);
    await app.register(reportsRoutes);
    await app.register(taskRoutes);
    try{
      const managerEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Finance Manager') RETURNING id")).rows[0];
      const workerEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Payout Worker') RETURNING id")).rows[0];
      const emptyCustodianEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Empty Cash Custodian') RETURNING id")).rows[0];
      const bonusWorkerEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Bonus Deduction Worker') RETURNING id")).rows[0];
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
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' AND p.code<>'finance.period_close.review' ON CONFLICT DO NOTHING");
      await apiPool.query("DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE code='manager') AND permission_id=(SELECT id FROM permissions WHERE code='finance.period_close.review')");
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
      const accountantEmployee=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Period Accountant') RETURNING id")).rows[0];
      const accountantUsername="periodacct-"+randomBytes(4).toString("hex");
      const accountantPassword="Test-Period-Accountant-2026!";
      const accountant=(await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [accountantUsername,hashPassword(accountantPassword),accountantEmployee.id])).rows[0];
      await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='accountant' ON CONFLICT DO NOTHING",[accountant.id]);
      const workerCookie=await login(workerUsername,"Test-Worker-Password-2026!");
      const managerCookie=await login(managerUsername,"Test-Manager-Password-2026!");
      const accountantCookie=await login(accountantUsername,accountantPassword);

      // Worker settlement-difference permissions must be separated from ordinary
      // worker access: workers cannot inspect financial differences or trigger
      // accounting review/maturity operations.
      const workerDifferenceListDenied=await app.inject({
        method:"GET",url:"/api/accounting/worker-settlement-differences",headers:{cookie:workerCookie}
      });
      assert.equal(workerDifferenceListDenied.statusCode,403,workerDifferenceListDenied.body);
      const workerDifferenceEventsDenied=await app.inject({
        method:"GET",url:`/api/accounting/worker-settlement-differences/${randomUUID()}/events`,
        headers:{cookie:workerCookie}
      });
      assert.equal(workerDifferenceEventsDenied.statusCode,403,workerDifferenceEventsDenied.body);
      const workerDifferenceReleaseDenied=await app.inject({
        method:"POST",url:`/api/accounting/worker-settlement-differences/${randomUUID()}/release`,
        headers:{cookie:workerCookie},payload:{reason:"محاولة غير مصرح بها",idempotencyKey:randomUUID()}
      });
      assert.equal(workerDifferenceReleaseDenied.statusCode,403,workerDifferenceReleaseDenied.body);
      const workerDifferenceProcessDenied=await app.inject({
        method:"POST",url:"/api/accounting/worker-settlement-differences/process",
        headers:{cookie:workerCookie},payload:{}
      });
      assert.equal(workerDifferenceProcessDenied.statusCode,403,workerDifferenceProcessDenied.body);
      const managerDifferenceListAllowed=await app.inject({
        method:"GET",url:"/api/accounting/worker-settlement-differences",headers:{cookie:managerCookie}
      });
      assert.equal(managerDifferenceListAllowed.statusCode,200,managerDifferenceListAllowed.body);
      const accountantDifferenceListAllowed=await app.inject({
        method:"GET",url:"/api/accounting/worker-settlement-differences",headers:{cookie:accountantCookie}
      });
      assert.equal(accountantDifferenceListAllowed.statusCode,200,accountantDifferenceListAllowed.body);
      const assignedWorkerTask=(await apiPool.query(
        "INSERT INTO tasks(title,created_by) VALUES('Worker badge count test task',$1) RETURNING id",[manager.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)",
        [assignedWorkerTask.id,workerEmployee.id,manager.id]
      );
      await apiPool.query("INSERT INTO tasks(title,created_by) VALUES('Manager-only badge count test task',$1)",[manager.id]);
      const workerTaskCount=await app.inject({method:"GET",url:"/api/tasks/pending-count",headers:{cookie:workerCookie}});
      assert.equal(workerTaskCount.statusCode,200,workerTaskCount.body);
      assert.equal(workerTaskCount.json().data.count,1,"worker task badge must count only tasks assigned to that employee");
      const managerTaskCount=await app.inject({method:"GET",url:"/api/tasks/pending-count",headers:{cookie:managerCookie}});
      assert.equal(managerTaskCount.statusCode,200,managerTaskCount.body);
      assert.equal(managerTaskCount.json().data.count,2,"manager task badge must count all open tasks within the manager all scope");
      const integrityOverview=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(integrityOverview.statusCode,200,integrityOverview.body);
      const integrityCounts=integrityOverview.json().data.counts;
      for(const key of [
        "missingPayrollExpenses","missingAdjustmentLedgerEntries","cashPaymentsMissingCustodyOut",
        "payrollPaymentMismatches","advanceDeductionMismatches","paidPayrollMissingAdvanceRepayments","expensesMissingCustodyLink",
        "workerPaymentReversalMismatches","workerDifferenceEventReversalMismatches"
      ]){
        assert.equal(typeof integrityCounts[key],"number",`financial integrity overview must return numeric count for ${key}`);
      }

      async function closePeriodWithApproval(periodId:string){
        const submitted=await app.inject({method:"POST",url:"/api/accounting/periods/"+periodId+"/submit-review",headers:{cookie:accountantCookie},payload:{}});
        assert.equal(submitted.statusCode,200,submitted.body);
        const reviewed=await app.inject({method:"POST",url:"/api/accounting/periods/"+periodId+"/approve-review",headers:{cookie:accountantCookie},payload:{}});
        assert.equal(reviewed.statusCode,200,reviewed.body);
        return app.inject({method:"POST",url:"/api/accounting/periods/"+periodId+"/close",headers:{cookie:managerCookie},payload:{}});
      }

      const settlementSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${workerEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(settlementSummary.statusCode,200,settlementSummary.body);
      const summaryBody=settlementSummary.json().data;
      assert.equal(summaryBody.employee.id,workerEmployee.id);
      assert.equal(Number(summaryBody.availableForSettlement),500);
      assert.equal(Number(summaryBody.availableBreakdown.calculatedAvailable),500,
        "diagnostic breakdown must match the legacy ledger fallback when no approved production exists");
      assert.equal(summaryBody.availableBreakdown.calculationMode,"LEDGER_FALLBACK");
      assert.equal(Number(summaryBody.productionEarnings),0);
      assert.equal(Number(summaryBody.previouslySettled),0);
      assert.equal(Number(summaryBody.outstandingAdvances),0);
      const productSuffix=randomBytes(4).toString("hex");
      // Product names that differ only by Arabic hamza should resolve to the same active catalog product.
      const hamzaName="مقلمه مطبوعه (أنا لها) "+productSuffix;
      const plainAlefName="مقلمه مطبوعه (انا لها) "+productSuffix;
      const hamzaOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{orderName:"Arabic hamza product test A "+productSuffix,finalProductName:hamzaName,finalQuantity:5}
      });
      assert.equal(hamzaOrder.statusCode,201,hamzaOrder.body);
      const plainAlefOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{orderName:"Arabic hamza product test B "+productSuffix,finalProductName:plainAlefName,finalQuantity:3}
      });
      assert.equal(plainAlefOrder.statusCode,201,plainAlefOrder.body,"Arabic hamza spelling must not trigger a duplicate-product 500");
      const hamzaProducts=await apiPool.query(
        "SELECT DISTINCT product_id FROM production_order_lines WHERE order_id=ANY($1::uuid[])",
        [[hamzaOrder.json().data.id,plainAlefOrder.json().data.id]]
      );
      assert.equal(hamzaProducts.rowCount,1,"both Arabic spellings should reuse the same product record");

      
      // Concurrent order creation with Arabic spellings that normalize to the same catalog name.
      const parallelNameA="مقلمه مطبوعه (أنا لها) concurrent "+productSuffix;
      const parallelNameB="مقلمه مطبوعه (انا لها) concurrent "+productSuffix;
      const parallelOrders=await Promise.all(Array.from({length:4},(_,index)=>app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{
          orderName:"Concurrent normalized product order "+index+" "+productSuffix,
          finalProductName:index%2===0?parallelNameA:parallelNameB,
          finalQuantity:index+1
        }
      })));
      assert.ok(parallelOrders.every(response=>response.statusCode===201),
        "parallel order requests must reuse the normalized product rather than return a duplicate-key 500: "+parallelOrders.map(x=>x.body).join(" | "));
      const parallelOrderIds=parallelOrders.map(response=>response.json().data.id);
      const parallelProductIds=await apiPool.query(
        "SELECT DISTINCT product_id FROM production_order_lines WHERE order_id=ANY($1::uuid[])",
        [parallelOrderIds]
      );
      assert.equal(parallelProductIds.rowCount,1,"parallel requests with equivalent Arabic product names must resolve to one product");

      
      const variantOrders=await Promise.all([
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Case whitespace variant A "+productSuffix,
          finalProductName:"  Mixed   CASE Product "+productSuffix,finalQuantity:2
        }}),
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Case whitespace variant B "+productSuffix,
          finalProductName:"mixed case product "+productSuffix,finalQuantity:3
        }}),
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Arabic tashkeel variant A "+productSuffix,
          finalProductName:"مُقَلَّمَة مطبوعة "+productSuffix,finalQuantity:4
        }}),
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Arabic tashkeel variant B "+productSuffix,
          finalProductName:"مقلمة مطبوعة "+productSuffix,finalQuantity:5
        }})
      ]);
      assert.ok(variantOrders.every(response=>response.statusCode===201),
        "case, whitespace and Arabic tashkeel variants must not cause order creation failures: "+variantOrders.map(x=>x.body).join(" | "));
      const variantIds=variantOrders.map(response=>response.json().data.id);
      const variantProducts=await apiPool.query(
        "SELECT pol.order_id,pol.product_id FROM production_order_lines pol WHERE pol.order_id=ANY($1::uuid[])",
        [variantIds]
      );
      const productForOrder=new Map(variantProducts.rows.map(row=>[row.order_id,row.product_id]));
      assert.equal(productForOrder.get(variantIds[0]),productForOrder.get(variantIds[1]),
        "case and repeated whitespace variants must reuse one catalog product");
      assert.equal(productForOrder.get(variantIds[2]),productForOrder.get(variantIds[3]),
        "Arabic tashkeel variants must reuse one catalog product");

      const superscriptAlefOrders=await Promise.all([
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Arabic superscript alef variant A "+productSuffix,
          finalProductName:"هٰذا المنتج "+productSuffix,finalQuantity:2
        }}),
        app.inject({method:"POST",url:"/api/orders",headers:{cookie:managerCookie},payload:{
          orderName:"Arabic superscript alef variant B "+productSuffix,
          finalProductName:"هذا المنتج "+productSuffix,finalQuantity:3
        }})
      ]);
      assert.ok(superscriptAlefOrders.every(response=>response.statusCode===201),
        superscriptAlefOrders.map(x=>x.body).join(" | "));
      const superscriptAlefIds=superscriptAlefOrders.map(response=>response.json().data.id);
      const superscriptAlefProducts=await apiPool.query(
        "SELECT DISTINCT product_id FROM production_order_lines WHERE order_id=ANY($1::uuid[])",
        [superscriptAlefIds]
      );
      assert.equal(superscriptAlefProducts.rowCount,1,
        "Arabic superscript alef variants must reuse one catalog product");

      // If product resolution fails after the order row is tentatively inserted, the transaction must leave no partial order.
      const rejectedOrderName="Rollback invalid product order "+productSuffix;
      const rejectedOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{orderName:rejectedOrderName,lines:[{productId:"00000000-0000-4000-8000-000000000001",quantity:2}]}
      });
      assert.equal(rejectedOrder.statusCode,422,rejectedOrder.body);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM production_orders WHERE order_name=$1",[rejectedOrderName])).rows[0].count),0,
        "failed product resolution must roll back the parent order row");
      const multiProductOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{
          orderName:"Multi-final-product test "+productSuffix,
          customerName:"Isolated integration test",
          // A legacy order-line payload must not override products explicitly selected on stages.
          lines:[{productName:"Legacy stale line "+productSuffix,quantity:99}],
          stages:[
            {stageName:"Prepare A "+productSuffix,outputProductName:"WIP A "+productSuffix,sequenceNo:1,plannedQuantity:10,stageRate:1,stageRateMethod:"PER_PIECE",isFinalProduct:false},
            {stageName:"Finish A "+productSuffix,outputProductName:"Finished A "+productSuffix,sequenceNo:2,plannedQuantity:10,stageRate:2,stageRateMethod:"PER_PIECE",isFinalProduct:true},
            {stageName:"Prepare B "+productSuffix,outputProductName:"WIP B "+productSuffix,sequenceNo:3,plannedQuantity:20,stageRate:1,stageRateMethod:"PER_PIECE",isFinalProduct:false},
            {stageName:"Finish B "+productSuffix,outputProductName:"Finished B "+productSuffix,sequenceNo:4,plannedQuantity:20,stageRate:2,stageRateMethod:"PER_PIECE",isFinalProduct:true}
          ]
        }
      });
      assert.equal(multiProductOrder.statusCode,201,multiProductOrder.body);
      const multiOrderId=multiProductOrder.json().data.id;
      const finalLines=await apiPool.query(
        "SELECT p.name,pol.quantity,os.is_final_product FROM production_order_lines pol JOIN products p ON p.id=pol.product_id LEFT JOIN order_stages os ON os.order_id=pol.order_id AND os.output_product_id=pol.product_id AND os.is_final_product=TRUE WHERE pol.order_id=$1 ORDER BY p.name",
        [multiOrderId]
      );
      assert.equal(finalLines.rowCount,2,"one order must retain each distinct final product");
      assert.deepEqual(finalLines.rows.map(row=>({name:row.name,quantity:Number(row.quantity)})),[
        {name:"Finished A "+productSuffix,quantity:10},
        {name:"Finished B "+productSuffix,quantity:20}
      ]);
      assert.ok(finalLines.rows.every(row=>row.is_final_product===true));
      const multiDashboard=await app.inject({method:"GET",url:"/api/orders/"+multiOrderId+"/dashboard",headers:{cookie:managerCookie}});
      assert.equal(multiDashboard.statusCode,200,multiDashboard.body);
      assert.equal(multiDashboard.json().data.finalProducts.length,2);
      assert.equal(multiDashboard.json().data.finalProduct,null,"single-product compatibility field must be null for multi-product orders");
      const finalStageRows=await apiPool.query("SELECT sequence_no,is_final_product FROM order_stages WHERE order_id=$1 ORDER BY sequence_no",[multiOrderId]);
      assert.deepEqual(finalStageRows.rows.map(row=>({sequence:Number(row.sequence_no),isFinal:row.is_final_product})),[
        {sequence:1,isFinal:false},{sequence:2,isFinal:true},{sequence:3,isFinal:false},{sequence:4,isFinal:true}
      ]);

      const finalStageLineLinks=await apiPool.query(
        `SELECT os.id AS stage_id,os.order_item_id,os.output_product_id,os.planned_quantity,
                pol.id AS line_id,pol.product_id AS line_product_id,pol.quantity AS line_quantity
           FROM order_stages os
           LEFT JOIN production_order_lines pol ON pol.id=os.order_item_id AND pol.order_id=os.order_id
          WHERE os.order_id=$1 AND os.is_final_product=TRUE
          ORDER BY os.sequence_no`,
        [multiOrderId]
      );
      assert.equal(finalStageLineLinks.rowCount,2);
      assert.ok(finalStageLineLinks.rows.every(row=>row.line_id&&row.order_item_id===row.line_id),"each final stage must reference a real line in this order");
      assert.ok(finalStageLineLinks.rows.every(row=>row.output_product_id===row.line_product_id),"stage output and linked order line must use the same product");
      assert.ok(finalStageLineLinks.rows.every(row=>Number(row.planned_quantity)===Number(row.line_quantity)),"each line quantity must match its own final stage");

      // The same catalog product can appear as two distinct deliverables/lines.
      const repeatedProductName="Repeated final product "+productSuffix;
      const repeatedOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{
          orderName:"Repeated final product lines "+productSuffix,
          lines:[],
          stages:[
            {stageName:"Repeated finish one "+productSuffix,outputProductName:repeatedProductName,sequenceNo:1,plannedQuantity:3,stageRate:1,stageRateMethod:"PER_PIECE",isFinalProduct:true},
            {stageName:"Repeated finish two "+productSuffix,outputProductName:repeatedProductName,sequenceNo:2,plannedQuantity:7,stageRate:1,stageRateMethod:"PER_PIECE",isFinalProduct:true}
          ]
        }
      });
      assert.equal(repeatedOrder.statusCode,201,repeatedOrder.body);
      const repeatedOrderId=repeatedOrder.json().data.id;
      const repeatedLines=await apiPool.query(
        `SELECT os.order_item_id,os.planned_quantity,pol.id AS line_id,pol.product_id,pol.quantity AS line_quantity
           FROM order_stages os
           JOIN production_order_lines pol ON pol.id=os.order_item_id AND pol.order_id=os.order_id
          WHERE os.order_id=$1 AND os.is_final_product=TRUE
          ORDER BY os.sequence_no`,
        [repeatedOrderId]
      );
      assert.equal(repeatedLines.rowCount,2,"same catalog product on two stages must remain two separate order lines");
      assert.notEqual(repeatedLines.rows[0].line_id,repeatedLines.rows[1].line_id);
      assert.equal(repeatedLines.rows[0].product_id,repeatedLines.rows[1].product_id);
      assert.deepEqual(repeatedLines.rows.map(row=>({planned:Number(row.planned_quantity),line:Number(row.line_quantity)})),[
        {planned:3,line:3},{planned:7,line:7}
      ]);

      // Cross-order associations must be rejected by the composite database FK.
      await assert.rejects(
        apiPool.query("UPDATE order_stages SET order_item_id=$1 WHERE id=(SELECT id FROM order_stages WHERE order_id=$2 ORDER BY sequence_no LIMIT 1)",
          [repeatedLines.rows[0].line_id,multiOrderId]),
        /foreign key/i
      );

      // A failed final-line synchronization must roll back both stage and line changes.
      const invalidQuantityUpdate=await app.inject({
        method:"PATCH",url:"/api/order-stages/"+(await apiPool.query("SELECT id FROM order_stages WHERE order_id=$1 ORDER BY sequence_no LIMIT 1",[repeatedOrderId])).rows[0].id,
        headers:{cookie:managerCookie},payload:{plannedQuantity:0}
      });
      assert.equal(invalidQuantityUpdate.statusCode,422,invalidQuantityUpdate.body);
      const unchangedRepeatedLine=await apiPool.query(
        `SELECT os.planned_quantity,pol.quantity AS line_quantity
           FROM order_stages os JOIN production_order_lines pol ON pol.id=os.order_item_id AND pol.order_id=os.order_id
          WHERE os.order_id=$1 AND os.is_final_product=TRUE ORDER BY os.sequence_no LIMIT 1`,
        [repeatedOrderId]
      );
      assert.equal(Number(unchangedRepeatedLine.rows[0].planned_quantity),3);
      assert.equal(Number(unchangedRepeatedLine.rows[0].line_quantity),3);

      const firstRepeatedStage=(await apiPool.query("SELECT id,order_item_id FROM order_stages WHERE order_id=$1 ORDER BY sequence_no LIMIT 1",[repeatedOrderId])).rows[0];
      const unmarkFinal=await app.inject({
        method:"PATCH",url:"/api/order-stages/"+firstRepeatedStage.id,
        headers:{cookie:managerCookie},payload:{isFinalProduct:false}
      });
      assert.equal(unmarkFinal.statusCode,200,unmarkFinal.body);
      assert.equal(unmarkFinal.json().data.order_item_id,null);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM production_order_lines WHERE order_id=$1",[repeatedOrderId])).rows[0].count),1,
        "unmarking a final stage must remove its now-orphaned line without recreating the remaining line");
      const testAdvance=(await apiPool.query("INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,repayment_status) VALUES($1,100,'worker payment offset test','PAID',$2,$2,now(),'CUSTOM','OPEN') RETURNING id,code",[workerEmployee.id,manager.id])).rows[0];
      await apiPool.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',100,$2,$3)",[workerEmployee.id,manager.id,"صرف سلفة "+testAdvance.code]);
      const availableBeforePayout=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(availableBeforePayout.statusCode,200,availableBeforePayout.body);
      const availableBeforePayoutAmount=Number(availableBeforePayout.json().data.availableEarnings);
      const request=await app.inject({
        method:"POST",url:"/api/payment-requests",headers:{cookie:workerCookie},
        payload:{amount:150,method:"INSTAPAY",transferReference:"IP-TEST-2026-001"}
      });
      assert.equal(request.statusCode,201,request.body);
      assert.equal(request.json().data.transfer_reference,"IP-TEST-2026-001");
      const requestId=request.json().data.id;
      const workerPendingCount=await app.inject({
        method:"GET",url:"/api/payment-requests/pending-count",headers:{cookie:workerCookie}
      });
      assert.equal(workerPendingCount.statusCode,200,workerPendingCount.body);
      assert.equal(workerPendingCount.json().data.count,1,
        "worker badge count must include the worker's own pending request");
      const managerPendingCount=await app.inject({
        method:"GET",url:"/api/payment-requests/pending-count",headers:{cookie:managerCookie}
      });
      assert.equal(managerPendingCount.statusCode,200,managerPendingCount.body);
      assert.equal(managerPendingCount.json().data.count,1,
        "manager badge count must include pending requests across employees");
      const approved=await app.inject({
        method:"POST",url:`/api/payment-requests/${requestId}/approve`,headers:{cookie:managerCookie},payload:{advanceRepaymentAmount:50}
      });
      assert.equal(approved.statusCode,200,approved.body);
      assert.equal(approved.json().data.request.status,"PAID");
      const countAfterApproval=await app.inject({
        method:"GET",url:"/api/payment-requests/pending-count",headers:{cookie:managerCookie}
      });
      assert.equal(countAfterApproval.statusCode,200,countAfterApproval.body);
      assert.equal(countAfterApproval.json().data.count,0,
        "paid requests must disappear from the pending badge count");
      assert.ok(approved.json().data.request.paid_payment_id);
      assert.equal(approved.json().data.payment.transfer_reference,"IP-TEST-2026-001");
      const custodyDebit=await apiPool.query("SELECT id,direction,amount,source_type,source_id,description FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[approved.json().data.payment.id]);
      assert.equal(custodyDebit.rowCount,1,"payment must create exactly one linked cash-custody debit");
      assert.equal(custodyDebit.rows[0].direction,"OUT");
      assert.equal(Number(custodyDebit.rows[0].amount),100,"cash custody must record only the net cash actually paid");
      assert.equal(custodyDebit.rows[0].source_id,approved.json().data.payment.id);
      assert.match(custodyDebit.rows[0].description,/صرف مستحقات العامل/);
      const workerPaymentExpense=await apiPool.query(
        "SELECT id,amount,category,source_worker_payment_id,cash_custody_transaction_id,paid_from_employee_id FROM accounting_expenses WHERE source_worker_payment_id=$1",
        [approved.json().data.payment.id]
      );
      assert.equal(workerPaymentExpense.rowCount,1,"approval must create exactly one source-linked worker-payment expense");
      assert.equal(Number(workerPaymentExpense.rows[0].amount),150,"the expense must record gross entitlement, including advance repayment");
      assert.equal(workerPaymentExpense.rows[0].category,"WORKER_PAYMENT");
      assert.equal(workerPaymentExpense.rows[0].source_worker_payment_id,approved.json().data.payment.id);
      assert.equal(workerPaymentExpense.rows[0].cash_custody_transaction_id,custodyDebit.rows[0].id,
        "the gross expense must link to the single net-cash custody movement");
      const workerPostingCheck=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(workerPostingCheck.statusCode,200,workerPostingCheck.body);
      assert.equal(workerPostingCheck.json().data.counts.workerPaymentPostingMismatches,0,
        "a correctly posted active worker payment must pass the full posting reconciliation: "+JSON.stringify(workerPostingCheck.json().data.issues.workerPaymentPostingMismatches));
      const workerLedgerEntry=await apiPool.query(
        "SELECT id,debit_amount FROM employee_earnings_ledger WHERE worker_payment_id=$1",
        [approved.json().data.payment.id]
      );
      assert.equal(workerLedgerEntry.rowCount,1);
      await apiPool.query("UPDATE employee_earnings_ledger SET debit_amount=debit_amount-1 WHERE id=$1",[workerLedgerEntry.rows[0].id]);
      const corruptedWorkerPostingCheck=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(corruptedWorkerPostingCheck.statusCode,200,corruptedWorkerPostingCheck.body);
      assert.equal(corruptedWorkerPostingCheck.json().data.counts.workerPaymentPostingMismatches,1,
        "reconciliation must detect a worker payment whose earnings-ledger debit differs from gross");
      await apiPool.query("UPDATE employee_earnings_ledger SET debit_amount=$2 WHERE id=$1",
        [workerLedgerEntry.rows[0].id,workerLedgerEntry.rows[0].debit_amount]);
      assert.equal(Number(approved.json().data.payment.amount),100);
      assert.equal(Number(approved.json().data.grossAmount),150);
      assert.equal(Number(approved.json().data.advanceRepaymentAmount),50);
      const repayment=await apiPool.query("SELECT amount,source_worker_payment_id,advance_id FROM advance_repayments WHERE source_worker_payment_id=$1",[approved.json().data.payment.id]);
      assert.equal(repayment.rowCount,1);
      assert.equal(Number(repayment.rows[0].amount),50);
      assert.equal(repayment.rows[0].advance_id,testAdvance.id);
      const custodyOffset=await apiPool.query("SELECT direction,amount FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT_ADVANCE_REPAYMENT' AND source_id=$1",[approved.json().data.payment.id]);
      assert.equal(custodyOffset.rowCount,0,"advance offset is a payroll settlement, not cash returned to the custodian");
      const remainingAdvance=(await apiPool.query("SELECT repayment_status,amount-(SELECT COALESCE(SUM(amount),0) FROM advance_repayments WHERE advance_id=$1) AS remaining FROM advance_requests WHERE id=$1",[testAdvance.id])).rows[0];
      assert.equal(remainingAdvance.repayment_status,"OPEN");
      assert.equal(Number(remainingAdvance.remaining),50);
      const accountBalance=(await apiPool.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",[workerEmployee.id])).rows[0];
      assert.equal(Number(accountBalance.balance),300);
      const remainingAvailable=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(remainingAvailable.statusCode,200,remainingAvailable.body);
      assert.equal(Number(remainingAvailable.json().data.availableEarnings),availableBeforePayoutAmount-150);
      const globalSearch=await app.inject({method:"GET",url:"/api/search/global?q="+encodeURIComponent(request.json().data.code),headers:{cookie:managerCookie}});
      assert.equal(globalSearch.statusCode,200,globalSearch.body);
      assert.ok(globalSearch.json().data.some((item:{type:string})=>item.type==="طلب قبض"),"central search should find the payment request code");
      assert.ok(globalSearch.json().data.some((item:{type:string})=>item.type==="حركة عهدة"),"central search should find the linked cash-custody debit");
      const delivery=(await apiPool.query("INSERT INTO delivery_permissions(destination,created_by) VALUES('Test search destination',$1) RETURNING code",[manager.id])).rows[0];
      const deliverySearch=await app.inject({method:"GET",url:"/api/search/global?q="+encodeURIComponent(delivery.code),headers:{cookie:managerCookie}});
      assert.equal(deliverySearch.statusCode,200,deliverySearch.body);
      assert.ok(deliverySearch.json().data.some((item:{type:string;code:string})=>item.type==="إذن تسليم"&&item.code===delivery.code),"central search should find delivery slips without relying on an order_id column");

      // Exercise product minimum-stock persistence and reconcile stock movement value.
      const unit=(await apiPool.query("SELECT id FROM units WHERE is_active=TRUE ORDER BY code LIMIT 1")).rows[0];
      assert.ok(unit,"migrations should seed at least one active unit");
      const product=await app.inject({
        method:"POST",url:"/api/products",headers:{cookie:managerCookie},
        payload:{name:"Stock threshold test "+randomBytes(4).toString("hex"),productType:"RAW_MATERIAL",unitId:unit.id,minimumStock:8,trackInventory:true}
      });
      assert.equal(product.statusCode,201,product.body);
      assert.equal(Number(product.json().data.minimum_stock),8);
      const warehouse=await app.inject({
        method:"POST",url:"/api/warehouses",headers:{cookie:managerCookie},
        payload:{name:"Stock reconciliation test "+randomBytes(4).toString("hex"),warehouseType:"RAW_MATERIAL"}
      });
      assert.equal(warehouse.statusCode,201,warehouse.body);
      const location=await app.inject({
        method:"POST",url:"/api/warehouse/locations",headers:{cookie:managerCookie},
        payload:{warehouseId:warehouse.json().data.id,code:"TEST-"+randomBytes(3).toString("hex"),name:"Test shelf"}
      });
      assert.equal(location.statusCode,201,location.body);
      const stockIn=await app.inject({
        method:"POST",url:"/api/warehouse/movements",headers:{cookie:managerCookie},
        payload:{movementType:"IN",productId:product.json().data.id,warehouseId:warehouse.json().data.id,locationId:location.json().data.id,quantity:10,unitCost:5,notes:"isolated stock test"}
      });
      assert.equal(stockIn.statusCode,201,stockIn.body);
      const stockOut=await app.inject({
        method:"POST",url:"/api/warehouse/movements",headers:{cookie:managerCookie},
        payload:{movementType:"OUT",productId:product.json().data.id,warehouseId:warehouse.json().data.id,locationId:location.json().data.id,quantity:3,notes:"isolated stock consumption test"}
      });
      assert.equal(stockOut.statusCode,201,stockOut.body);
      const stockAdjustmentOut=await app.inject({
        method:"POST",url:"/api/warehouse/movements",headers:{cookie:managerCookie},
        payload:{movementType:"ADJUSTMENT",adjustmentDirection:"OUT",productId:product.json().data.id,warehouseId:warehouse.json().data.id,locationId:location.json().data.id,quantity:2,notes:"isolated outbound adjustment test"}
      });
      assert.equal(stockAdjustmentOut.statusCode,201,stockAdjustmentOut.body);
      const stock=await app.inject({
        method:"GET",url:"/api/warehouse/stock?productId="+product.json().data.id,headers:{cookie:managerCookie}
      });
      assert.equal(stock.statusCode,200,stock.body);
      assert.equal(stock.json().data.length,1);
      assert.equal(Number(stock.json().data[0].quantity),5);
      assert.equal(Number(stock.json().data[0].inventory_value),25);
      const stockDashboard=await app.inject({
        method:"GET",url:"/api/warehouse/dashboard?warehouseId="+warehouse.json().data.id,headers:{cookie:managerCookie}
      });
      assert.equal(stockDashboard.statusCode,200,stockDashboard.body);
      assert.equal(Number(stockDashboard.json().data.total_in),50);
      assert.equal(Number(stockDashboard.json().data.total_out),25,"outbound adjustment must be counted as stock leaving");
      assert.equal(Number(stockDashboard.json().data.net),25,"net stock movement value must include outbound adjustment");
      assert.equal(Number(stockDashboard.json().data.current_value),25);
      const minimumUpdate=await app.inject({
        method:"PATCH",url:"/api/products/"+product.json().data.id+"/minimum-stock",
        headers:{cookie:managerCookie},payload:{minimumStock:0}
      });
      assert.equal(minimumUpdate.statusCode,200,minimumUpdate.body);
      assert.equal(Number(minimumUpdate.json().data.minimum_stock),0,"zero is a valid explicit stock threshold");

      // Verify direct expense plus closed-period administrative allocation is counted once.
      const financeOrder=(await apiPool.query(
        "INSERT INTO production_orders(order_name,created_by,status) VALUES($1,$2,'DRAFT') RETURNING id",
        ["Profitability no-double-count test order",manager.id]
      )).rows[0];
      const revenue=await app.inject({
        method:"POST",url:"/api/accounting/revenues",headers:{cookie:managerCookie},
        payload:{orderId:financeOrder.id,amount:100,revenueDate:"2099-02-12",source:"MANUAL",notes:"test revenue"}
      });
      assert.equal(revenue.statusCode,201,revenue.body);
      const directExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{orderId:financeOrder.id,category:"اختبار",description:"Direct cost no-double-count test",amount:25,expenseDate:"2099-02-10",expenseType:"DIRECT"}
      });
      assert.equal(directExpense.statusCode,201,directExpense.body);

      // Historical settlements must not silently debit a current custody, and their date must belong to an open period.
      const historicalDate="1800-03-10";
      const historicalWithoutPeriod=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"تسوية قديمة",description:"Historical expense requires an open period",amount:12,expenseDate:historicalDate,expenseType:"DIRECT",paidFromEmployeeId:null,historicalSettlement:true,idempotencyKey:randomUUID()}
      });
      assert.equal(historicalWithoutPeriod.statusCode,409,historicalWithoutPeriod.body);
      assert.equal(historicalWithoutPeriod.json().error.code,"ACCOUNTING_PERIOD_NOT_FOUND");

      const historicalWithCurrentCustody=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"تسوية قديمة",description:"Historical expense must not debit current custody",amount:12,expenseDate:historicalDate,expenseType:"DIRECT",paidFromEmployeeId:managerEmployee.id,historicalSettlement:true,idempotencyKey:randomUUID()}
      });
      assert.equal(historicalWithCurrentCustody.statusCode,422,historicalWithCurrentCustody.body);

      const historicalPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Historical expense test period",periodStart:"1800-01-01",periodEnd:"1800-12-31"}
      });
      assert.equal(historicalPeriod.statusCode,201,historicalPeriod.body);
      const historicalExpenseOrders=await app.inject({
        method:"GET",url:"/api/accounting/historical-expense-orders",headers:{cookie:managerCookie}
      });
      assert.equal(historicalExpenseOrders.statusCode,200,historicalExpenseOrders.body);
      assert.ok(historicalExpenseOrders.json().data.length>0,
        "historical expense entry should load order options through its own permission-scoped endpoint");
      const historicalExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"تسوية قديمة",description:"Historical expense inside open period",amount:12,expenseDate:historicalDate,expenseType:"DIRECT",paidFromEmployeeId:null,historicalSettlement:true,idempotencyKey:randomUUID()}
      });
      assert.equal(historicalExpense.statusCode,201,historicalExpense.body);
      assert.equal(historicalExpense.json().data.paid_from_employee_id,null);

      const adminExpense=await app.inject({
        method:"POST",url:"/api/accounting/expenses",headers:{cookie:managerCookie},
        payload:{category:"اختبار إداري",description:"Administrative allocation no-double-count test",amount:30,expenseDate:"2099-02-11",expenseType:"ADMINISTRATIVE"}
      });
      assert.equal(adminExpense.statusCode,201,adminExpense.body);
      const financePeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"No-double-count test period",periodStart:"2099-02-01",periodEnd:"2099-02-28"}
      });
      assert.equal(financePeriod.statusCode,201,financePeriod.body);
      const allocations=await app.inject({
        method:"PUT",url:`/api/accounting/periods/${financePeriod.json().data.id}/allocations`,
        headers:{cookie:managerCookie},
        payload:{allocations:[{expenseId:adminExpense.json().data.id,orderId:financeOrder.id,amount:30}]}
      });
      assert.equal(allocations.statusCode,200,allocations.body);

      // A reversal dated after this period must not rewrite its historical snapshot.
      const periodSnapshotWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Period snapshot reversal worker') RETURNING id"
      )).rows[0].id;
      const periodSnapshotPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,idempotency_key,idempotency_fingerprint)
         VALUES($1,25,25,0,'CASH',$2,$3,'period-snapshot-boundary-payment') RETURNING id`,
        [periodSnapshotWorker,manager.id,randomUUID()]
      )).rows[0].id;
      const laterReversedExpense=(await apiPool.query(
        `INSERT INTO accounting_expenses(category,description,amount,expense_date,payment_method,created_by,
           expense_type,allocation_type,source_worker_payment_id)
         VALUES('WORKER_PAYMENT','Expense reversed in a later period',25,'2099-02-15','CASH',$1,
           'DIRECT','GENERAL',$2) RETURNING id`,
        [manager.id,periodSnapshotPayment]
      )).rows[0].id;
      const laterReversedAdvance=(await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,
           repayment_method,repayment_status)
         VALUES($1,100,'Period snapshot reversal boundary','PAID',$2,$2,'2099-02-10 12:00:00+00',
           'CUSTOM','OPEN') RETURNING id`,
        [periodSnapshotWorker,manager.id]
      )).rows[0].id;
      const laterAdvanceRepayment=(await apiPool.query(
        `INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,notes,created_by,
           source_worker_payment_id)
         VALUES($1,40,'CUSTOM','2099-02-15','Repayment reversed after period end',$2,$3) RETURNING id`,
        [laterReversedAdvance,manager.id,periodSnapshotPayment]
      )).rows[0].id;
      const laterReversal=(await apiPool.query(
        `INSERT INTO financial_reversals(idempotency_key,request_fingerprint,reason,reversal_date,created_by)
         VALUES($1,'period-snapshot-boundary','Later-period reversal','2099-03-01',$2) RETURNING id`,
        [randomUUID(),manager.id]
      )).rows[0].id;
      await apiPool.query(
        `INSERT INTO financial_reversal_lines(reversal_id,source_type,source_id,amount)
         VALUES($1,'ADVANCE_REPAYMENT',$2,40)`,
        [laterReversal,laterAdvanceRepayment]
      );
      await apiPool.query(
        `INSERT INTO accounting_expense_reversals(reversal_id,expense_id,source_worker_payment_id,amount,created_by)
         VALUES($1,$2,$3,25,$4)`,
        [laterReversal,laterReversedExpense,periodSnapshotPayment,manager.id]
      );

      const closePeriod=await closePeriodWithApproval(financePeriod.json().data.id);
      assert.equal(closePeriod.statusCode,200,closePeriod.body);
      const historicalPeriodReport=await app.inject({
        method:"GET",url:`/api/accounting/periods/${financePeriod.json().data.id}/report`,
        headers:{cookie:managerCookie}
      });
      assert.equal(historicalPeriodReport.statusCode,200,historicalPeriodReport.body);
      assert.equal(historicalPeriodReport.json().data.integrityVerified,true,
        "period snapshot hash must verify after close");
      assert.equal(Number(historicalPeriodReport.json().data.report.totals.expenses),80,
        "the earlier period must retain its 25 direct cost, 30 administrative cost, and 25 expense reversed only in a later period");
      const advanceSnapshot=historicalPeriodReport.json().data.report.advances.find((row:any)=>row.id===laterReversedAdvance);
      assert.ok(advanceSnapshot,"the advance must be included in the period-end snapshot");
      assert.equal(Number(advanceSnapshot.remaining),60,
        "a later-period repayment reversal must not restore the advance balance in the earlier period");
      const profitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${financeOrder.id}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(profitability.statusCode,200,profitability.body);
      assert.equal(Number(profitability.json().data.revenue),100);
      assert.equal(Number(profitability.json().data.expenses),25,"only direct expenses belong in direct expense total");
      assert.equal(Number(profitability.json().data.administrativeAllocation),30);
      assert.equal(Number(profitability.json().data.totalCost),55,"administrative expense must not be counted both directly and through allocation");
      assert.equal(Number(profitability.json().data.profit),45);
      const financeDashboard=await app.inject({
        method:"GET",url:"/api/accounting/orders-dashboard",headers:{cookie:managerCookie}
      });
      assert.equal(financeDashboard.statusCode,200,financeDashboard.body);
      const dashboardOrder=financeDashboard.json().data.find((item:{id:string})=>item.id===financeOrder.id);
      assert.ok(dashboardOrder,"finance dashboard should include the test order");
      assert.equal(Number(dashboardOrder.direct_expenses),25);
      assert.equal(Number(dashboardOrder.administrative_allocation),30);
      assert.equal(Number(dashboardOrder.total_cost),55);
      assert.equal(Number(dashboardOrder.profit),45);

      const balance=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(balance.statusCode,200,balance.body);
      assert.equal(Number(balance.json().data.balance),300);
      const ledger=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount),0) AS credits,COALESCE(SUM(debit_amount),0) AS debits,COUNT(*) FILTER(WHERE entry_type='WORKER_PAYMENT')::int AS payment_entries FROM employee_earnings_ledger WHERE employee_id=$1",
        [workerEmployee.id]);
      assert.equal(Number(ledger.rows[0].credits),550);
      assert.equal(Number(ledger.rows[0].debits),250);
      assert.equal(Number(ledger.rows[0].payment_entries),1);

      // An advance is immediately a debit on the employee account. At payout,
      // the gross production entitlement clears the account and only the net cash
      // actually handed to the worker leaves cash custody. The offset is payroll settlement.
      const workerAdvance=(await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,repayment_status)
         VALUES($1,200,'payment integration advance','PAID',$2,$3,now(),'CUSTOM','OPEN') RETURNING id,code`,
        [workerEmployee.id,worker.id,manager.id]
      )).rows[0];
      await apiPool.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes)
         VALUES($1,'ADJUSTMENT',200,$2,$3)`,
        [workerEmployee.id,manager.id,"صرف سلفة "+workerAdvance.code]
      );
      await apiPool.query(
        `INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,notes,source_type,source_id,created_by)
         VALUES($1,'OUT',200,$2,$3,'ADVANCE_PAYOUT',$4,$5)`,
        [managerEmployee.id,"صرف سلفة "+workerAdvance.code,"payment integration test",workerAdvance.id,manager.id]
      );
      const availableAfterAdvance=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(availableAfterAdvance.statusCode,200,availableAfterAdvance.body);
      assert.equal(Number(availableAfterAdvance.json().data.balance),100,"employee account must visibly reflect the outstanding advance");
      assert.equal(Number(availableAfterAdvance.json().data.outstandingAdvanceAmount),250,"both the earlier and current advances remain open");
      assert.equal(Number(availableAfterAdvance.json().data.availableEarnings),350,"loan principal must not reduce earned-but-unpaid production entitlement");

      const nextRequest=await app.inject({
        method:"POST",url:"/api/payment-requests",headers:{cookie:workerCookie},
        payload:{amount:200,method:"CASH"}
      });
      assert.equal(nextRequest.statusCode,201,nextRequest.body,"paid requests must not block a new request");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE payment_request_id=$1",[requestId])).rows[0].count),1);

      // Retrying an already-paid request must not create a second payment or custody debit.
      const repeatedApproval=await app.inject({
        method:"POST",url:`/api/payment-requests/${requestId}/approve`,headers:{cookie:managerCookie}
      });
      assert.equal(repeatedApproval.statusCode,409,repeatedApproval.body);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE payment_request_id=$1",[requestId])).rows[0].count),1);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[approved.json().data.payment.id])).rows[0].count),1);

      // Insufficient custody must roll back the payment, ledger debit and request status together.
      const blockedApproval=await app.inject({
        method:"POST",url:`/api/payment-requests/${nextRequest.json().data.id}/approve`,
        headers:{cookie:managerCookie},payload:{cashCustodyEmployeeId:emptyCustodianEmployee.id}
      });
      assert.equal(blockedApproval.statusCode,409,blockedApproval.body);
      assert.equal(blockedApproval.json().error.code,"INSUFFICIENT_CASH_CUSTODY_BALANCE");
      const blockedState=await apiPool.query(
        "SELECT pr.status,(SELECT COUNT(*)::int FROM worker_payments wp WHERE wp.payment_request_id=pr.id) AS payments,(SELECT COUNT(*)::int FROM employee_earnings_ledger el WHERE el.entry_type='WORKER_PAYMENT' AND el.employee_id=pr.employee_id) AS payment_ledger_entries FROM payment_requests pr WHERE pr.id=$1",
        [nextRequest.json().data.id]
      );
      assert.equal(blockedState.rows[0].status,"PENDING");
      assert.equal(Number(blockedState.rows[0].payments),0,"failed custody debit must roll back worker payment");
      assert.equal(Number(blockedState.rows[0].payment_ledger_entries),1,"failed custody debit must not add an earnings debit");

      const settledRequest=await app.inject({
        method:"POST",url:`/api/payment-requests/${nextRequest.json().data.id}/approve`,
        headers:{cookie:managerCookie},
        payload:{cashCustodyEmployeeId:managerEmployee.id,advanceRepaymentAmount:50}
      });
      assert.equal(settledRequest.statusCode,200,settledRequest.body);
      assert.equal(settledRequest.json().data.request.status,"PAID");
      assert.equal(Number(settledRequest.json().data.grossAmount),200);
      assert.equal(Number(settledRequest.json().data.advanceRepaymentAmount),50);
      assert.equal(Number(settledRequest.json().data.cashPaid),150);
      assert.equal(Number(settledRequest.json().data.payment.gross_amount),200);
      assert.equal(Number(settledRequest.json().data.payment.amount),150);
      assert.equal(Number(settledRequest.json().data.payment.advance_repayment_amount),50);

      const repaymentRows=await apiPool.query(
        "SELECT amount,source_worker_payment_id,advance_id FROM advance_repayments WHERE source_worker_payment_id=$1",
        [settledRequest.json().data.payment.id]
      );
      assert.equal(repaymentRows.rowCount,1);
      assert.equal(Number(repaymentRows.rows[0].amount),50);
      assert.equal(repaymentRows.rows[0].source_worker_payment_id,settledRequest.json().data.payment.id);
      assert.equal(repaymentRows.rows[0].advance_id,testAdvance.id,"manual repayment applies to the oldest open advance first");
      const workerPaymentLedger=await apiPool.query("SELECT debit_amount FROM employee_earnings_ledger WHERE worker_payment_id=$1",[settledRequest.json().data.payment.id]);
      assert.equal(workerPaymentLedger.rowCount,1);
      assert.equal(Number(workerPaymentLedger.rows[0].debit_amount),200,"the employee ledger clears gross earnings, not only the net cash handed over");
      const advanceRemaining=await apiPool.query(
        "SELECT amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
        [workerAdvance.id]
      );
      assert.equal(Number(advanceRemaining.rows[0].remaining),200,"the newer advance remains open because the older advance was settled first");

      const payoutCustody=await apiPool.query(
        "SELECT direction,amount,source_type FROM cash_custody_transactions WHERE source_id=$1 AND source_type IN ('WORKER_PAYMENT','WORKER_PAYMENT_ADVANCE_REPAYMENT') ORDER BY direction",
        [settledRequest.json().data.payment.id]
      );
      assert.equal(payoutCustody.rowCount,1,"only the real cash movement should be recorded in custody");
      assert.equal(payoutCustody.rows[0].direction,"OUT");
      assert.equal(payoutCustody.rows[0].source_type,"WORKER_PAYMENT");
      assert.equal(Number(payoutCustody.rows[0].amount),150,"custody OUT must equal the net cash actually paid");
      const repaymentCustodyRows=await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT_ADVANCE_REPAYMENT' AND source_id=$1",
        [settledRequest.json().data.payment.id]
      );
      assert.equal(Number(repaymentCustodyRows.rows[0].count),0,"advance repayment is a payroll offset, not cash received by the custodian");

      const postSettlementBalance=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(postSettlementBalance.statusCode,200,postSettlementBalance.body);
      assert.equal(Number(postSettlementBalance.json().data.balance),-50,"the employee account must reconcile remaining unpaid earnings against the outstanding loan");
      assert.equal(Number(postSettlementBalance.json().data.outstandingAdvanceAmount),200);
      assert.equal(Number(postSettlementBalance.json().data.availableEarnings),150,"only genuinely unpaid earnings remain available");

      const payoutPreview=await app.inject({
        method:"GET",
        url:`/api/worker-payments/preview?employeeId=${workerEmployee.id}&cashCustodyEmployeeId=${managerEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(payoutPreview.statusCode,200,payoutPreview.body);
      assert.equal(Number(payoutPreview.json().data.availableEarnings),150);
      assert.equal(Number(payoutPreview.json().data.cashCustodyBalance),550);
      assert.equal(Number(payoutPreview.json().data.maxGrossPayoutWithoutManualOffset),150,
        "payout preview must show the lower of available earnings and cash custody before confirmation");

      // A previous-custody settlement must still settle employee earnings and post labor cost
      // to the selected order, without creating a new cash-custody OUT on today's custody.
      const previousCustodyEmployee = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Previous Custody Worker') RETURNING id"
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',75,$2,'test previous-custody available earnings')",
        [previousCustodyEmployee.id,manager.id]
      );
      const previousCustodyKey = randomUUID();
      const custodyBeforePreviousSettlement = Number((await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",
        [managerEmployee.id]
      )).rows[0].balance);
      const previousCustodyPayout = await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{
          employeeId:previousCustodyEmployee.id,
          settlementSource:"PREVIOUS_CUSTODY",
          amount:75,
          method:"CASH",
          idempotencyKey:previousCustodyKey,
          notes:"integration test — previous custody"
        }
      });
      assert.equal(previousCustodyPayout.statusCode,201,previousCustodyPayout.body);
      assert.equal(Number(previousCustodyPayout.json().data.grossAmount),75);
      const previousCustodyPaymentId=previousCustodyPayout.json().data.payment.id;
      const previousCustodyOut = await apiPool.query(
        "SELECT id,amount FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [previousCustodyPaymentId]
      );
      assert.equal(previousCustodyOut.rowCount,0,"previous-custody settlement must not debit the current custody");
      const custodyAfterPreviousSettlement = Number((await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",
        [managerEmployee.id]
      )).rows[0].balance);
      assert.equal(custodyAfterPreviousSettlement,custodyBeforePreviousSettlement,"current custody balance remains unchanged");
      const previousCustodyExpense=await apiPool.query(
        "SELECT order_id,order_stage_id,category,amount,expense_type,paid_from_employee_id,idempotency_key,allocation_type,source_worker_payment_id FROM accounting_expenses WHERE idempotency_key=$1",
        [previousCustodyKey]
      );
      assert.equal(previousCustodyExpense.rowCount,1,"previous-custody settlement must create exactly one order expense");
      assert.equal(previousCustodyExpense.rows[0].order_id,null);
      assert.equal(previousCustodyExpense.rows[0].order_stage_id,null);
      assert.equal(previousCustodyExpense.rows[0].category,"WORKER_PAYMENT");
      assert.equal(previousCustodyExpense.rows[0].expense_type,"DIRECT");
      assert.equal(previousCustodyExpense.rows[0].paid_from_employee_id,null,"the expense must not be tied to today's custody");
      assert.equal(previousCustodyExpense.rows[0].idempotency_key,previousCustodyKey);
      assert.equal(previousCustodyExpense.rows[0].allocation_type,"GENERAL");
      assert.equal(previousCustodyExpense.rows[0].source_worker_payment_id,previousCustodyPaymentId);
      const previousCustodyRetry=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{
          employeeId:previousCustodyEmployee.id,
          settlementSource:"PREVIOUS_CUSTODY",
          amount:75,
          method:"CASH",
          idempotencyKey:previousCustodyKey,
          notes:"integration test — previous custody"
        }
      });
      assert.equal(previousCustodyRetry.statusCode,200,previousCustodyRetry.body,"retry must return the original previous-custody payout");
      assert.equal(previousCustodyRetry.json().data.payment.id,previousCustodyPaymentId);
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",
        [previousCustodyKey]
      )).rows[0].count),1,"retry must not duplicate the order cost");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [previousCustodyPaymentId]
      )).rows[0].count),0,"retry must not create a custody debit");

      // A current-custody settlement uses the same order-scoped settlement path,
      // but posts exactly one cash OUT and attributes the order expense to that custody.
      const currentOrderWorker=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Current Order Worker') RETURNING id")).rows[0];
      await apiPool.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',75,$2,'test current-custody order balance')",[currentOrderWorker.id,manager.id]);
      const currentOrderKey=randomUUID();
      const custodyBeforeCurrent=Number((await apiPool.query("SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",[managerEmployee.id])).rows[0].balance);
      const currentOrderPayout=await app.inject({method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:{employeeId:currentOrderWorker.id,settlementSource:"CURRENT_CUSTODY",cashCustodyEmployeeId:managerEmployee.id,amount:75,method:"CASH",idempotencyKey:currentOrderKey,notes:"integration test — current custody general"}});
      assert.equal(currentOrderPayout.statusCode,201,currentOrderPayout.body);
      const currentOrderPaymentId=currentOrderPayout.json().data.payment.id;
      const currentOrderExpense=await apiPool.query("SELECT order_id,paid_from_employee_id,amount,allocation_type,source_worker_payment_id,cash_custody_transaction_id FROM accounting_expenses WHERE idempotency_key=$1",[currentOrderKey]);
      assert.equal(currentOrderExpense.rowCount,1);
      assert.equal(currentOrderExpense.rows[0].order_id,null);
      assert.equal(currentOrderExpense.rows[0].allocation_type,"GENERAL");
      assert.equal(currentOrderExpense.rows[0].source_worker_payment_id,currentOrderPaymentId);
      assert.equal(currentOrderExpense.rows[0].paid_from_employee_id,managerEmployee.id);
      assert.equal(Number(currentOrderExpense.rows[0].amount),75);
      const currentOrderOut=await apiPool.query("SELECT id,employee_id,amount FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[currentOrderPaymentId]);
      assert.equal(currentOrderOut.rowCount,1,"current-custody settlement must create one custody OUT");
      assert.equal(currentOrderOut.rows[0].employee_id,managerEmployee.id);
      assert.equal(Number(currentOrderOut.rows[0].amount),75);
      assert.equal(currentOrderExpense.rows[0].cash_custody_transaction_id,currentOrderOut.rows[0].id);
      const currentOrderRetry=await app.inject({method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:{employeeId:currentOrderWorker.id,settlementSource:"CURRENT_CUSTODY",cashCustodyEmployeeId:managerEmployee.id,amount:75,method:"CASH",idempotencyKey:currentOrderKey,notes:"integration test — current custody general"}});
      assert.equal(currentOrderRetry.statusCode,200,currentOrderRetry.body);
      assert.equal(currentOrderRetry.json().data.payment.id,currentOrderPaymentId);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",[currentOrderKey])).rows[0].count),1);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[currentOrderPaymentId])).rows[0].count),1);
      const custodyAfterCurrent=Number((await apiPool.query("SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1",[managerEmployee.id])).rows[0].balance);
      assert.equal(custodyAfterCurrent,custodyBeforeCurrent-75,"current custody must be debited once only");

      // A worker with no production on the selected order must not have
      // independent/general earnings misattributed to that order, even with overpayment enabled.
      const unrelatedOrderWorker=(await apiPool.query("INSERT INTO employees(full_name) VALUES('Test Unrelated Order Worker') RETURNING id")).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',20,$2,'unrelated order guard test')",
        [unrelatedOrderWorker.id,manager.id]
      );
      const unrelatedOrderKey=randomUUID();
      const unrelatedOrderPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:unrelatedOrderWorker.id,settlementSource:"PREVIOUS_CUSTODY",
          orderId:hamzaOrder.json().data.id,amount:20,method:"CASH",allowOverpayment:true,idempotencyKey:unrelatedOrderKey}
      });
      assert.equal(unrelatedOrderPayout.statusCode,409,unrelatedOrderPayout.body);
      assert.equal(unrelatedOrderPayout.json().error.code,"ORDER_HAS_NO_WORKER_PRODUCTION");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE idempotency_key=$1",[unrelatedOrderKey])).rows[0].count),0);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE idempotency_key=$1",[unrelatedOrderKey])).rows[0].count),0);

      // Direct payout requires no prior payment request and must serialize concurrent attempts.
      // Direct payouts must use the same net production entitlement as allocation:
      // base 100 + bonus 50 - deduction 20 = 130, not the base amount alone.
      const bonusProduct=(await apiPool.query("SELECT unit_id FROM products WHERE id=$1",[hamzaProducts.rows[0].product_id])).rows[0];
      const bonusStage=(await apiPool.query(
        "INSERT INTO stages(name) VALUES($1) RETURNING id",
        ["Test bonus production stage "+randomBytes(4).toString("hex")]
      )).rows[0];
      const bonusRateGroup=(await apiPool.query(
        "INSERT INTO rate_groups(name) VALUES($1) RETURNING id",
        ["Test bonus rate group "+randomBytes(4).toString("hex")]
      )).rows[0];
      const bonusShift=(await apiPool.query(
        "INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES($1,'08:00','16:00',$2) RETURNING id",
        ["Test bonus shift "+randomBytes(4).toString("hex"),bonusRateGroup.id]
      )).rows[0];
      const perPieceWageType=(await apiPool.query("SELECT id FROM wage_types WHERE code='PER_PIECE' LIMIT 1")).rows[0];
      const bonusRate=(await apiPool.query(
        `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
         VALUES($1,$2,$3,$4,$5,100,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)
         RETURNING id,stage_id`,
        [hamzaProducts.rows[0].product_id,bonusStage.id,bonusRateGroup.id,perPieceWageType.id,bonusProduct.unit_id,manager.id]
      )).rows[0];
      const bonusProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,CURRENT_DATE,1,$5,$6,100,$7,'PER_PIECE','PER_PIECE',100,50,20,'APPROVED',$8,$8,now())
         RETURNING id,total_earning_amount`,
        [bonusWorkerEmployee.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
         bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(bonusProduction.total_earning_amount),130);
      const bonusSettlementSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(bonusSettlementSummary.statusCode,200,bonusSettlementSummary.body);
      assert.equal(Number(bonusSettlementSummary.json().data.productionEarnings),130,
        "settlement summary must use total_earning_amount, matching the payable balance and unpaid-production list");
      assert.equal(Number(bonusSettlementSummary.json().data.availableForSettlement),130,
        "the production net already includes its bonus and deduction; neither may be applied again");
      assert.equal(Number(bonusSettlementSummary.json().data.availableBreakdown.productionNet),130);
      assert.equal(Number(bonusSettlementSummary.json().data.availableBreakdown.standaloneAdjustmentsNet),0);
      assert.equal(Number(bonusSettlementSummary.json().data.availableBreakdown.ledgerOnlyAdjustmentsNet),0);
      assert.equal(Number(bonusSettlementSummary.json().data.availableBreakdown.calculatedAvailable),130,
        "the diagnostic total must not double-count production-linked bonus or deduction");
      // Production-percentage advance repayment must use production actually allocated
      // by an earlier settlement, not the full gross payout when it included an adjustment.
      const productionAdvanceWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Production Advance Worker "+randomBytes(4).toString("hex")]
      )).rows[0];
      const priorProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,CURRENT_DATE-1,1,$5,$6,130,$7,'PER_PIECE','PER_PIECE',130,0,0,'APPROVED',$8,$8,now())
         RETURNING id,total_earning_amount`,
        [productionAdvanceWorker.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
         bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(priorProduction.total_earning_amount),130);
      const priorWorkerPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at)
         VALUES($1,155,155,0,'CASH',$2,CURRENT_DATE-1+TIME '12:00') RETURNING id`,
        [productionAdvanceWorker.id,manager.id]
      )).rows[0];
      const priorSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(
           employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id
         ) VALUES($1,155,155,0,CURRENT_DATE-1,'Prior payout includes a separate 25 adjustment',$2,$3) RETURNING id`,
        [productionAdvanceWorker.id,manager.id,priorWorkerPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,130)",
        [priorSettlement.id,priorProduction.id]
      );
      // A second settlement in the same repayment window can allocate production
      // from before that window; it must not reduce the current period's production base.
      const outsidePeriodProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,CURRENT_DATE-40,1,$5,$6,50,$7,'PER_PIECE','PER_PIECE',50,0,0,'APPROVED',$8,$8,now())
         RETURNING id,total_earning_amount`,
        [productionAdvanceWorker.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
         bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(outsidePeriodProduction.total_earning_amount),50);
      const outsidePeriodPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at)
         VALUES($1,50,50,0,'CASH',$2,CURRENT_DATE-2+TIME '12:00') RETURNING id`,
        [productionAdvanceWorker.id,manager.id]
      )).rows[0];
      const outsidePeriodSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(
           employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id
         ) VALUES($1,50,50,0,CURRENT_DATE-2,'Settlement allocated to production before repayment window',$2,$3) RETURNING id`,
        [productionAdvanceWorker.id,manager.id,outsidePeriodPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,50)",
        [outsidePeriodSettlement.id,outsidePeriodProduction.id]
      );
      await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,CURRENT_DATE,1,$5,$6,100,$7,'PER_PIECE','PER_PIECE',100,0,0,'APPROVED',$8,$8,now())`,
        [productionAdvanceWorker.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
         bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
      );
      const productionPercentageAdvance=(await apiPool.query(
        `INSERT INTO advance_requests(
           employee_id,amount,reason,status,requested_by,paid_by,paid_at,
           repayment_method,production_percentage,production_period_days,repayment_status
         )
         VALUES($1,200,'Production allocation repayment regression','PAID',$2,$2,CURRENT_DATE-INTERVAL '30 days',
                'PRODUCTION_PERCENTAGE',10,15,'OPEN')
         RETURNING id`,
        [productionAdvanceWorker.id,manager.id]
      )).rows[0];
      const productionAdvancePayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:productionAdvanceWorker.id,cashCustodyEmployeeId:managerEmployee.id,amount:75,method:"CASH",idempotencyKey:randomUUID()}
      });
      assert.equal(productionAdvancePayout.statusCode,201,productionAdvancePayout.body);
      assert.equal(Number(productionAdvancePayout.json().data.payment.advance_repayment_amount),10,
        "10% repayment must be based on 100 of production remaining after the 130 allocation, not 75 after subtracting the 155 gross payout");
      const productionAdvanceRepayment=(await apiPool.query(
        "SELECT amount FROM advance_repayments WHERE advance_id=$1 AND source_worker_payment_id=$2",
        [productionPercentageAdvance.id,productionAdvancePayout.json().data.payment.id]
      )).rows[0];
      assert.equal(Number(productionAdvanceRepayment.amount),10);

      // Payroll is a separate employee entitlement and must never become production dues
      // through the ledger-only fallback for an employee without approved production.
      const payrollOnlyEmployee=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Payroll Only Worker "+randomBytes(4).toString("hex")]
      )).rows[0];
      const payrollOnlyPeriod=(await apiPool.query(
        "INSERT INTO payroll_periods(period_month,generated_by) VALUES('2099-11-01',$1) RETURNING id",
        [manager.id]
      )).rows[0];
      const payrollOnlyItem=(await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,base_salary,bonus_amount,deduction_amount) VALUES($1,$2,1000,200,0) RETURNING id",
        [payrollOnlyPeriod.id,payrollOnlyEmployee.id]
      )).rows[0];
      const payrollOnlyBonus=(await apiPool.query(
        "INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,created_by) VALUES($1,'BONUS','Payroll-only bonus regression',200,$2) RETURNING id",
        [payrollOnlyItem.id,manager.id]
      )).rows[0];
      const payrollOnlyPayment=(await apiPool.query(
        "INSERT INTO payroll_payments(payroll_item_id,amount,paid_by) VALUES($1,300,$2) RETURNING id",
        [payrollOnlyItem.id,manager.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes,payroll_item_id) VALUES($1,'ADJUSTMENT',1000,$2,'payroll-only base',$3)",
        [payrollOnlyEmployee.id,manager.id,payrollOnlyItem.id]
      );
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes,payroll_adjustment_line_id) VALUES($1,'ADJUSTMENT',200,$2,'payroll-only bonus',$3)",
        [payrollOnlyEmployee.id,manager.id,payrollOnlyBonus.id]
      );
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes,payroll_payment_id) VALUES($1,'ADJUSTMENT',300,$2,'payroll-only partial payment',$3)",
        [payrollOnlyEmployee.id,manager.id,payrollOnlyPayment.id]
      );
      const payrollOnlyPreview=await app.inject({
        method:"GET",url:`/api/worker-payments/preview?employeeId=${payrollOnlyEmployee.id}&cashCustodyEmployeeId=${managerEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(payrollOnlyPreview.statusCode,200,payrollOnlyPreview.body);
      assert.equal(Number(payrollOnlyPreview.json().data.availableEarnings),0,
        "salary accrual, payroll bonus, and payroll payout must not be offered as production dues");
      const payrollOnlySummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${payrollOnlyEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(payrollOnlySummary.statusCode,200,payrollOnlySummary.body);
      assert.equal(Number(payrollOnlySummary.json().data.availableForSettlement),0);
      assert.equal(Number(payrollOnlySummary.json().data.availableBreakdown.ledgerOnlyAdjustmentsNet),0,
        "the finance diagnostic must apply the same payroll exclusion as the payout calculation");

      
      const unpaidProductionBeforePayout=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(unpaidProductionBeforePayout.statusCode,200,unpaidProductionBeforePayout.body);
      assert.equal(unpaidProductionBeforePayout.json().data.some((row:any)=>row.id===bonusProduction.id),true,
        "the payments screen must list approved production that still has a due balance");
      assert.equal(Number(unpaidProductionBeforePayout.json().data.find((row:any)=>row.id===bonusProduction.id).remaining_amount),130);
      assert.equal(unpaidProductionBeforePayout.json().data.find((row:any)=>row.id===bonusProduction.id).payment_status,"UNPAID",
        "approved production with no allocations must be explicitly classified as unpaid");
      const invalidSelectedPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:bonusWorkerEmployee.id,cashCustodyEmployeeId:managerEmployee.id,amount:129,method:"CASH",
          settlementMode:"SELECTED_PRODUCTION",productionEntryIds:[bonusProduction.id],idempotencyKey:randomUUID()}
      });
      assert.equal(invalidSelectedPayout.statusCode,409,invalidSelectedPayout.body,
        "selected-production settlement must match the outstanding balance of the selected records");
      assert.equal(invalidSelectedPayout.json().error.code,"PRODUCTION_SETTLEMENT_AMOUNT_MISMATCH");
      // A payment can include production earnings plus a separate adjustment.
      // Only the production portion belongs in production allocation reconciliation.
      // Legacy accounting adjustments can exist in the earnings ledger without a matching
      // employee_earnings_adjustments row; they must still be included in available worker dues.
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',25,$2,'test-only non-production adjustment')",
        [bonusWorkerEmployee.id,manager.id]
      );
      const bonusAwarePayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:bonusWorkerEmployee.id,cashCustodyEmployeeId:managerEmployee.id,amount:155,method:"CASH",
          settlementMode:"ALL_DUES",productionEntryIds:[bonusProduction.id],idempotencyKey:randomUUID()}
      });
      assert.equal(bonusAwarePayout.statusCode,201,bonusAwarePayout.body,
        "all-dues payout may include both approved production earnings and a separate adjustment");
      assert.equal(Number(bonusAwarePayout.json().data.payment.gross_amount),155);
      const bonusAllocation=await apiPool.query(
        `SELECT COALESCE(SUM(a.amount),0) AS amount
           FROM employee_earnings_settlement_allocations a
           JOIN employee_earnings_settlements s ON s.id=a.settlement_id
          WHERE s.worker_payment_id=$1`,
        [bonusAwarePayout.json().data.payment.id]
      );
      assert.equal(Number(bonusAllocation.rows[0].amount),130,
        "only the production portion must be allocated to the canonical settlement allocation ledger");
      // Legacy reconciliation can leave a duplicate order-allocation row for the
      // same payment. Settlement allocations are canonical and must take precedence.
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,130) ON CONFLICT(worker_payment_id,production_entry_id) DO NOTHING",
        [bonusAwarePayout.json().data.payment.id,bonusProduction.id]
      );
      const productionHistoryAfterDuplicate=await app.inject({
        method:"GET",url:`/api/production?employeeId=${bonusWorkerEmployee.id}&status=APPROVED&limit=200`,
        headers:{cookie:managerCookie}
      });
      assert.equal(productionHistoryAfterDuplicate.statusCode,200,productionHistoryAfterDuplicate.body);
      const canonicalProductionRow=productionHistoryAfterDuplicate.json().data.find((row:any)=>row.id===bonusProduction.id);
      assert.ok(canonicalProductionRow,"production history must retain the settled production row");
      assert.equal(Number(canonicalProductionRow.paid_amount),130,
        "duplicate order allocation must not be added to the canonical settlement allocation");
      assert.equal(Number(canonicalProductionRow.remaining_amount),0,
        "duplicate allocation rows must not create a negative or remaining production balance");
      assert.equal(canonicalProductionRow.payment_status,"PAID",
        "the production row must remain paid when both allocation tables contain the same payment");
      const queueAfterAdjustmentPayout=await app.inject({
        method:"GET",url:"/api/worker-payments/historical-unallocated",headers:{cookie:managerCookie}
      });
      assert.equal(queueAfterAdjustmentPayout.statusCode,200,queueAfterAdjustmentPayout.body);
      assert.equal(queueAfterAdjustmentPayout.json().data.some((row:any)=>row.payment_id===bonusAwarePayout.json().data.payment.id),false,
        "a fully allocated production portion must not be flagged merely because gross payment also includes an adjustment");
      const payoutEmployeeOptions=await app.inject({
        method:"GET",url:"/api/worker-payments/eligible-employees",headers:{cookie:managerCookie}
      });
      assert.equal(payoutEmployeeOptions.statusCode,200,payoutEmployeeOptions.body);
      assert.ok(payoutEmployeeOptions.json().data.some((row:any)=>row.id===bonusWorkerEmployee.id),
        "payout screen should load worker options from a payout-scoped endpoint");

      const unpaidProductionAfterPayout=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(unpaidProductionAfterPayout.statusCode,200,unpaidProductionAfterPayout.body);
      const settledProductionRow=unpaidProductionAfterPayout.json().data.find((row:any)=>row.id===bonusProduction.id);
      assert.ok(settledProductionRow,"fully settled production must remain visible for payment-status review");
      assert.equal(settledProductionRow.payment_status,"PAID","fully settled production must be classified as paid");
      assert.equal(Number(settledProductionRow.remaining_amount),0,"fully settled production must have no remaining balance");

      // A legacy previous-custody payout with a settlement row but no production allocation
      // must be linked to its explicitly referenced order, then disappear from unpaid production.
      const reconcileOrderStage=(await apiPool.query(
        "SELECT id,stage_id,output_product_id FROM order_stages WHERE order_id=$1 AND is_final_product=TRUE ORDER BY sequence_no LIMIT 1",
        [multiOrderId]
      )).rows[0];
      assert.ok(reconcileOrderStage,"the test order should have a final production stage");
      const reconcileProduct=(await apiPool.query("SELECT id,unit_id FROM products WHERE id=$1",[reconcileOrderStage.output_product_id])).rows[0];
      assert.ok(reconcileProduct,"the final production stage should have an output product");
      const reconcileRateGroup=(await apiPool.query(
        "INSERT INTO rate_groups(name) VALUES($1) RETURNING id",
        ["Historical reconciliation rate group "+randomBytes(4).toString("hex")]
      )).rows[0];
      const reconcileShift=(await apiPool.query(
        "INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES($1,'08:00','16:00',$2) RETURNING id",
        ["Historical reconciliation shift "+randomBytes(4).toString("hex"),reconcileRateGroup.id]
      )).rows[0];
      const reconcileRate=(await apiPool.query(
        `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
         VALUES($1,$2,$3,$4,$5,10,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)
         RETURNING id`,
        [reconcileProduct.id,reconcileOrderStage.stage_id,reconcileRateGroup.id,perPieceWageType.id,reconcileProduct.unit_id,manager.id]
      )).rows[0];
      const reconcileProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id,total_earning_amount`,
        [bonusWorkerEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(reconcileProduction.total_earning_amount),10);
      // Historical settlement marks reduce production dues only; they must not create financial movements.
      const historicalMarkEmployee=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Historical Mark Worker') RETURNING id"
      )).rows[0];
      const historicalMarkProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE-10,2,$6,$7,10,$8,'PER_PIECE','PER_PIECE',20,0,0,'APPROVED',$9,$9,now())
         RETURNING id,total_earning_amount`,
        [historicalMarkEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const historicalListBefore=await app.inject({
        method:"GET",url:`/api/worker-payments/historical-production-settlements?employeeId=${historicalMarkEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(historicalListBefore.statusCode,200,historicalListBefore.body);
      assert.equal(historicalListBefore.json().data[0].classification,"UNPAID");
      const historicalMark=await app.inject({
        method:"PATCH",url:`/api/worker-payments/historical-production-settlements/${historicalMarkProduction.id}`,
        headers:{cookie:managerCookie},payload:{status:"PAID_PREVIOUSLY",notes:"تم السداد قبل تشغيل النظام"}
      });
      assert.equal(historicalMark.statusCode,200,historicalMark.body);
      const historicalUnpaidAfter=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${historicalMarkEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(historicalUnpaidAfter.statusCode,200,historicalUnpaidAfter.body);
      const historicalPaidRow=historicalUnpaidAfter.json().data.find((row:any)=>row.id===historicalMarkProduction.id);
      assert.ok(historicalPaidRow,"historically paid production remains visible for payment-status review");
      assert.equal(historicalPaidRow.payment_status,"PAID","historical paid mark must classify the production as paid");
      assert.equal(Number(historicalPaidRow.paid_amount),20);
      assert.equal(Number(historicalPaidRow.remaining_amount),0);
      const historicalAvailable=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${historicalMarkEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(historicalAvailable.statusCode,200,historicalAvailable.body);
      assert.equal(Number(historicalAvailable.json().data.availableForSettlement),0,
        "historical marks must reduce payable production availability");
      assert.equal(Number(historicalAvailable.json().data.previouslySettled),20,
        "historical paid marks must be included in the displayed total paid, not only deducted invisibly");
      assert.equal(Number(historicalAvailable.json().data.availableBreakdown.historicalPaid),20,
        "the reconciliation breakdown must expose historical paid marks");
      const financialArtifacts=await apiPool.query(`
        SELECT
          (SELECT COUNT(*) FROM worker_payments WHERE employee_id=$1) AS worker_payments,
          (SELECT COUNT(*) FROM employee_earnings_settlements WHERE employee_id=$1) AS settlements,
          (SELECT COUNT(*) FROM employee_earnings_ledger WHERE employee_id=$1) AS ledger,
          (SELECT COUNT(*) FROM advance_repayments ar JOIN advance_requests a ON a.id=ar.advance_id WHERE a.employee_id=$1) AS advance_repayments,
          (SELECT COUNT(*) FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT'
            AND source_id IN (SELECT id FROM worker_payments WHERE employee_id=$1)) AS custody_movements,
          (SELECT COUNT(*) FROM accounting_expenses WHERE idempotency_key IN
            (SELECT idempotency_key FROM worker_payments WHERE employee_id=$1)) AS accounting_expenses
      `,[historicalMarkEmployee.id]);
      for(const [key,value] of Object.entries(financialArtifacts.rows[0]))assert.equal(Number(value),0,`historical mark must not create ${key}`);
      // Automatic current-custody allocation must skip production already paid historically.
      const postMarkProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [historicalMarkEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const postMarkPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:historicalMarkEmployee.id,cashCustodyEmployeeId:managerEmployee.id,
          settlementSource:"CURRENT_CUSTODY",settlementMode:"ALL_DUES",amount:10,method:"CASH",idempotencyKey:randomUUID()}
      });
      assert.equal(postMarkPayout.statusCode,201,postMarkPayout.body);
      const postMarkAllocations=await apiPool.query(
        `SELECT production_entry_id,amount FROM employee_earnings_settlement_allocations
          WHERE settlement_id=(SELECT id FROM employee_earnings_settlements WHERE worker_payment_id=$1)`,
        [postMarkPayout.json().data.payment.id]
      );
      assert.equal(postMarkAllocations.rowCount,1);
      assert.equal(postMarkAllocations.rows[0].production_entry_id,postMarkProduction.id,
        "new payment must allocate to the genuinely unpaid production row, never the historically paid row");
      assert.equal(Number(postMarkAllocations.rows[0].amount),10);
      const historicalMarkStillPaid=await apiPool.query(
        "SELECT status,amount_snapshot FROM historical_production_settlement_marks WHERE production_entry_id=$1",
        [historicalMarkProduction.id]
      );
      assert.equal(historicalMarkStillPaid.rows[0].status,"PAID_PREVIOUSLY");
      assert.equal(Number(historicalMarkStillPaid.rows[0].amount_snapshot),20);
      const duplicateHistoricalMark=await app.inject({
        method:"PATCH",url:`/api/worker-payments/historical-production-settlements/${historicalMarkProduction.id}`,
        headers:{cookie:managerCookie},payload:{status:"PAID_PREVIOUSLY",notes:"محاولة تكرار"}
      });
      assert.equal(duplicateHistoricalMark.statusCode,409,"duplicate historical marks must be rejected");
      const undoHistoricalMark=await app.inject({
        method:"PATCH",url:`/api/worker-payments/historical-production-settlements/${historicalMarkProduction.id}`,
        headers:{cookie:managerCookie},payload:{status:"NEEDS_REVIEW",notes:"إعادة للمراجعة"}
      });
      assert.equal(undoHistoricalMark.statusCode,200,undoHistoricalMark.body);
      const retainedHistoricalMark=await apiPool.query(
        "SELECT status,amount_snapshot FROM historical_production_settlement_marks WHERE production_entry_id=$1",
        [historicalMarkProduction.id]
      );
      assert.equal(retainedHistoricalMark.rows[0].status,"NEEDS_REVIEW");
      assert.ok(Number(retainedHistoricalMark.rows[0].amount_snapshot)>0,
        "undo must retain the positive historical amount snapshot for audit while excluding it from paid totals");
      const historicalUnpaidRestored=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${historicalMarkEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.ok(historicalUnpaidRestored.json().data.some((row:any)=>row.id===historicalMarkProduction.id),
        "undoing the administrative mark must restore production dues");

      const conflictingEvidenceEmployee=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Conflicting Historical Evidence Worker') RETURNING id"
      )).rows[0];
      const conflictingProductionRows=[] as Array<{id:string}>;
      for(let i=0;i<2;i++){
        const row=(await apiPool.query(
          `INSERT INTO production_entries(
             employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
             wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
             status,submitted_by,approved_by,approved_at
           ) VALUES($1,$2,$3,$4,$5,CURRENT_DATE-10,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now()) RETURNING id`,
          [conflictingEvidenceEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
           reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
        )).rows[0];
        conflictingProductionRows.push(row);
      }
      const conflictingPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'conflicting allocation source test',$3,'conflicting-allocation-source-test') RETURNING id`,
        [conflictingEvidenceEmployee.id,manager.id,randomUUID()]
      )).rows[0];
      const conflictingSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'conflicting allocation source test',$2,$3) RETURNING id`,
        [conflictingEvidenceEmployee.id,manager.id,conflictingPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,10)",
        [conflictingSettlement.id,conflictingProductionRows[0].id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [conflictingPayment.id,conflictingProductionRows[1].id]
      );
      const conflictingEvidenceList=await app.inject({
        method:"GET",url:`/api/worker-payments/historical-production-settlements?employeeId=${conflictingEvidenceEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(conflictingEvidenceList.statusCode,200,conflictingEvidenceList.body);
      assert.equal(conflictingEvidenceList.json().data.length,2);
      assert.ok(conflictingEvidenceList.json().data.every((row:any)=>row.classification==="NEEDS_REVIEW"),
        "different production targets in mirrored allocation sources must be treated as ambiguous, not silently deduplicated");

      // A conflicting payment must block only production rows referenced by that payment.
      // It must not prevent a manager from recording an unrelated, independently verified
      // historical payment for another production row belonging to the same employee.
      const unrelatedHistoricalProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         ) VALUES($1,$2,$3,$4,$5,CURRENT_DATE-10,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [conflictingEvidenceEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const unrelatedHistoricalMark=await app.inject({
        method:"PATCH",
        url:`/api/worker-payments/historical-production-settlements/${unrelatedHistoricalProduction.id}`,
        headers:{cookie:managerCookie},
        payload:{status:"PAID_PREVIOUSLY",notes:"تمت مراجعة مستند السداد المستقل",confirmAmbiguousPayment:true}
      });
      assert.equal(unrelatedHistoricalMark.statusCode,200,unrelatedHistoricalMark.body);
      assert.equal(Number(unrelatedHistoricalMark.json().data.amount_snapshot),10,
        "an unrelated production row must not inherit another production's hard allocation conflict");

      const partialEvidenceEmployee=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Partial Historical Evidence Worker') RETURNING id"
      )).rows[0];
      const partialEvidenceProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         ) VALUES($1,$2,$3,$4,$5,CURRENT_DATE-10,2,$6,$7,10,$8,'PER_PIECE','PER_PIECE',20,0,0,'APPROVED',$9,$9,now()) RETURNING id`,
        [partialEvidenceEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const partialEvidencePayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'partial historical allocation test',$3,'partial-historical-allocation-test') RETURNING id`,
        [partialEvidenceEmployee.id,manager.id,randomUUID()]
      )).rows[0];
      const partialEvidenceSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'partial historical allocation test',$2,$3) RETURNING id`,
        [partialEvidenceEmployee.id,manager.id,partialEvidencePayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,5)",
        [partialEvidenceSettlement.id,partialEvidenceProduction.id]
      );
      const partialEvidenceBefore=await app.inject({
        method:"GET",url:`/api/worker-payments/historical-production-settlements?employeeId=${partialEvidenceEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(partialEvidenceBefore.statusCode,200,partialEvidenceBefore.body);
      assert.equal(partialEvidenceBefore.json().data[0].classification,"NEEDS_REVIEW");
      assert.equal(Number(partialEvidenceBefore.json().data[0].actual_paid_amount),5);
      const partialEvidenceBlocked=await app.inject({
        method:"PATCH",url:`/api/worker-payments/historical-production-settlements/${partialEvidenceProduction.id}`,
        headers:{cookie:managerCookie},payload:{status:"PAID_PREVIOUSLY",notes:"بدون اعتماد المدير"}
      });
      assert.equal(partialEvidenceBlocked.statusCode,409,"ambiguous partial payments must require explicit manager confirmation");
      assert.equal(partialEvidenceBlocked.json().error.code,"HISTORICAL_PAYMENT_NEEDS_REVIEW");
      const partialEvidenceApproved=await app.inject({
        method:"PATCH",url:`/api/worker-payments/historical-production-settlements/${partialEvidenceProduction.id}`,
        headers:{cookie:managerCookie},payload:{status:"PAID_PREVIOUSLY",notes:"تمت مراجعة مستندات السداد",confirmAmbiguousPayment:true}
      });
      assert.equal(partialEvidenceApproved.statusCode,200,partialEvidenceApproved.body);
      assert.equal(Number(partialEvidenceApproved.json().data.amount_snapshot),15,
        "manager confirmation must settle only the unpaid remainder after subtracting the existing partial allocation");
      const partialEvidenceArtifacts=await apiPool.query(
        `SELECT
          (SELECT COUNT(*) FROM worker_payments WHERE employee_id=$1) AS payments,
          (SELECT COUNT(*) FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id IN (SELECT id FROM worker_payments WHERE employee_id=$1)) AS custody`,
        [partialEvidenceEmployee.id]
      );
      assert.equal(Number(partialEvidenceArtifacts.rows[0].payments),1,"historical confirmation must not create another worker payment");
      assert.equal(Number(partialEvidenceArtifacts.rows[0].custody),0,"historical confirmation must not create a custody movement");

      const reconcileKey=randomUUID();
      const reconcilePayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'historical reconciliation regression',$3,'historical-reconciliation-regression') RETURNING id`,
        [bonusWorkerEmployee.id,manager.id,reconcileKey]
      )).rows[0];
      const reconcileSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'historical reconciliation regression',$2,$3) RETURNING id`,
        [bonusWorkerEmployee.id,manager.id,reconcilePayment.id]
      )).rows[0];
      await apiPool.query(
        `INSERT INTO accounting_expenses(
           order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,
           expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash
         )
         VALUES($1,$2,'WORKER_PAYMENT','Historical worker settlement reconciliation test',10,CURRENT_DATE,'CASH',$3,'DIRECT',NULL,$4,'historical-reconciliation-test-hash')`,
        [multiOrderId,reconcileOrderStage.id,manager.id,reconcileKey]
      );
      const reconciled=await app.inject({
        method:"POST",url:"/api/worker-payments/reconcile-historical-allocations",headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(reconciled.statusCode,200,reconciled.body);
      assert.ok(reconciled.json().data.reconciledCount>=1,JSON.stringify(reconciled.json().data));
      const reconciledAllocation=await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM employee_earnings_settlement_allocations WHERE settlement_id=$1",
        [reconcileSettlement.id]
      );
      assert.equal(Number(reconciledAllocation.rows[0].amount),10,
        "a clearly linked legacy settlement must be connected to its original production record");
      const unpaidAfterHistoricalReconcile=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(unpaidAfterHistoricalReconcile.statusCode,200,unpaidAfterHistoricalReconcile.body);
      const reconciledPaidProduction=unpaidAfterHistoricalReconcile.json().data.find((row:any)=>row.id===reconcileProduction.id);
      assert.ok(reconciledPaidProduction,"reconciled historical production remains visible for payment-status review");
      assert.equal(reconciledPaidProduction.payment_status,"PAID");
      assert.equal(Number(reconciledPaidProduction.paid_amount),10);
      assert.equal(Number(reconciledPaidProduction.remaining_amount),0);

      // Legacy-source conflicts and historical paid-mark conflicts must surface as NEEDS_REVIEW.
      // A legacy allocation that points to production already marked PAID_PREVIOUSLY
      // must remain unresolved; reconciliation must not mirror it into the canonical ledger.
      const markedConflictEmployee=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Historical Allocation Conflict Worker') RETURNING id"
      )).rows[0];
      const markedConflictProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE-2,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id,total_earning_amount`,
        [markedConflictEmployee.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const markedConflictPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'historical paid conflict regression',$3,'historical-paid-conflict-regression') RETURNING id`,
        [markedConflictEmployee.id,manager.id,randomUUID()]
      )).rows[0];
      const markedConflictSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'historical paid conflict regression',$2,$3) RETURNING id`,
        [markedConflictEmployee.id,manager.id,markedConflictPayment.id]
      )).rows[0];
      await apiPool.query(
        `INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)`,
        [markedConflictPayment.id,markedConflictProduction.id]
      );
      await apiPool.query(
        `INSERT INTO historical_production_settlement_marks(
           employee_id,production_entry_id,amount_snapshot,status,notes,marked_by,updated_by
         ) VALUES($1,$2,10,'PAID_PREVIOUSLY','تم السداد قبل تشغيل النظام',$3,$3)`,
        [markedConflictEmployee.id,markedConflictProduction.id,manager.id]
      );
      const markedConflictReconcile=await app.inject({
        method:"POST",url:"/api/worker-payments/reconcile-historical-allocations",
        headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(markedConflictReconcile.statusCode,200,markedConflictReconcile.body);
      assert.equal(markedConflictReconcile.json().data.reconciledCount,0,
        "a payment already attributed to historically paid production must not be reconciled");
      assert.ok(markedConflictReconcile.json().data.skipped.some((row:any)=>row.paymentId===markedConflictPayment.id),
        "the conflicting legacy payment must be explicitly reported as skipped");
      const markedConflictCanonical=await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_settlement_allocations WHERE settlement_id=$1",
        [markedConflictSettlement.id]
      );
      assert.equal(Number(markedConflictCanonical.rows[0].count),0,
        "conflicting historical allocation must not be mirrored into canonical settlement allocations");
      const markedConflictStatus=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${markedConflictEmployee.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(markedConflictStatus.statusCode,200,markedConflictStatus.body);
      const markedConflictRow=markedConflictStatus.json().data.find((row:any)=>row.id===markedConflictProduction.id);
      assert.equal(markedConflictRow.payment_status,"NEEDS_REVIEW",
        "a historical paid mark and a real allocation on the same production must be surfaced as a conflict");
      assert.equal(markedConflictRow.payment_conflict,true);

      // Some legacy paths wrote both settlement allocations and order allocations for one payment.
      // The unified ledger must prefer the settlement allocation instead of counting the same payout twice.
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [reconcilePayment.id,reconcileProduction.id]
      );
      const reconciledOrderSummary=await app.inject({
        method:"GET",
        url:`/api/worker-payments/settlement-summary?employeeId=${bonusWorkerEmployee.id}&orderId=${multiOrderId}&orderStageId=${reconcileOrderStage.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(reconciledOrderSummary.statusCode,200,reconciledOrderSummary.body);
      assert.equal(Number(reconciledOrderSummary.json().data.orderAccount.paid),10,
        "the same historical payment recorded in both allocation tables must count once");
      assert.equal(Number(reconciledOrderSummary.json().data.orderAccount.remaining),0,
        "fully settled order production must have no remaining balance");

      // The same worker payment may have stale order/legacy allocations on a different
      // production row. A settlement allocation is canonical for the whole payment.
      const crossLedgerWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Cross Ledger Precedence Worker') RETURNING id"
      )).rows[0];
      const crossLedgerProductionA=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [crossLedgerWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const crossLedgerProductionB=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [crossLedgerWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const crossLedgerPaymentKey=randomUUID();
      const crossLedgerPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'cross-ledger precedence test',$3,'cross-ledger-precedence-test') RETURNING id`,
        [crossLedgerWorker.id,manager.id,crossLedgerPaymentKey]
      )).rows[0];
      const crossLedgerSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'cross-ledger precedence test',$2,$3) RETURNING id`,
        [crossLedgerWorker.id,manager.id,crossLedgerPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,10)",
        [crossLedgerSettlement.id,crossLedgerProductionA.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [crossLedgerPayment.id,crossLedgerProductionB.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [crossLedgerPayment.id,crossLedgerProductionB.id]
      );
      await apiPool.query(
        `INSERT INTO accounting_expenses(
           order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,
           expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash
         )
         VALUES($1,$2,'WORKER_PAYMENT','Cross-ledger precedence test',10,CURRENT_DATE,'CASH',$3,'DIRECT',NULL,$4,'cross-ledger-precedence-hash')`,
        [multiOrderId,reconcileOrderStage.id,manager.id,crossLedgerPaymentKey]
      );
      const crossLedgerOrderSummary=await app.inject({
        method:"GET",
        url:`/api/production/earnings/order-summary?orderId=${multiOrderId}&employeeId=${crossLedgerWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(crossLedgerOrderSummary.statusCode,200,crossLedgerOrderSummary.body);
      const crossLedgerOrderRow=crossLedgerOrderSummary.json().data.find((row:any)=>row.employee_id===crossLedgerWorker.id);
      assert.ok(crossLedgerOrderRow,"order summary should include the employee's approved production");
      assert.equal(Number(crossLedgerOrderRow.total_earned),20);
      assert.equal(Number(crossLedgerOrderRow.paid_amount),10,
        "order summary must prefer settlement allocation even when stale order and legacy rows target a different production entry");
      assert.equal(Number(crossLedgerOrderRow.remaining_amount),10);
      assert.equal(crossLedgerOrderRow.payment_status,"PARTIAL");
      const crossLedgerProductionStatus=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${crossLedgerWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(crossLedgerProductionStatus.statusCode,200,crossLedgerProductionStatus.body);
      const partialProductionStatus=crossLedgerProductionStatus.json().data.find((row:any)=>row.id===crossLedgerProductionA.id);
      assert.ok(partialProductionStatus,"partially paid production must remain visible in the settlement status list");
      assert.equal(partialProductionStatus.payment_status,"NEEDS_REVIEW",
        "a canonical allocation that conflicts with stale mirrored allocations to another production record must require review");
      assert.equal(partialProductionStatus.payment_conflict,true);
      assert.equal(Number(partialProductionStatus.paid_amount),10);
      assert.equal(Number(partialProductionStatus.remaining_amount),0);
      const unpaidProductionStatus=crossLedgerProductionStatus.json().data.find((row:any)=>row.id===crossLedgerProductionB.id);
      assert.ok(unpaidProductionStatus,"unpaid production must remain visible in the settlement status list");
      assert.equal(unpaidProductionStatus.payment_status,"NEEDS_REVIEW",
        "a production targeted only by conflicting stale allocation sources must be flagged for review");
      assert.equal(unpaidProductionStatus.payment_conflict,true);
      assert.equal(Number(unpaidProductionStatus.remaining_amount),10);

      // A partially allocated settlement owns only its canonical allocation rows.
      // The unallocated remainder still counts at order level, while stale order/legacy
      // rows for the same payment must not be counted a second time.
      const partialLedgerWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Partial Settlement Precedence Worker') RETURNING id"
      )).rows[0];
      const partialLedgerProductionA=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [partialLedgerWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const partialLedgerProductionB=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [partialLedgerWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const partialLedgerPaymentKey=randomUUID();
      const partialLedgerPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'partial settlement precedence test',$3,'partial-settlement-precedence-test') RETURNING id`,
        [partialLedgerWorker.id,manager.id,partialLedgerPaymentKey]
      )).rows[0];
      const partialLedgerSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'partial settlement precedence test',$2,$3) RETURNING id`,
        [partialLedgerWorker.id,manager.id,partialLedgerPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,5)",
        [partialLedgerSettlement.id,partialLedgerProductionA.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,5)",
        [partialLedgerPayment.id,partialLedgerProductionB.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,5)",
        [partialLedgerPayment.id,partialLedgerProductionB.id]
      );
      await apiPool.query(
        `INSERT INTO accounting_expenses(
           order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,
           expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash
         )
         VALUES($1,$2,'WORKER_PAYMENT','Partial settlement precedence test',10,CURRENT_DATE,'CASH',$3,'DIRECT',NULL,$4,'partial-settlement-precedence-hash')`,
        [multiOrderId,reconcileOrderStage.id,manager.id,partialLedgerPaymentKey]
      );
      const partialLedgerOrderSummary=await app.inject({
        method:"GET",
        url:`/api/production/earnings/order-summary?orderId=${multiOrderId}&employeeId=${partialLedgerWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(partialLedgerOrderSummary.statusCode,200,partialLedgerOrderSummary.body);
      const partialLedgerOrderRow=partialLedgerOrderSummary.json().data.find((row:any)=>row.employee_id===partialLedgerWorker.id);
      assert.ok(partialLedgerOrderRow,"order summary should include the partially allocated employee production");
      assert.equal(Number(partialLedgerOrderRow.total_earned),20);
      assert.equal(Number(partialLedgerOrderRow.paid_amount),10,
        "order summary must count canonical allocation plus only the unallocated remainder, ignoring stale duplicate rows");
      assert.equal(Number(partialLedgerOrderRow.remaining_amount),10);
      assert.equal(partialLedgerOrderRow.payment_status,"PARTIAL");
      const partialLedgerProductionStatus=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${partialLedgerWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(partialLedgerProductionStatus.statusCode,200,partialLedgerProductionStatus.body);
      const genuinelyPartialRow=partialLedgerProductionStatus.json().data.find((row:any)=>row.id===partialLedgerProductionA.id);
      assert.ok(genuinelyPartialRow,"partially paid production row must be returned");
      assert.equal(genuinelyPartialRow.payment_status,"NEEDS_REVIEW",
        "a partial canonical allocation with conflicting mirrored sources must require review");
      assert.equal(genuinelyPartialRow.payment_conflict,true);
      assert.equal(Number(genuinelyPartialRow.paid_amount),5);
      assert.equal(Number(genuinelyPartialRow.remaining_amount),5);
      const untouchedUnpaidRow=partialLedgerProductionStatus.json().data.find((row:any)=>row.id===partialLedgerProductionB.id);
      assert.ok(untouchedUnpaidRow,"production without canonical settlement allocation remains unpaid");
      assert.equal(untouchedUnpaidRow.payment_status,"NEEDS_REVIEW",
        "a production targeted by conflicting stale allocation sources must require review");
      assert.equal(untouchedUnpaidRow.payment_conflict,true);
      assert.equal(Number(untouchedUnpaidRow.paid_amount),0);
      assert.equal(Number(untouchedUnpaidRow.remaining_amount),10);

      // Previous-custody settlement is bounded by the selected order, not the worker's
      // global available balance. A standalone ledger deduction can make the global
      // balance lower while the selected order still has its own payable production.
      const orderScopedSettlementWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Order Scoped Settlement Worker') RETURNING id"
      )).rows[0];
      const orderScopedProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,10,$6,$7,10,$8,'PER_PIECE','PER_PIECE',100,0,0,'APPROVED',$9,$9,now())
         RETURNING id,total_earning_amount`,
        [orderScopedSettlementWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(orderScopedProduction.total_earning_amount),100);
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',40,$2,'order-scoped settlement regression deduction')",
        [orderScopedSettlementWorker.id,manager.id]
      );
      const orderScopedSummary=await app.inject({
        method:"GET",
        url:`/api/worker-payments/settlement-summary?employeeId=${orderScopedSettlementWorker.id}&orderId=${multiOrderId}&orderStageId=${reconcileOrderStage.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(orderScopedSummary.statusCode,200,orderScopedSummary.body);
      assert.equal(Number(orderScopedSummary.json().data.availableForSettlement),100,
        "selected order due must remain independent from the lower global balance");
      const orderScopedPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:orderScopedSettlementWorker.id,settlementSource:"PREVIOUS_CUSTODY",
          orderId:multiOrderId,orderStageId:reconcileOrderStage.id,amount:100,method:"CASH",idempotencyKey:randomUUID()}
      });
      assert.equal(orderScopedPayout.statusCode,201,orderScopedPayout.body,
        "previous-custody payout must validate and execute against selected order balance, not global available balance");
      assert.equal(Number(orderScopedPayout.json().data.grossAmount),100);
      const currentOrderScopedWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Current Order Scoped Worker') RETURNING id"
      )).rows[0];
      await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())`,
        [currentOrderScopedWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      );
      const currentOrderScopedKey=randomUUID();
      const currentOrderScopedPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:currentOrderScopedWorker.id,settlementSource:"CURRENT_CUSTODY",
          cashCustodyEmployeeId:managerEmployee.id,orderId:multiOrderId,
          orderStageId:reconcileOrderStage.id,amount:10,method:"CASH",idempotencyKey:currentOrderScopedKey}
      });
      assert.equal(currentOrderScopedPayout.statusCode,201,currentOrderScopedPayout.body);
      const currentOrderScopedPaymentId=currentOrderScopedPayout.json().data.payment.id;
      const currentOrderScopedExpense=await apiPool.query(
        "SELECT order_id,order_stage_id,amount,paid_from_employee_id,cash_custody_transaction_id,source_worker_payment_id FROM accounting_expenses WHERE source_worker_payment_id=$1",
        [currentOrderScopedPaymentId]
      );
      assert.equal(currentOrderScopedExpense.rowCount,1);
      assert.equal(currentOrderScopedExpense.rows[0].order_id,multiOrderId);
      assert.equal(currentOrderScopedExpense.rows[0].order_stage_id,reconcileOrderStage.id);
      assert.equal(Number(currentOrderScopedExpense.rows[0].amount),10);
      assert.equal(currentOrderScopedExpense.rows[0].paid_from_employee_id,managerEmployee.id);
      assert.equal(currentOrderScopedExpense.rows[0].source_worker_payment_id,currentOrderScopedPaymentId);
      const currentOrderScopedOut=await apiPool.query(
        "SELECT id,employee_id,amount FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [currentOrderScopedPaymentId]
      );
      assert.equal(currentOrderScopedOut.rowCount,1);
      assert.equal(currentOrderScopedOut.rows[0].employee_id,managerEmployee.id);
      assert.equal(Number(currentOrderScopedOut.rows[0].amount),10);
      assert.equal(currentOrderScopedExpense.rows[0].cash_custody_transaction_id,currentOrderScopedOut.rows[0].id);

      // An all-orders settlement must split labor expense by the real production
      // order/stage allocations and leave independent ledger adjustments general.
      const splitExpenseWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Split Expense Worker') RETURNING id"
      )).rows[0];
      const splitOtherOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{
          orderName:"Split worker expense second order "+productSuffix,
          customerName:"Isolated integration test",
          stages:[{stageName:"Split worker expense stage "+productSuffix,
            outputProductName:"Split worker expense product "+productSuffix,sequenceNo:1,
            plannedQuantity:1,stageRate:10,stageRateMethod:"PER_PIECE",isFinalProduct:true}]
        }
      });
      assert.equal(splitOtherOrder.statusCode,201,splitOtherOrder.body);
      const secondExpenseStage=(await apiPool.query(
        "SELECT id,stage_id,output_product_id FROM order_stages WHERE order_id=$1 ORDER BY sequence_no LIMIT 1",
        [splitOtherOrder.json().data.id]
      )).rows[0];
      assert.ok(secondExpenseStage,"split expense test requires a second order stage");
      const secondExpenseProduct=(await apiPool.query(
        "SELECT id,unit_id FROM products WHERE id=$1",
        [secondExpenseStage.output_product_id]
      )).rows[0];
      const secondExpenseRate=(await apiPool.query(
        `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
         VALUES($1,$2,$3,$4,$5,10,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)
         RETURNING id`,
        [secondExpenseProduct.id,secondExpenseStage.stage_id,reconcileRateGroup.id,perPieceWageType.id,secondExpenseProduct.unit_id,manager.id]
      )).rows[0];
      await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [splitExpenseWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      );
      await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [splitExpenseWorker.id,secondExpenseStage.id,secondExpenseProduct.id,secondExpenseStage.stage_id,
         reconcileShift.id,secondExpenseProduct.unit_id,secondExpenseRate.id,perPieceWageType.id,manager.id]
      );
      const thirdExpenseStage=(await apiPool.query(
        "SELECT id,stage_id,output_product_id FROM order_stages WHERE order_id=$1 AND id<>$2 ORDER BY sequence_no DESC LIMIT 1",
        [multiOrderId,reconcileOrderStage.id]
      )).rows[0];
      assert.ok(thirdExpenseStage,"split expense test requires a second stage on the first order");
      const thirdExpenseProduct=(await apiPool.query(
        "SELECT id,unit_id FROM products WHERE id=$1",
        [thirdExpenseStage.output_product_id]
      )).rows[0];
      const thirdExpenseRate=(await apiPool.query(
        `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
         VALUES($1,$2,$3,$4,$5,10,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)
         RETURNING id`,
        [thirdExpenseProduct.id,thirdExpenseStage.stage_id,reconcileRateGroup.id,perPieceWageType.id,thirdExpenseProduct.unit_id,manager.id]
      )).rows[0];
      await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [splitExpenseWorker.id,thirdExpenseStage.id,thirdExpenseProduct.id,thirdExpenseStage.stage_id,
         reconcileShift.id,thirdExpenseProduct.unit_id,thirdExpenseRate.id,perPieceWageType.id,manager.id]
      );
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',5,$2,'split expense standalone adjustment')",
        [splitExpenseWorker.id,manager.id]
      );
      const splitExpenseKey=randomUUID();
      const splitExpensePayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:splitExpenseWorker.id,settlementSource:"CURRENT_CUSTODY",
          cashCustodyEmployeeId:managerEmployee.id,amount:35,method:"CASH",idempotencyKey:splitExpenseKey}
      });
      assert.equal(splitExpensePayout.statusCode,201,splitExpensePayout.body);
      const splitExpenseRows=await apiPool.query(
        `SELECT order_id,order_stage_id,amount,allocation_type,source_worker_payment_id,
                paid_from_employee_id,cash_custody_transaction_id
           FROM accounting_expenses
          WHERE source_worker_payment_id=$1
          ORDER BY order_id NULLS LAST,order_stage_id NULLS LAST`,
        [splitExpensePayout.json().data.payment.id]
      );
      assert.equal(splitExpenseRows.rowCount,4,"three production order/stage scopes plus one standalone general amount");
      assert.equal(Number(splitExpenseRows.rows.reduce((sum:any,row:any)=>sum+Number(row.amount),0)),35);
      const orderExpenseRows=splitExpenseRows.rows.filter((row:any)=>row.order_id!==null);
      const generalExpenseRows=splitExpenseRows.rows.filter((row:any)=>row.order_id===null);
      assert.equal(orderExpenseRows.length,3);
      assert.equal(generalExpenseRows.length,1);
      assert.equal(Number(generalExpenseRows[0].amount),5,"standalone ledger adjustment must remain unallocated");
      assert.equal(new Set(orderExpenseRows.map((row:any)=>row.order_id)).size,2,"the production expenses must retain two actual orders");
      assert.equal(new Set(orderExpenseRows.map((row:any)=>row.order_stage_id)).size,3,"production expenses must preserve three actual stages");
      assert.ok(orderExpenseRows.every((row:any)=>Number(row.amount)===10));
      assert.ok(splitExpenseRows.rows.every((row:any)=>row.source_worker_payment_id===splitExpensePayout.json().data.payment.id));
      const linkedExpenseRows=splitExpenseRows.rows.filter((row:any)=>row.cash_custody_transaction_id!==null);
      assert.equal(linkedExpenseRows.length,1,"one real custody movement must be linked once, not duplicated across split expenses");
      assert.equal(linkedExpenseRows[0].paid_from_employee_id,managerEmployee.id);
      const splitExpenseMovement=await apiPool.query(
        "SELECT id,amount FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [splitExpensePayout.json().data.payment.id]
      );
      assert.equal(splitExpenseMovement.rowCount,1);
      assert.equal(Number(splitExpenseMovement.rows[0].amount),35);
      assert.equal(linkedExpenseRows[0].cash_custody_transaction_id,splitExpenseMovement.rows[0].id);
      const splitExpenseRetry=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:splitExpenseWorker.id,settlementSource:"CURRENT_CUSTODY",
          cashCustodyEmployeeId:managerEmployee.id,amount:35,method:"CASH",idempotencyKey:splitExpenseKey}
      });
      assert.equal(splitExpenseRetry.statusCode,200,splitExpenseRetry.body);
      assert.equal(splitExpenseRetry.json().data.payment.id,splitExpensePayout.json().data.payment.id);
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE source_worker_payment_id=$1",
        [splitExpensePayout.json().data.payment.id]
      )).rows[0].count),4,"retry must preserve the same four expense allocations");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [splitExpensePayout.json().data.payment.id]
      )).rows[0].count),1,"retry must not duplicate the single custody movement");


      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [orderScopedPayout.json().data.payment.id]
      )).rows[0].count),0,"order-scoped previous-custody settlement must not debit current custody");

      // Cross-payment over-allocation must abort a previous-custody payout atomically.
      // The same production entry is already fully covered by two distinct legacy sources.
      const overallocatedWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Cross Payment Over-allocation Worker') RETURNING id"
      )).rows[0];
      const overallocatedProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id,total_earning_amount`,
        [overallocatedWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(overallocatedProduction.total_earning_amount),10);
      const legacyDirectPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes)
         VALUES($1,10,10,0,'CASH',$2,'cross-payment direct allocation fixture') RETURNING id`,
        [overallocatedWorker.id,manager.id]
      )).rows[0];
      const legacyOrderPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes)
         VALUES($1,10,10,0,'CASH',$2,'cross-payment order allocation fixture') RETURNING id`,
        [overallocatedWorker.id,manager.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [legacyDirectPayment.id,overallocatedProduction.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [legacyOrderPayment.id,overallocatedProduction.id]
      );
      const overallocatedPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:overallocatedWorker.id,settlementSource:"PREVIOUS_CUSTODY",
          orderId:multiOrderId,orderStageId:reconcileOrderStage.id,amount:1,method:"CASH",
          allowOverpayment:true,idempotencyKey:randomUUID()}
      });
      assert.equal(overallocatedPayout.statusCode,409,overallocatedPayout.body);
      assert.equal(overallocatedPayout.json().error.code,"PRODUCTION_ALREADY_SETTLED");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1",
        [overallocatedWorker.id]
      )).rows[0].count),2,
        "a rejected cross-payment over-allocation must roll back the new payment row");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_settlements WHERE employee_id=$1",
        [overallocatedWorker.id]
      )).rows[0].count),0,
        "a rejected cross-payment over-allocation must roll back the settlement row");

      const employeeStatementAfterReconcile=await app.inject({
        method:"GET",url:`/api/worker-payments/employee-statement?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(employeeStatementAfterReconcile.statusCode,200,employeeStatementAfterReconcile.body);
      const reconciledProductionStatement=employeeStatementAfterReconcile.json().data.production.find((row:any)=>row.id===reconcileProduction.id);
      assert.ok(reconciledProductionStatement);
      assert.equal(Number(reconciledProductionStatement.paid_amount),10,
        "employee statement must not count settlement and order allocation rows for the same payment twice");

      const currentCustodyGuardWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Current Custody Guard Worker') RETURNING id"
      )).rows[0];
      const currentCustodyGuardProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,10,$8,'PER_PIECE','PER_PIECE',10,0,0,'APPROVED',$9,$9,now())
         RETURNING id`,
        [currentCustodyGuardWorker.id,reconcileOrderStage.id,reconcileProduct.id,reconcileOrderStage.stage_id,
         reconcileShift.id,reconcileProduct.unit_id,reconcileRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      const currentCustodyGuardKey=randomUUID();
      const currentCustodyGuardPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'current custody duplicate guard test',$3,'current-custody-duplicate-guard') RETURNING id`,
        [currentCustodyGuardWorker.id,manager.id,currentCustodyGuardKey]
      )).rows[0];
      const currentCustodyGuardSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'current custody duplicate guard test',$2,$3) RETURNING id`,
        [currentCustodyGuardWorker.id,manager.id,currentCustodyGuardPayment.id]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,10)",
        [currentCustodyGuardSettlement.id,currentCustodyGuardProduction.id]
      );
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10)",
        [currentCustodyGuardPayment.id,currentCustodyGuardProduction.id]
      );
      await apiPool.query(
        `INSERT INTO accounting_expenses(
           order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,
           expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash
         )
         VALUES($1,$2,'WORKER_PAYMENT','Current custody duplicate guard test',10,CURRENT_DATE,'CASH',$3,'DIRECT',NULL,$4,'current-custody-duplicate-guard-hash')`,
        [multiOrderId,reconcileOrderStage.id,manager.id,currentCustodyGuardKey]
      );
      await apiPool.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',10,$2,'current custody duplicate guard test')",
        [currentCustodyGuardWorker.id,manager.id]
      );
      const duplicateCurrentCustodyKey=randomUUID();
      const duplicateCurrentCustodyPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:currentCustodyGuardWorker.id,cashCustodyEmployeeId:managerEmployee.id,
          settlementSource:"CURRENT_CUSTODY",settlementMode:"SELECTED_PRODUCTION",
          productionEntryIds:[currentCustodyGuardProduction.id],amount:1,method:"CASH",idempotencyKey:duplicateCurrentCustodyKey}
      });
      assert.equal(duplicateCurrentCustodyPayout.statusCode,409,duplicateCurrentCustodyPayout.body);
      assert.equal(duplicateCurrentCustodyPayout.json().error.code,"PRODUCTION_ALREADY_SETTLED",
        "current-custody payout must reject production already paid through settlement and order allocation rows");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payments WHERE idempotency_key=$1",
        [duplicateCurrentCustodyKey]
      )).rows[0].count),0,"rejected current-custody payout must not create a payment");

      const duplicatePreviousCustodyKey=randomUUID();
      const duplicatePreviousCustodyPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:bonusWorkerEmployee.id,settlementSource:"PREVIOUS_CUSTODY",orderId:multiOrderId,
          orderStageId:reconcileOrderStage.id,amount:1,method:"CASH",idempotencyKey:duplicatePreviousCustodyKey}
      });
      assert.equal(duplicatePreviousCustodyPayout.statusCode,409,duplicatePreviousCustodyPayout.body);
      assert.equal(duplicatePreviousCustodyPayout.json().error.code,"ORDER_BALANCE_EXCEEDED",
        "previous-custody payouts must not ignore amounts already allocated through settlements");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payments WHERE idempotency_key=$1",
        [duplicatePreviousCustodyKey]
      )).rows[0].count),0,"rejected duplicate settlement must not create a payment");

      // Older worker payments can already have a settlement row but no canonical
      // production-allocation rows; those must still appear in the historical review queue.
      const unallocatedHistoricalPayment=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,notes,idempotency_key,idempotency_fingerprint)
         VALUES($1,10,10,0,'CASH',$2,'historical allocation regression test',$3,'historical-allocation-regression') RETURNING id`,
        [bonusWorkerEmployee.id,manager.id,randomUUID()]
      )).rows[0];
      const unallocatedHistoricalSettlement=(await apiPool.query(
        `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
         VALUES($1,10,10,0,CURRENT_DATE,'historical allocation regression test',$2,$3) RETURNING id`,
        [bonusWorkerEmployee.id,manager.id,unallocatedHistoricalPayment.id]
      )).rows[0];
      // Legacy and canonical ledgers can both contain the same historical attribution.
      // The review UI must report the canonical settlement allocation only, not sum both.
      await apiPool.query(
        `INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,2)`,
        [unallocatedHistoricalSettlement.id,bonusProduction.id]
      );
      await apiPool.query(
        `INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,2)`,
        [unallocatedHistoricalPayment.id,bonusProduction.id]
      );
      const historicalOrderOptions=await app.inject({
        method:"GET",url:"/api/worker-payments/historical-allocation-orders",headers:{cookie:managerCookie}
      });
      assert.equal(historicalOrderOptions.statusCode,200,historicalOrderOptions.body);
      assert.ok(historicalOrderOptions.json().data.length>0,
        "historical review must provide order options through its own permission-scoped endpoint");

      const historicalQueue=await app.inject({
        method:"GET",url:"/api/worker-payments/historical-unallocated",headers:{cookie:managerCookie}
      });
      assert.equal(historicalQueue.statusCode,200,historicalQueue.body);
      assert.equal(historicalQueue.json().data.some((row:any)=>row.payment_id===unallocatedHistoricalPayment.id),true,
        "historical payments linked to a settlement but missing production allocation must be visible");
      const historicalQueueRow=historicalQueue.json().data.find((row:any)=>row.payment_id===unallocatedHistoricalPayment.id);
      assert.ok(historicalQueueRow.settlement_id);
      assert.equal(Number(historicalQueueRow.production_allocated),2,
        "historical queue must not double-count matching legacy and canonical allocations");
      assert.equal(Number(historicalQueueRow.production_allocation_count),1);
      const blockedUntilHistoricalAllocation=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:bonusWorkerEmployee.id,cashCustodyEmployeeId:managerEmployee.id,amount:1,method:"CASH",
          settlementMode:"ALL_DUES",productionEntryIds:[bonusProduction.id],idempotencyKey:randomUUID()}
      });
      assert.equal(blockedUntilHistoricalAllocation.statusCode,409,blockedUntilHistoricalAllocation.body);
      assert.equal(blockedUntilHistoricalAllocation.json().error.code,"HISTORICAL_PAYMENTS_NEED_ALLOCATION",
        "new production settlement must wait until the employee's historic payment is attributed to production");

      const settlementsBeforeInsufficientCustody=await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_settlements WHERE employee_id=$1",
        [workerEmployee.id]
      );
      const insufficientCustodyPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:workerEmployee.id,cashCustodyEmployeeId:workerEmployee.id,amount:10,method:"CASH",idempotencyKey:randomUUID()}
      });
      assert.equal(insufficientCustodyPayout.statusCode,409,insufficientCustodyPayout.body);
      assert.equal(insufficientCustodyPayout.json().error.code,"INSUFFICIENT_CASH_CUSTODY_BALANCE");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1 AND payment_request_id IS NULL",[workerEmployee.id])).rows[0].count),0,
        "an insufficient custody balance must not leave a direct payment");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM employee_earnings_settlements WHERE employee_id=$1",[workerEmployee.id])).rows[0].count),Number(settlementsBeforeInsufficientCustody.rows[0].count),
        "an insufficient custody balance must not leave an additional settlement");
      const directPayload={employeeId:workerEmployee.id,cashCustodyEmployeeId:managerEmployee.id,amount:100,method:"CASH",idempotencyKey:randomUUID()};
      const otherDirectPayload={...directPayload,idempotencyKey:randomUUID()};
      const concurrentDirect=await Promise.all([
        app.inject({method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:directPayload}),
        app.inject({method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:otherDirectPayload})
      ]);
      assert.equal(concurrentDirect.filter(response=>response.statusCode===201).length,1,
        "only one concurrent direct payout may consume the remaining employee entitlement");
      assert.equal(concurrentDirect.filter(response=>response.statusCode===409).length,1,
        "the second concurrent direct payout must be rejected once the remaining entitlement is insufficient");
      const directSuccessIndex=concurrentDirect.findIndex(response=>response.statusCode===201);
      const directSuccess=concurrentDirect[directSuccessIndex];
      const successfulDirectPayload=directSuccessIndex===0?directPayload:otherDirectPayload;
      const directPaymentId=directSuccess.json().data.payment.id;
      const replayedDirect=await app.inject({method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:successfulDirectPayload});
      assert.equal(replayedDirect.statusCode,200,replayedDirect.body,"retrying the same direct payout key must return the original payout");
      assert.equal(replayedDirect.json().data.payment.id,directPaymentId,"a retry must not create another payout");
      const reusedDirectKey=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{...successfulDirectPayload,amount:successfulDirectPayload.amount+1}
      });
      assert.equal(reusedDirectKey.statusCode,409,reusedDirectKey.body,
        "reusing a direct payout key with a different amount must be rejected");
      assert.equal(reusedDirectKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE idempotency_key=$1",[successfulDirectPayload.idempotencyKey])).rows[0].count),1);
      const directCustody=await apiPool.query(
        "SELECT direction,amount,source_type,source_id FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
        [directPaymentId]
      );
      assert.equal(directCustody.rowCount,1,"direct payout must create exactly one custody movement");
      assert.equal(directCustody.rows[0].direction,"OUT");
      assert.equal(Number(directCustody.rows[0].amount),100);
      assert.equal(directCustody.rows[0].source_id,directPaymentId);
      const noRequestLink=await apiPool.query("SELECT payment_request_id,gross_amount,amount FROM worker_payments WHERE id=$1",[directPaymentId]);
      assert.equal(noRequestLink.rows[0].payment_request_id,null,"direct payout must not fabricate a payment request");
      assert.equal(Number(noRequestLink.rows[0].gross_amount),100);
      assert.equal(Number(noRequestLink.rows[0].amount),100);

      const directRemainder=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{...directPayload,idempotencyKey:randomUUID(),amount:50,notes:"Direct payout remainder test"}
      });
      assert.equal(directRemainder.statusCode,201,directRemainder.body);
      assert.equal(Number(directRemainder.json().data.payment.amount),50);
      const afterDirectRemainder=await app.inject({method:"GET",url:"/api/payments/my-balance",headers:{cookie:workerCookie}});
      assert.equal(afterDirectRemainder.statusCode,200,afterDirectRemainder.body);
      assert.equal(Number(afterDirectRemainder.json().data.availableEarnings),0,
        "direct partial and final payouts must settle the available entitlement exactly");
      const directPayments=await apiPool.query(
        "SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0) AS total FROM worker_payments WHERE employee_id=$1 AND payment_request_id IS NULL",
        [workerEmployee.id]
      );
      assert.ok(Number(directPayments.rows[0].count)>=2);
      assert.ok(Number(directPayments.rows[0].total)>=150);

      // A retry of a committed payout remains safe after the accounting period closes,
      // while a new payout must be blocked by that same period lock.
      const directCountBeforePeriodLock=await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1 AND payment_request_id IS NULL",[workerEmployee.id]);
      // End-to-end worker payment reversal must restore the production allocation,
      // available balance, original expense and current custody without deleting originals.
      const reversalAllocationWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Worker Reversal Allocation "+randomBytes(4).toString("hex")]
      )).rows[0];
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',5000,'worker reversal test cash top-up',$2)",
        [managerEmployee.id,manager.id]
      );
      const reversalAdvance=(await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,requested_by,status,paid_by,paid_at,repayment_status)
         VALUES($1,20,'worker payment reversal integration advance',$2,'PAID',$2,now(),'OPEN') RETURNING id`,
        [reversalAllocationWorker.id,manager.id]
      )).rows[0].id;
      const reversalProduction=(await apiPool.query(
        `INSERT INTO production_entries(
           employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
           wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
           status,submitted_by,approved_by,approved_at
         )
         VALUES($1,$2,$3,$4,CURRENT_DATE,1,$5,$6,100,$7,'PER_PIECE','PER_PIECE',100,0,0,'APPROVED',$8,$8,now())
         RETURNING id,total_earning_amount`,
        [reversalAllocationWorker.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
         bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
      )).rows[0];
      assert.equal(Number(reversalProduction.total_earning_amount),100);
      const reversalPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:reversalAllocationWorker.id,cashCustodyEmployeeId:managerEmployee.id,amount:100,advanceRepaymentAmount:20,method:"CASH",idempotencyKey:randomUUID()}
      });
      assert.equal(reversalPayout.statusCode,201,reversalPayout.body);
      const reversalPaymentId=reversalPayout.json().data.payment.id;
      const reversalSettlement=(await apiPool.query(
        "SELECT id FROM employee_earnings_settlements WHERE worker_payment_id=$1",
        [reversalPaymentId]
      )).rows[0];
      assert.ok(reversalSettlement,"worker payment must retain its linked settlement");
      const originalAllocation=(await apiPool.query(
        "SELECT id,amount FROM employee_earnings_settlement_allocations WHERE settlement_id=$1",
        [reversalSettlement.id]
      )).rows[0];
      assert.ok(originalAllocation,"worker payment must allocate the production entry");
      await apiPool.query(
        "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,100) ON CONFLICT(worker_payment_id,production_entry_id) DO NOTHING",
        [reversalPaymentId,reversalProduction.id]
      );
      const reversalCustodyOut=(await apiPool.query(
        "SELECT id,transaction_date::text AS transaction_date FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1 AND direction='OUT'",
        [reversalPaymentId]
      )).rows[0];
      assert.ok(reversalCustodyOut,"current-custody worker payment must retain its original cash OUT");
      const linkedExpense=(await apiPool.query(
        "SELECT id,cash_custody_transaction_id FROM accounting_expenses WHERE source_worker_payment_id=$1 AND cash_custody_transaction_id IS NOT NULL",
        [reversalPaymentId]
      )).rows[0];
      assert.ok(linkedExpense,"the worker-payment expense must point to the exact cash custody movement");
      await apiPool.query("UPDATE accounting_expenses SET cash_custody_transaction_id=NULL WHERE id=$1",[linkedExpense.id]);
      const brokenCustodyLinkReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:reversalPaymentId,amount:100,
          reason:"اختبار منع العكس عند فقد رابط العهدة بالمصروف",idempotencyKey:randomUUID()}
      });
      assert.equal(brokenCustodyLinkReversal.statusCode,409,brokenCustodyLinkReversal.body);
      assert.equal(brokenCustodyLinkReversal.json().error.code,"WORKER_PAYMENT_CUSTODY_MISMATCH");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM financial_reversals r JOIN financial_reversal_lines l ON l.reversal_id=r.id WHERE l.source_type='WORKER_PAYMENT' AND l.source_id=$1",
        [reversalPaymentId]
      )).rows[0].count),0,"a broken custody-to-expense link must abort without a partial reversal");
      await apiPool.query("UPDATE accounting_expenses SET cash_custody_transaction_id=$1 WHERE id=$2",
        [reversalCustodyOut.id,linkedExpense.id]);
      await apiPool.query("UPDATE cash_custody_transactions SET transaction_date=transaction_date-1 WHERE id=$1",
        [reversalCustodyOut.id]);
      const brokenCustodyDateReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:reversalPaymentId,amount:100,
          reason:"اختبار منع العكس عند اختلاف تاريخ حركة العهدة",idempotencyKey:randomUUID()}
      });
      assert.equal(brokenCustodyDateReversal.statusCode,409,brokenCustodyDateReversal.body);
      assert.equal(brokenCustodyDateReversal.json().error.code,"WORKER_PAYMENT_CUSTODY_MISMATCH");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM financial_reversals r JOIN financial_reversal_lines l ON l.reversal_id=r.id WHERE l.source_type='WORKER_PAYMENT' AND l.source_id=$1",
        [reversalPaymentId]
      )).rows[0].count),0,"a custody date mismatch must abort without a partial reversal");
      await apiPool.query("UPDATE cash_custody_transactions SET transaction_date=$1::date WHERE id=$2",
        [reversalCustodyOut.transaction_date,reversalCustodyOut.id]);
      const repaymentLink=(await apiPool.query(
        "SELECT id FROM advance_repayments WHERE source_worker_payment_id=$1",[reversalPaymentId]
      )).rows[0];
      assert.ok(repaymentLink,"the payment must retain its linked advance repayment");
      const unrelatedAdvanceOwner=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Unrelated Advance Owner "+randomBytes(4).toString("hex")]
      )).rows[0].id;
      await apiPool.query("UPDATE advance_requests SET employee_id=$1 WHERE id=$2",[unrelatedAdvanceOwner,reversalAdvance]);
      await apiPool.query("UPDATE employee_earnings_ledger SET employee_id=$1 WHERE advance_repayment_id=$2",
        [unrelatedAdvanceOwner,repaymentLink.id]);
      const unsafeOwnerReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:reversalPaymentId,amount:100,
          reason:"اختبار منع عكس سلفة تخص عاملًا آخر",idempotencyKey:randomUUID()}
      });
      assert.equal(unsafeOwnerReversal.statusCode,409,unsafeOwnerReversal.body);
      assert.equal(unsafeOwnerReversal.json().error.code,"WORKER_PAYMENT_ADVANCE_OWNER_MISMATCH");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM financial_reversals r JOIN financial_reversal_lines l ON l.reversal_id=r.id WHERE l.source_type='WORKER_PAYMENT' AND l.source_id=$1",
        [reversalPaymentId]
      )).rows[0].count),0,"mismatched advance ownership must abort the entire reversal");
      await apiPool.query("UPDATE advance_requests SET employee_id=$1 WHERE id=$2",[reversalAllocationWorker.id,reversalAdvance]);
      await apiPool.query("UPDATE employee_earnings_ledger SET employee_id=$1 WHERE advance_repayment_id=$2",
        [reversalAllocationWorker.id,repaymentLink.id]);
      const reversalResponse=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:reversalPaymentId,amount:100,reason:"عكس دفعة عامل مع توزيع إنتاج",idempotencyKey:randomUUID()}
      });
      assert.equal(reversalResponse.statusCode,201,reversalResponse.body);
      const reversalEffects=await apiPool.query(
        `SELECT
          (SELECT COUNT(*)::int FROM worker_payment_allocation_reversals WHERE reversal_id=$1) AS allocation_count,
          (SELECT COALESCE(SUM(amount),0) FROM worker_payment_allocation_reversals WHERE reversal_id=$1) AS allocation_amount,
          (SELECT COALESCE(SUM(amount),0) FROM accounting_expense_reversals WHERE reversal_id=$1) AS expense_amount,
          (SELECT COALESCE(SUM(amount),0) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$1 AND direction='IN') AS custody_in,
          (SELECT MIN(employee_id::text) FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$1 AND direction='IN') AS reversal_custody_holder,
          (SELECT MIN(employee_id::text) FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$3 AND direction='OUT') AS original_custody_holder,
          (SELECT COUNT(*)::int FROM employee_earnings_settlement_allocations WHERE id=$2) AS original_allocation_count,
          (SELECT repayment_status FROM advance_requests WHERE id=$4) AS advance_status,
          (SELECT COUNT(*)::int FROM financial_reversal_lines WHERE reversal_id=$1 AND source_type='ADVANCE_REPAYMENT') AS advance_reversal_lines`,
        [reversalResponse.json().data.reversal.id,originalAllocation.id,reversalPaymentId,reversalAdvance]
      );
      assert.equal(Number(reversalEffects.rows[0].allocation_count),1);
      assert.equal(Number(reversalEffects.rows[0].allocation_amount),100);
      assert.equal(Number(reversalEffects.rows[0].expense_amount),100);
      assert.equal(Number(reversalEffects.rows[0].custody_in),80);
      assert.equal(reversalEffects.rows[0].reversal_custody_holder,reversalEffects.rows[0].original_custody_holder,
        "cash must return to the exact custodian who funded the original worker payment");
      assert.equal(reversalEffects.rows[0].reversal_custody_holder,managerEmployee.id);
      assert.equal(Number(reversalEffects.rows[0].original_allocation_count),1,
        "original production allocation must remain immutable after reversal");
      assert.equal(reversalEffects.rows[0].advance_status,"OPEN",
        "reversing a worker payout must restore the advance outstanding status");
      assert.equal(Number(reversalEffects.rows[0].advance_reversal_lines),1,
        "the linked advance repayment must be reversed in the same financial transaction");
      const productionAfterReversal=await app.inject({
        method:"GET",url:`/api/production?employeeId=${reversalAllocationWorker.id}&status=APPROVED&limit=100`,
        headers:{cookie:managerCookie}
      });
      assert.equal(productionAfterReversal.statusCode,200,productionAfterReversal.body);
      const reversedProductionRow=productionAfterReversal.json().data.find((row:any)=>row.id===reversalProduction.id);
      assert.ok(reversedProductionRow,"production row must remain visible after payout reversal");
      assert.equal(Number(reversedProductionRow.paid_amount),0);
      assert.equal(Number(reversedProductionRow.remaining_amount),100);
      assert.equal(reversedProductionRow.payment_status,"UNPAID");
      const balanceAfterReversal=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${reversalAllocationWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(balanceAfterReversal.statusCode,200,balanceAfterReversal.body);
      assert.equal(Number(balanceAfterReversal.json().data.availableForSettlement),100,
        "reversing the payout must restore the worker's payable production balance");
      const reversalIntegrity=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(reversalIntegrity.statusCode,200,reversalIntegrity.body);
      assert.equal(reversalIntegrity.json().data.counts.workerPaymentReversalMismatches,0,
        "the read-only reconciliation report must confirm the reversal's ledger, custody, expense and allocation effects");


      // Worker settlement differences: preserve the original payment, allocate later
      // approved production, mature the remainder, and reverse every derived effect.
      const differenceWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Worker Difference "+randomBytes(4).toString("hex")]
      )).rows[0];
      const differenceOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{orderName:"Worker difference source "+randomBytes(4).toString("hex"),
          stages:[{stageName:"Difference stage",sequenceNo:1,outputProductName:"Difference output "+randomBytes(4).toString("hex"),
            plannedQuantity:20,stageRate:10,stageRateMethod:"PER_PIECE",isFinalProduct:true}]}
      });
      assert.equal(differenceOrder.statusCode,201,differenceOrder.body);
      const differenceOrderId=differenceOrder.json().data.id as string;
      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[differenceOrderId]);
      const differenceStage=(await apiPool.query(
        "SELECT os.id,os.stage_id,os.output_product_id,p.unit_id FROM order_stages os JOIN products p ON p.id=os.output_product_id WHERE os.order_id=$1",
        [differenceOrderId]
      )).rows[0];
      assert.ok(differenceStage,"source order must have a production stage");
      async function insertDifferenceProduction(quantity:number,earning:number,employeeId:string=differenceWorker.id){
        return (await apiPool.query(
          `INSERT INTO production_entries(
             employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
             wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
             status,submitted_by,approved_by,approved_at,order_stage_id
           ) VALUES($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,10,$8,'PER_PIECE','PER_PIECE',$9,0,0,
             'APPROVED',$10,$10,now(),$11)
           RETURNING id,total_earning_amount`,
          [employeeId,differenceStage.output_product_id,differenceStage.stage_id,bonusShift.id,
           quantity,differenceStage.unit_id,bonusRate.id,perPieceWageType.id,earning,manager.id,differenceStage.id]
        )).rows[0];
      }
      async function readDifferenceOrderDashboard(){
        const response=await app.inject({
          method:"GET",url:"/api/accounting/orders-dashboard",headers:{cookie:managerCookie}
        });
        assert.equal(response.statusCode,200,response.body);
        const row=response.json().data.find((item:any)=>item.id===differenceOrderId);
        assert.ok(row,"the worker settlement order must appear in the profitability dashboard");
        return row;
      }
      const sourceProduction=await insertDifferenceProduction(10,100);
      assert.equal(Number(sourceProduction.total_earning_amount),100);
      const differencePaymentResponse=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:differenceWorker.id,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:differenceOrderId,orderStageId:differenceStage.id,amount:150,method:"CASH",
          advanceRepaymentAmount:0,allowOverpayment:true,idempotencyKey:randomUUID()}
      });
      assert.equal(differencePaymentResponse.statusCode,201,differencePaymentResponse.body);
      const differencePaymentId=differencePaymentResponse.json().data.payment.id as string;
      const differenceRecord=(await apiPool.query(
        "SELECT id,original_amount,status FROM worker_payment_settlement_differences WHERE worker_payment_id=$1",
        [differencePaymentId]
      )).rows[0];
      assert.ok(differenceRecord,"the general remainder must be registered as a settlement difference");
      assert.equal(Number(differenceRecord.original_amount),50);
      assert.equal(differenceRecord.status,"PENDING");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM worker_payment_order_allocations WHERE worker_payment_id=$1",
        [differencePaymentId]
      )).rows[0].amount),100,"the source production portion must remain allocated to its original order");

      await apiPool.query("UPDATE production_orders SET status='CANCELLED' WHERE id=$1",[differenceOrderId]);
      const cancelledTargetProduction=await insertDifferenceProduction(1,10);
      const cancelledTargetClient=await apiPool.connect();
      try{
        await cancelledTargetClient.query("BEGIN");
        assert.deepEqual(await allocatePendingWorkerPaymentDifferencesForProduction(
          cancelledTargetClient,differenceWorker.id,cancelledTargetProduction.id,manager.id
        ),[],"cancelled orders must never receive worker settlement difference allocations");
        await cancelledTargetClient.query("COMMIT");
      }catch(error){await cancelledTargetClient.query("ROLLBACK");throw error}
      finally{cancelledTargetClient.release()}
      await apiPool.query("UPDATE production_entries SET status='CANCELLED' WHERE id=$1",[cancelledTargetProduction.id]);
      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[differenceOrderId]);

      const initialProfitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${differenceOrderId}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(initialProfitability.statusCode,200,initialProfitability.body);
      assert.equal(Number(initialProfitability.json().data.laborCost),100);
      assert.equal(Number(initialProfitability.json().data.expenses),0,
        "worker-payment cash expense must not be counted again on top of production labor cost");
      assert.equal(Number(initialProfitability.json().data.totalCost),100);
      const initialDashboardOrder=await readDifferenceOrderDashboard();
      assert.equal(Number(initialDashboardOrder.labor_cost),100);
      assert.equal(Number(initialDashboardOrder.direct_expenses),0);
      assert.equal(Number(initialDashboardOrder.total_cost),100);

      const laterProduction=await insertDifferenceProduction(2,20);
      const differenceClient=await apiPool.connect();
      let laterAllocations:any[]=[];
      try{
        await differenceClient.query("BEGIN");
        laterAllocations=await allocatePendingWorkerPaymentDifferencesForProduction(
          differenceClient,differenceWorker.id,laterProduction.id,manager.id
        );
        await differenceClient.query("COMMIT");
      }catch(error){await differenceClient.query("ROLLBACK");throw error}
      finally{differenceClient.release()}
      assert.equal(laterAllocations.length,1);
      assert.equal(Number(laterAllocations[0].amount),20);
      const settledAfterDifferenceAllocation=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${differenceWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(settledAfterDifferenceAllocation.statusCode,200,settledAfterDifferenceAllocation.body);
      assert.equal(Number(settledAfterDifferenceAllocation.json().data.availableForSettlement),0,
        "an active difference allocation must count as settled even when its original payment has canonical settlement allocations");
      const productionReport=await app.inject({
        method:"GET",url:`/api/reports/production?employeeId=${differenceWorker.id}&orderId=${differenceOrderId}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(productionReport.statusCode,200,productionReport.body);
      const reportedLaterProduction=productionReport.json().data.find((row:any)=>row.id===laterProduction.id);
      assert.ok(reportedLaterProduction,"the later production must appear in the production report");
      assert.equal(Number(reportedLaterProduction.paid_amount),20,
        "production reports must include active difference allocations backed by canonical worker settlements");
      assert.equal(Number(reportedLaterProduction.remaining_amount),0);
      assert.equal(reportedLaterProduction.payment_status,"PAID");
      const orderDashboardAfterDifference=await app.inject({
        method:"GET",url:`/api/orders/${differenceOrderId}/dashboard`,headers:{cookie:managerCookie}
      });
      assert.equal(orderDashboardAfterDifference.statusCode,200,orderDashboardAfterDifference.body);
      const orderProductionAfterDifference=orderDashboardAfterDifference.json().data.production.find((row:any)=>row.id===laterProduction.id);
      assert.ok(orderProductionAfterDifference,"the later production must appear in the order dashboard");
      assert.equal(Number(orderProductionAfterDifference.paid_amount),20,
        "order dashboards must include the same active difference allocation as the settlement summary");
      assert.equal(Number(orderProductionAfterDifference.remaining_amount),0);
      const productionListAfterDifference=await app.inject({
        method:"GET",url:`/api/production?employeeId=${differenceWorker.id}&orderId=${differenceOrderId}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(productionListAfterDifference.statusCode,200,productionListAfterDifference.body);
      const listedLaterProduction=productionListAfterDifference.json().data.find((row:any)=>row.id===laterProduction.id);
      assert.ok(listedLaterProduction);
      assert.equal(Number(listedLaterProduction.paid_amount),20);
      assert.equal(Number(listedLaterProduction.remaining_amount),0);
      assert.equal(listedLaterProduction.payment_status,"PAID");
      const workerOrderSummary=await app.inject({
        method:"GET",url:`/api/production/earnings/order-summary?orderId=${differenceOrderId}&employeeId=${differenceWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(workerOrderSummary.statusCode,200,workerOrderSummary.body);
      const workerOrderSummaryRow=workerOrderSummary.json().data.find((row:any)=>row.order_id===differenceOrderId);
      assert.ok(workerOrderSummaryRow,"the source order must appear in the worker order summary");
      assert.equal(Number(workerOrderSummaryRow.total_earned),120);
      assert.equal(Number(workerOrderSummaryRow.paid_amount),120,
        "tracked difference allocations must count as production-paid without reclassifying the remaining difference as a production payment");
      assert.equal(Number(workerOrderSummaryRow.remaining_amount),0);
      const partialDifference=(await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[differenceRecord.id]
      )).rows[0];
      assert.equal(partialDifference.status,"PARTIALLY_ALLOCATED");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='ALLOCATED_TO_PRODUCTION'",
        [differenceRecord.id]
      )).rows[0].amount),20);
      const partialProfitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${differenceOrderId}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(partialProfitability.statusCode,200,partialProfitability.body);
      assert.equal(Number(partialProfitability.json().data.laborCost),120);
      assert.equal(Number(partialProfitability.json().data.expenses),0,
        "an allocation to later approved production is already included in labor cost");
      assert.equal(Number(partialProfitability.json().data.totalCost),120);
      const partialDashboardOrder=await readDifferenceOrderDashboard();
      assert.equal(Number(partialDashboardOrder.labor_cost),120);
      assert.equal(Number(partialDashboardOrder.direct_expenses),0);
      assert.equal(Number(partialDashboardOrder.total_cost),120);
      const immutableDifferenceEvent=(await apiPool.query(
        "SELECT id FROM worker_payment_settlement_difference_events WHERE difference_id=$1 ORDER BY created_at,id LIMIT 1",
        [differenceRecord.id]
      )).rows[0];
      await assert.rejects(
        apiPool.query("UPDATE worker_payment_settlement_difference_events SET reason='tampered' WHERE id=$1",[immutableDifferenceEvent.id]),
        /append-only/
      );
      await assert.rejects(
        apiPool.query("DELETE FROM worker_payment_settlement_difference_events WHERE id=$1",[immutableDifferenceEvent.id]),
        /append-only/
      );
      await assert.rejects(
        apiPool.query("TRUNCATE worker_payment_settlement_difference_events"),
        /append-only/
      );

      // Simulate elapsed time in the isolated disposable DB; no wall-clock sleep.
      await apiPool.query(
        "UPDATE worker_payments SET created_at=now()-INTERVAL '70 days' WHERE id=$1",[differencePaymentId]
      );
      await apiPool.query(
        "UPDATE production_entries SET approved_at=now()-INTERVAL '40 days',work_date=CURRENT_DATE-40 WHERE id=$1",
        [laterProduction.id]
      );
      await apiPool.query(
        "UPDATE production_entries SET approved_at=now()-INTERVAL '75 days',work_date=CURRENT_DATE-75 WHERE id=$1",
        [sourceProduction.id]
      );
      await apiPool.query(
        "UPDATE worker_payment_settlement_differences SET eligible_at=CURRENT_DATE-40 WHERE id=$1",[differenceRecord.id]
      );
      const maturityDiagnostic=await apiPool.query(
        `SELECT d.status,wp.created_at,
          (SELECT MAX(p.approved_at) FROM production_entries p WHERE p.employee_id=d.employee_id
            AND p.status='APPROVED' AND p.approved_at>wp.created_at AND p.work_date>=wp.created_at::date) AS last_activity,
          COALESCE((SELECT MAX(p.approved_at) FROM production_entries p WHERE p.employee_id=d.employee_id
            AND p.status='APPROVED' AND p.approved_at>wp.created_at AND p.work_date>=wp.created_at::date),wp.created_at)+INTERVAL '30 days'<=now() AS mature,
          NOT EXISTS(SELECT 1 FROM production_entries p WHERE p.employee_id=d.employee_id
            AND p.status='PENDING' AND p.work_date>=wp.created_at::date) AS no_pending,
          NOT EXISTS(SELECT 1 FROM financial_reversal_lines fr WHERE fr.source_type='WORKER_PAYMENT' AND fr.source_id=wp.id) AS no_reversal
         FROM worker_payment_settlement_differences d JOIN worker_payments wp ON wp.id=d.worker_payment_id WHERE d.id=$1`,
        [differenceRecord.id]
      );
      assert.equal(maturityDiagnostic.rows[0].mature,true,JSON.stringify(maturityDiagnostic.rows[0]));
      assert.equal(maturityDiagnostic.rows[0].no_pending,true,JSON.stringify(maturityDiagnostic.rows[0]));
      assert.equal(maturityDiagnostic.rows[0].no_reversal,true,JSON.stringify(maturityDiagnostic.rows[0]));
      const pendingDifferenceProduction=await insertDifferenceProduction(1,10);
      await apiPool.query(
        "UPDATE production_entries SET status='PENDING',approved_by=NULL,approved_at=NULL,work_date=CURRENT_DATE-40 WHERE id=$1",
        [pendingDifferenceProduction.id]
      );
      const pendingMaturityClient=await apiPool.connect();
      try{
        await pendingMaturityClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          pendingMaturityClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"maturity must wait while the worker has unresolved production awaiting approval");
        await pendingMaturityClient.query("COMMIT");
      }catch(error){await pendingMaturityClient.query("ROLLBACK");throw error}
      finally{pendingMaturityClient.release()}
      await apiPool.query("UPDATE production_entries SET status='CANCELLED' WHERE id=$1",[pendingDifferenceProduction.id]);
      const employeeLockClient=await apiPool.connect();
      const blockedMaturityClient=await apiPool.connect();
      try{
        await employeeLockClient.query("BEGIN");
        await employeeLockClient.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[differenceWorker.id]);
        await blockedMaturityClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          blockedMaturityClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"maturity processing must serialize with worker production approval through the employee lock");
        await blockedMaturityClient.query("COMMIT");
        await employeeLockClient.query("ROLLBACK");
      }catch(error){
        await blockedMaturityClient.query("ROLLBACK").catch(()=>{});
        await employeeLockClient.query("ROLLBACK").catch(()=>{});
        throw error;
      }finally{
        blockedMaturityClient.release();
        employeeLockClient.release();
      }
      const independentAllocationEvent=(await apiPool.query(
        "SELECT id,worker_payment_order_allocation_id,amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='ALLOCATED_TO_PRODUCTION' AND production_entry_id=$2",
        [differenceRecord.id,laterProduction.id]
      )).rows[0];
      assert.ok(independentAllocationEvent,"the later production allocation must have an immutable event");
      const partialIndependentAllocationReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentAllocationEvent.id,
          amount:Number(independentAllocationEvent.amount)/2,reason:"محاولة عكس نصف حدث فرق التسوية",
          idempotencyKey:randomUUID()}
      });
      assert.equal(partialIndependentAllocationReversal.statusCode,409,partialIndependentAllocationReversal.body,
        "an independent difference allocation must reject partial reversal");
      assert.equal(partialIndependentAllocationReversal.json().error.code,
        "WORKER_DIFFERENCE_FULL_EVENT_REVERSAL_REQUIRED");
      const independentAllocationReversalKey=randomUUID();
      const independentAllocationReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentAllocationEvent.id,
          amount:Number(independentAllocationEvent.amount),reason:"اختبار عكس توزيع فرق التسوية منفردًا",
          idempotencyKey:independentAllocationReversalKey}
      });
      assert.equal(independentAllocationReversal.statusCode,201,independentAllocationReversal.body);
      const replayedIndependentAllocationReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentAllocationEvent.id,
          amount:Number(independentAllocationEvent.amount),reason:"اختبار عكس توزيع فرق التسوية منفردًا",
          idempotencyKey:independentAllocationReversalKey}
      });
      assert.equal(replayedIndependentAllocationReversal.statusCode,200,replayedIndependentAllocationReversal.body,
        "retrying an identical difference-event reversal must return the original journal result");
      assert.equal(replayedIndependentAllocationReversal.json().data.reversal.id,
        independentAllocationReversal.json().data.reversal.id,
        "an idempotent retry must return the same financial reversal header");
      const reusedDifferenceReversalKey=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentAllocationEvent.id,
          amount:Number(independentAllocationEvent.amount)+1,reason:"محاولة إعادة استخدام المفتاح لمبلغ مختلف",
          idempotencyKey:independentAllocationReversalKey}
      });
      assert.equal(reusedDifferenceReversalKey.statusCode,409,reusedDifferenceReversalKey.body,
        "reusing a difference-event reversal key with a different financial request must be rejected");
      assert.equal(reusedDifferenceReversalKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM financial_reversals WHERE idempotency_key=$1",
        [independentAllocationReversalKey]
      )).rows[0].count),1,"an idempotency retry must never create a second reversal header");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM financial_reversal_lines WHERE source_type='WORKER_SETTLEMENT_DIFFERENCE_EVENT' AND source_id=$1",
        [independentAllocationEvent.id]
      )).rows[0].count),1,"an idempotency retry must never duplicate the financial reversal line");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payment_settlement_difference_events WHERE reverses_event_id=$1 AND event_type='REVERSED'",
        [independentAllocationEvent.id]
      )).rows[0].count),1,"an idempotency retry must never append a second reversal event");
      const secondIndependentAllocationReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentAllocationEvent.id,
          amount:Number(independentAllocationEvent.amount),reason:"محاولة عكس الحدث نفسه بمفتاح جديد",
          idempotencyKey:randomUUID()}
      });
      assert.equal(secondIndependentAllocationReversal.statusCode,409,secondIndependentAllocationReversal.body,
        "a previously reversed event must not be reversed again with a fresh idempotency key");
      assert.equal(secondIndependentAllocationReversal.json().error.code,"WORKER_DIFFERENCE_REQUIRES_REVIEW");
      const independentReversalIntegrity=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(independentReversalIntegrity.statusCode,200,independentReversalIntegrity.body);
      assert.equal(independentReversalIntegrity.json().data.counts.workerDifferenceEventReversalMismatches,0,
        "an independent difference-event reversal must reconcile to its immutable event and financial journal line");
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[differenceRecord.id]
      )).rows[0].status,"REQUIRES_REVIEW","an independently reversed allocation must be held for accounting review");
       const reviewDifferenceReport=await app.inject({
         method:"GET",url:`/api/reports/production?employeeId=${differenceWorker.id}&orderId=${differenceOrderId}&paymentStatus=UNALLOCATED`,
         headers:{cookie:managerCookie}
       });
       assert.equal(reviewDifferenceReport.statusCode,200,reviewDifferenceReport.body);
       assert.ok(reviewDifferenceReport.json().data.some((row:any)=>row.id===sourceProduction.id),
         "production reporting must keep a worker's source order visible as unallocated while its reversed difference awaits accounting review");

      // After reversing the later-production allocation, every financial view
      // must restore exactly that production's unpaid balance without creating
      // a duplicate direct expense or changing the approved labor cost.
      const reversedDifferenceProductionReport=await app.inject({
        method:"GET",url:`/api/reports/production?employeeId=${differenceWorker.id}&orderId=${differenceOrderId}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(reversedDifferenceProductionReport.statusCode,200,reversedDifferenceProductionReport.body);
      const reversedDifferenceProductionRow=reversedDifferenceProductionReport.json().data.find((row:any)=>row.id===laterProduction.id);
      assert.ok(reversedDifferenceProductionRow,"reversed allocation production must remain in production report");
      assert.equal(Number(reversedDifferenceProductionRow.paid_amount),0,
        "production report must remove the independently reversed difference allocation");
      assert.equal(Number(reversedDifferenceProductionRow.remaining_amount),20,
        "production report must restore the full unpaid amount after independent reversal");
      assert.equal(reversedDifferenceProductionRow.payment_status,"UNALLOCATED",
         "the source-order difference remains unallocated while held for accounting review, even though this production allocation was reversed");
      const reversedDifferenceOrderDashboard=await app.inject({
        method:"GET",url:`/api/orders/${differenceOrderId}/dashboard`,headers:{cookie:managerCookie}
      });
      assert.equal(reversedDifferenceOrderDashboard.statusCode,200,reversedDifferenceOrderDashboard.body);
      const reversedDifferenceOrderRow=reversedDifferenceOrderDashboard.json().data.production.find((row:any)=>row.id===laterProduction.id);
      assert.ok(reversedDifferenceOrderRow,"order dashboard must retain the reversed production row");
      assert.equal(Number(reversedDifferenceOrderRow.paid_amount),0);
      assert.equal(Number(reversedDifferenceOrderRow.remaining_amount),20);
      const reversedDifferenceProfitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${differenceOrderId}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(reversedDifferenceProfitability.statusCode,200,reversedDifferenceProfitability.body);
      assert.equal(Number(reversedDifferenceProfitability.json().data.laborCost),120,
        "reversal changes settlement state, not the approved worker labor expense");
      assert.equal(Number(reversedDifferenceProfitability.json().data.expenses),0,
        "reversing an allocation must not recreate the original worker-payment expense as a second direct cost");
      assert.equal(Number(reversedDifferenceProfitability.json().data.totalCost),120,
        "order total cost must remain equal to approved labor after allocation reversal");
      const reversedDifferenceDashboard=await readDifferenceOrderDashboard();
      assert.equal(Number(reversedDifferenceDashboard.labor_cost),120);
      assert.equal(Number(reversedDifferenceDashboard.direct_expenses),0);
      assert.equal(Number(reversedDifferenceDashboard.total_cost),120);
      const heldMaturityClient=await apiPool.connect();
      try{
        await heldMaturityClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          heldMaturityClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"a difference under accounting review must be excluded from automatic maturity");
        await heldMaturityClient.query("COMMIT");
      }catch(error){await heldMaturityClient.query("ROLLBACK");throw error}
      finally{heldMaturityClient.release()}
      const releaseDifference=await app.inject({
        method:"POST",url:`/api/accounting/worker-settlement-differences/${differenceRecord.id}/release`,
        headers:{cookie:managerCookie},
        payload:{reason:"تمت مراجعة عكس التوزيع واعتماد إعادة المعالجة",idempotencyKey:randomUUID()}
      });
      assert.equal(releaseDifference.statusCode,201,releaseDifference.body);
      assert.equal(releaseDifference.json().data.status,"PENDING");
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[differenceRecord.id]
      )).rows[0].status,"PENDING");
      const repeatedRelease=await app.inject({
        method:"POST",url:`/api/accounting/worker-settlement-differences/${differenceRecord.id}/release`,
        headers:{cookie:managerCookie},
        payload:{reason:"تمت مراجعة عكس التوزيع واعتماد إعادة المعالجة",idempotencyKey:releaseDifference.json().data.event.idempotency_key}
      });
      assert.equal(repeatedRelease.statusCode,200,repeatedRelease.body,
        "replaying the same release request and idempotency key must return the original release event");
      const reusedReleaseKeyWithDifferentReason=await app.inject({
        method:"POST",url:`/api/accounting/worker-settlement-differences/${differenceRecord.id}/release`,
        headers:{cookie:managerCookie},
        payload:{reason:"سبب مختلف بنفس المفتاح",idempotencyKey:releaseDifference.json().data.event.idempotency_key}
      });
      assert.equal(reusedReleaseKeyWithDifferentReason.statusCode,409,reusedReleaseKeyWithDifferentReason.body,
        "reusing a release idempotency key with a different reason must be rejected");
      assert.equal(reusedReleaseKeyWithDifferentReason.json().error.code,"IDEMPOTENCY_KEY_REUSED");
      // A reversed allocation is immutable: retrying the same difference against
      // the same production row must not create a second allocation or event.
      // The production remains payable through a new, separately verified payout.
      const repeatedDifferenceAllocationClient=await apiPool.connect();
      try{
        await repeatedDifferenceAllocationClient.query("BEGIN");
        const repeatedDifferenceAllocations=await allocatePendingWorkerPaymentDifferencesForProduction(
          repeatedDifferenceAllocationClient,differenceWorker.id,laterProduction.id,manager.id
        );
        assert.equal(repeatedDifferenceAllocations.length,0,
          "a reversed historical allocation must not be recreated against the same production row");
        await repeatedDifferenceAllocationClient.query("COMMIT");
      }catch(error){
        await repeatedDifferenceAllocationClient.query("ROLLBACK");
        throw error;
      }finally{
        repeatedDifferenceAllocationClient.release();
      }
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND production_entry_id=$2 AND event_type='ALLOCATED_TO_PRODUCTION'",
        [differenceRecord.id,laterProduction.id]
      )).rows[0].count),1,"retrying the same production must preserve one immutable original allocation event");

      const unpaidAfterReviewClient=await apiPool.connect();
      try{
        await unpaidAfterReviewClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          unpaidAfterReviewClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"maturity must not move the remainder to the source order while the reversed allocation has reopened unpaid approved production");
        await unpaidAfterReviewClient.query("COMMIT");
      }catch(error){await unpaidAfterReviewClient.query("ROLLBACK");throw error}
      finally{unpaidAfterReviewClient.release()}
      const reopenedSettlementSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${differenceWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(reopenedSettlementSummary.statusCode,200,reopenedSettlementSummary.body);
      assert.equal(Number(reopenedSettlementSummary.json().data.availableForSettlement),20,
        "an independently reversed allocation must restore only the genuinely unpaid production amount, not subtract the old unmatched difference twice");

      const replacementProductionPayment=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:differenceWorker.id,settlementSource:"CURRENT_CUSTODY",
          cashCustodyEmployeeId:managerEmployee.id,settlementMode:"SELECTED_PRODUCTION",
          productionEntryIds:[laterProduction.id],amount:20,method:"CASH",advanceRepaymentAmount:0,
          idempotencyKey:randomUUID()}
      });
      assert.equal(replacementProductionPayment.statusCode,201,replacementProductionPayment.body,
        "the reopened later production must be settled by a separate verified payment before its unmatched remainder can mature");

      // Approved work attached to a cancelled stage is no longer eligible for
      // allocation and must not keep an otherwise mature difference pending.
      const cancelledStageBlocker=await insertDifferenceProduction(1,10);
      assert.ok(cancelledStageBlocker.id);
      const originalStageStatus=(await apiPool.query(
        "SELECT status FROM order_stages WHERE id=$1",[differenceStage.id]
      )).rows[0].status;
      await apiPool.query("UPDATE order_stages SET status='CANCELLED' WHERE id=$1",[differenceStage.id]);

      const matureClient=await apiPool.connect();
      let transferredCount=0;
      try{
        await matureClient.query("BEGIN");
        transferredCount=await processMaturedWorkerPaymentDifferences(
          matureClient,{actorUserId:manager.id,actorType:"USER"}
        );
        await matureClient.query("COMMIT");
      }catch(error){await matureClient.query("ROLLBACK");throw error}
      finally{matureClient.release()}
      await apiPool.query("UPDATE order_stages SET status=$2 WHERE id=$1",[differenceStage.id,originalStageStatus]);
      await apiPool.query("UPDATE production_entries SET status='CANCELLED' WHERE id=$1",[cancelledStageBlocker.id]);
      assert.equal(transferredCount,1,
        "approved production in a cancelled stage must not reset inactivity or block maturity");
      const maturedDifference=(await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[differenceRecord.id]
      )).rows[0];
      assert.equal(maturedDifference.status,"TRANSFERRED_TO_SOURCE_ORDER");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='TRANSFERRED_TO_SOURCE_ORDER' AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=worker_payment_settlement_difference_events.id)",
        [differenceRecord.id]
      )).rows[0].amount),50);
      const maturedProfitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${differenceOrderId}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(maturedProfitability.statusCode,200,maturedProfitability.body);
      assert.equal(Number(maturedProfitability.json().data.laborCost),120);
      assert.equal(Number(maturedProfitability.json().data.expenses),50,
        "reversing the later allocation restores that amount to the unmatched remainder before maturity");
      assert.equal(Number(maturedProfitability.json().data.totalCost),170);
      const maturedDashboardOrder=await readDifferenceOrderDashboard();
      assert.equal(Number(maturedDashboardOrder.labor_cost),120);
      assert.equal(Number(maturedDashboardOrder.direct_expenses),50);
      assert.equal(Number(maturedDashboardOrder.total_cost),170);
      const duplicateMaturityClient=await apiPool.connect();
      try{
        await duplicateMaturityClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          duplicateMaturityClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"repeated maturity processing must not transfer the same difference twice");
        await duplicateMaturityClient.query("COMMIT");
      }catch(error){await duplicateMaturityClient.query("ROLLBACK");throw error}
      finally{duplicateMaturityClient.release()}

      // A completed source order may close the remaining difference before the
      // 30-day inactivity threshold, but only after all approved worker production
      // on that order has been settled and no production remains pending.
      const closureProduction=await insertDifferenceProduction(5,50);
      const otherOrderWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Other Order Worker "+randomBytes(4).toString("hex")]
      )).rows[0];
      const otherOrderProduction=await insertDifferenceProduction(1,10,otherOrderWorker.id);
      assert.equal(Number(otherOrderProduction.total_earning_amount),10);
      const closurePaymentResponse=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:differenceWorker.id,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:differenceOrderId,orderStageId:differenceStage.id,amount:60,method:"CASH",
          advanceRepaymentAmount:0,allowOverpayment:true,idempotencyKey:randomUUID()}
      });
      assert.equal(closurePaymentResponse.statusCode,201,closurePaymentResponse.body);
      const closurePaymentId=closurePaymentResponse.json().data.payment.id as string;
      const closureDifference=(await apiPool.query(
        "SELECT id,original_amount,status FROM worker_payment_settlement_differences WHERE worker_payment_id=$1",
        [closurePaymentId]
      )).rows[0];
      assert.ok(closureDifference);
      assert.equal(Number(closureDifference.original_amount),10);
      await apiPool.query("UPDATE production_orders SET status='COMPLETED' WHERE id=$1",[differenceOrderId]);
      const blockedClosureClient=await apiPool.connect();
      try{
        await blockedClosureClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          blockedClosureClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"closing one worker's production must not transfer a difference while another worker still has unpaid production on the order");
        await blockedClosureClient.query("COMMIT");
      }catch(error){await blockedClosureClient.query("ROLLBACK");throw error}
      finally{blockedClosureClient.release()}
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[closureDifference.id]
      )).rows[0].status,"PENDING","the difference must remain pending while any worker's order dues are open");

      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[differenceOrderId]);
      const otherWorkerPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:otherOrderWorker.id,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:differenceOrderId,orderStageId:differenceStage.id,amount:10,method:"CASH",
          advanceRepaymentAmount:0,idempotencyKey:randomUUID()}
      });
      assert.equal(otherWorkerPayout.statusCode,201,otherWorkerPayout.body);
      await apiPool.query("UPDATE production_orders SET status='COMPLETED' WHERE id=$1",[differenceOrderId]);
      const closureClient=await apiPool.connect();
      let closureTransfers=0;
      try{
        await closureClient.query("BEGIN");
        closureTransfers=await processMaturedWorkerPaymentDifferences(
          closureClient,{actorUserId:manager.id,actorType:"USER"}
        );
        await closureClient.query("COMMIT");
      }catch(error){await closureClient.query("ROLLBACK");throw error}
      finally{closureClient.release()}
      assert.equal(closureTransfers,1,"a completed order may transfer its remaining difference only after every worker's production dues are settled");
      const completedOrderDifference=(await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[closureDifference.id]
      )).rows[0];
      assert.equal(completedOrderDifference.status,"TRANSFERRED_TO_SOURCE_ORDER");
      assert.equal(Number((await apiPool.query(
        "SELECT SUM(amount) AS amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='TRANSFERRED_TO_SOURCE_ORDER'",
        [closureDifference.id]
      )).rows[0].amount),10);

      const independentTransferEvent=(await apiPool.query(
        "SELECT id,amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='TRANSFERRED_TO_SOURCE_ORDER'",
        [closureDifference.id]
      )).rows[0];
      const independentTransferReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:independentTransferEvent.id,
          amount:Number(independentTransferEvent.amount),reason:"اختبار عكس ترحيل فرق التسوية منفردًا",
          idempotencyKey:randomUUID()}
      });
      assert.equal(independentTransferReversal.statusCode,201,independentTransferReversal.body);
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[closureDifference.id]
      )).rows[0].status,"REQUIRES_REVIEW");
      const heldTransferClient=await apiPool.connect();
      try{
        await heldTransferClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          heldTransferClient,{actorUserId:manager.id,actorType:"USER"}
        ),0,"a reversed transfer must not be recreated while the difference awaits review");
        await heldTransferClient.query("COMMIT");
      }catch(error){await heldTransferClient.query("ROLLBACK");throw error}
      finally{heldTransferClient.release()}
      const releaseTransferDifference=await app.inject({
        method:"POST",url:`/api/accounting/worker-settlement-differences/${closureDifference.id}/release`,
        headers:{cookie:managerCookie},
        payload:{reason:"اعتماد إعادة ترحيل الفرق بعد المراجعة",idempotencyKey:randomUUID()}
      });
      assert.equal(releaseTransferDifference.statusCode,201,releaseTransferDifference.body);
      const retranferClient=await apiPool.connect();
      try{
        await retranferClient.query("BEGIN");
        assert.equal(await processMaturedWorkerPaymentDifferences(
          retranferClient,{actorUserId:manager.id,actorType:"USER"}
        ),1,"an explicitly released completed-order difference may be transferred again exactly once");
        await retranferClient.query("COMMIT");
      }catch(error){await retranferClient.query("ROLLBACK");throw error}
      finally{retranferClient.release()}
      assert.equal(Number((await apiPool.query(
        `SELECT COALESCE(SUM(ev.amount),0) AS amount FROM worker_payment_settlement_difference_events ev
          WHERE ev.difference_id=$1 AND ev.event_type='TRANSFERRED_TO_SOURCE_ORDER'
            AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)`,
        [closureDifference.id]
      )).rows[0].amount),10,"the re-transferred amount must be active once, while the original transfer remains reversed");

      const differenceReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:differencePaymentId,amount:150,
          reason:"اختبار عكس فرق تسوية العامل",idempotencyKey:randomUUID()}
      });
      assert.equal(differenceReversal.statusCode,201,differenceReversal.body);
      const previousCustodyReversalMovements=await apiPool.query(
        `SELECT
          (SELECT COUNT(*)::int FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1 AND direction='OUT') AS original_out,
          (SELECT COUNT(*)::int FROM cash_custody_transactions WHERE source_type='FINANCIAL_REVERSAL' AND source_id=$2 AND direction='IN') AS reversal_in`,
        [differencePaymentId,differenceReversal.json().data.reversal.id]
      );
      assert.equal(Number(previousCustodyReversalMovements.rows[0].original_out),0,
        "a previous-custody settlement must not invent a current-custody cash OUT");
      assert.equal(Number(previousCustodyReversalMovements.rows[0].reversal_in),0,
        "reversing a previous-custody settlement must not credit the current custody");
      const reversedDifference=(await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[differenceRecord.id]
      )).rows[0];
      assert.equal(reversedDifference.status,"REVERSED");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='REVERSED'",
        [differenceRecord.id]
      )).rows[0].count),2,"both the later production allocation and the maturity transfer must be reversed");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM worker_payment_allocation_reversals WHERE worker_payment_id=$1",
        [differencePaymentId]
      )).rows[0].amount),120,"reversal must offset both the original allocation and the later production allocation");
      const differenceExpenseNet=await apiPool.query(
        `SELECT COALESCE(SUM(GREATEST(e.amount
          -COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)
          -COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
            WHERE ev.source_expense_id=e.id AND ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
              AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0),0)),0) AS net
         FROM accounting_expenses e WHERE e.source_worker_payment_id=$1`,
        [differencePaymentId]
      );
      assert.equal(Number(differenceExpenseNet.rows[0].net),0,"reversing the parent payment must reverse its source expenses and all transferred cost effects");
      const reversedProfitability=await app.inject({
        method:"GET",url:`/api/accounting/orders/${differenceOrderId}/profitability`,
        headers:{cookie:managerCookie}
      });
      assert.equal(reversedProfitability.statusCode,200,reversedProfitability.body);
      assert.equal(Number(reversedProfitability.json().data.laborCost),180,
        "earned labor for the source, later, closure and other-worker production must remain visible");
      assert.equal(Number(reversedProfitability.json().data.expenses),10,
        "the separate closure difference remains charged until its own payment is reversed");
      assert.equal(Number(reversedProfitability.json().data.totalCost),190,
        "reversing one payment must not erase other workers' earned labor or leave duplicate transferred expense");
      const reversedDashboardOrder=await readDifferenceOrderDashboard();
      assert.equal(Number(reversedDashboardOrder.labor_cost),180);
      assert.equal(Number(reversedDashboardOrder.direct_expenses),10);
      assert.equal(Number(reversedDashboardOrder.total_cost),190);
      const differenceEventsApi=await app.inject({
        method:"GET",url:`/api/accounting/worker-settlement-differences/${differenceRecord.id}/events`,
        headers:{cookie:managerCookie}
      });
      assert.equal(differenceEventsApi.statusCode,200,differenceEventsApi.body);
      assert.equal(differenceEventsApi.json().data.length,5,"the audit endpoint must expose the allocation, its reversal, review release, maturity transfer and transfer reversal");
      const closureDifferenceReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:closurePaymentId,amount:60,
          reason:"عكس دفعة فرق طلبية مكتملة",idempotencyKey:randomUUID()}
      });
      assert.equal(closureDifferenceReversal.statusCode,201,closureDifferenceReversal.body);
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[closureDifference.id]
      )).rows[0].status,"REVERSED","reversing the second payment must also reverse its completion-transfer event");
      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[differenceOrderId]);
      const repayoutAfterReversal=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:differenceWorker.id,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:differenceOrderId,orderStageId:differenceStage.id,amount:100,method:"CASH",
          advanceRepaymentAmount:0,idempotencyKey:randomUUID()}
      });
      assert.equal(repayoutAfterReversal.statusCode,201,repayoutAfterReversal.body,
        "a later order-scoped payout must treat reversed historical allocations as available, not as duplicate paid amounts");
      assert.equal(Number((await apiPool.query(
        "SELECT COALESCE(SUM(amount),0) AS amount FROM worker_payment_order_allocations WHERE worker_payment_id=$1",
        [repayoutAfterReversal.json().data.payment.id]
      )).rows[0].amount),100);

      // Parent reversal must also reverse difference allocations stored in the
      // order-allocation table when the original payment uses settlement allocations.
      const parentReverseWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Parent Difference Reversal Worker "+randomBytes(4).toString("hex")]
      )).rows[0];
      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[differenceOrderId]);
      await apiPool.query("UPDATE order_stages SET status='IN_PROGRESS' WHERE id=$1",[differenceStage.id]);
      const parentSourceProduction=await insertDifferenceProduction(10,100,parentReverseWorker.id);
      assert.equal(Number(parentSourceProduction.total_earning_amount),100);
      const parentPaymentResponse=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:parentReverseWorker.id,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:differenceOrderId,orderStageId:differenceStage.id,amount:150,method:"CASH",
          advanceRepaymentAmount:0,allowOverpayment:true,idempotencyKey:randomUUID()}
      });
      assert.equal(parentPaymentResponse.statusCode,201,parentPaymentResponse.body);
      const parentPaymentId=parentPaymentResponse.json().data.payment.id as string;
      const parentDifference=(await apiPool.query(
        "SELECT id FROM worker_payment_settlement_differences WHERE worker_payment_id=$1",[parentPaymentId]
      )).rows[0];
      assert.ok(parentDifference,"the parent-reversal scenario must create a settlement difference");
      const parentLaterProduction=await insertDifferenceProduction(1,10,parentReverseWorker.id);
      const parentAllocationClient=await apiPool.connect();
      let parentAllocations:any[]=[];
      try{
        await parentAllocationClient.query("BEGIN");
        parentAllocations=await allocatePendingWorkerPaymentDifferencesForProduction(
          parentAllocationClient,parentReverseWorker.id,parentLaterProduction.id,manager.id
        );
        await parentAllocationClient.query("COMMIT");
      }catch(error){await parentAllocationClient.query("ROLLBACK");throw error}
      finally{parentAllocationClient.release()}
      assert.equal(parentAllocations.length,1);
      assert.equal(Number(parentAllocations[0].amount),10);
      const orderSummaryAfterDifferenceAllocation=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${parentReverseWorker.id}&orderId=${differenceOrderId}&orderStageId=${differenceStage.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(orderSummaryAfterDifferenceAllocation.statusCode,200,orderSummaryAfterDifferenceAllocation.body);
      assert.equal(Number(orderSummaryAfterDifferenceAllocation.json().data.availableForSettlement),0,
        "order-scoped settlement summary must include active difference allocations to prevent paying the same production twice: "+JSON.stringify(orderSummaryAfterDifferenceAllocation.json().data));
      const parentDifferenceEvent=(await apiPool.query(
        "SELECT id,worker_payment_order_allocation_id FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='ALLOCATED_TO_PRODUCTION'",
        [parentDifference.id]
      )).rows[0];
      assert.ok(parentDifferenceEvent,"the parent payment must have an active difference allocation event");
      const parentDifferenceReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_PAYMENT",sourceId:parentPaymentId,amount:150,
          reason:"اختبار عكس الدفعة الأصلية مع تخصيص فرق التسوية النشط",idempotencyKey:randomUUID()}
      });
      assert.equal(parentDifferenceReversal.statusCode,201,parentDifferenceReversal.body);
      assert.equal(Number((await apiPool.query(
        `SELECT COUNT(*)::int AS count FROM worker_payment_allocation_reversals
          WHERE reversal_id=$1 AND allocation_source='WORKER_PAYMENT_ORDER' AND source_allocation_id=$2`,
        [parentDifferenceReversal.json().data.reversal.id,parentDifferenceEvent.worker_payment_order_allocation_id]
      )).rows[0].count),1,
        "reversing the parent payment must append an allocation reversal for its active difference allocation");
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",[parentDifference.id]
      )).rows[0].status,"REVERSED");
      const parentReversedSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${parentReverseWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(parentReversedSummary.statusCode,200,parentReversedSummary.body);
      assert.equal(Number(parentReversedSummary.json().data.availableForSettlement),110,
        "full parent reversal must reopen both source production and the separately allocated later production");
      const orderSummaryAfterParentReversal=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${parentReverseWorker.id}&orderId=${differenceOrderId}&orderStageId=${differenceStage.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(orderSummaryAfterParentReversal.statusCode,200,orderSummaryAfterParentReversal.body);
      assert.equal(Number(orderSummaryAfterParentReversal.json().data.availableForSettlement),110,
        "order-scoped settlement summary must reopen both production amounts after the parent payment and its difference allocation are reversed");
      const parentReversalIntegrity=await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:managerCookie}
      });
      assert.equal(parentReversalIntegrity.statusCode,200,parentReversalIntegrity.body);
      assert.equal(parentReversalIntegrity.json().data.counts.workerPaymentReversalMismatches,0,
        "reconciliation must include difference-event allocations stored beside canonical settlement allocations");
      assert.equal(parentReversalIntegrity.json().data.counts.workerDifferenceEventReversalMismatches,0,
        "parent payment reversals must reconcile their generated difference-event reversal records to the parent journal line");

      const today=(await apiPool.query("SELECT CURRENT_DATE::text AS date")).rows[0].date;
      const lockedPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Direct payout replay lock test",periodStart:today,periodEnd:today}
      });
      assert.equal(lockedPeriod.statusCode,201,lockedPeriod.body);
      const closedLockPeriod=await closePeriodWithApproval(lockedPeriod.json().data.id);
      assert.equal(closedLockPeriod.statusCode,200,closedLockPeriod.body);
      assert.equal(closedLockPeriod.json().data.status,"CLOSED");
      const replayAfterClose=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},payload:successfulDirectPayload
      });
      assert.equal(replayAfterClose.statusCode,200,replayAfterClose.body,
        "a committed payout retry must still return the original result after close");
      assert.equal(replayAfterClose.json().data.payment.id,directPaymentId);
      const newPayoutAfterClose=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{...successfulDirectPayload,idempotencyKey:randomUUID(),amount:1}
      });
      assert.equal(newPayoutAfterClose.statusCode,409,newPayoutAfterClose.body);
      assert.equal(newPayoutAfterClose.json().error.code,"ACCOUNTING_PERIOD_CLOSED");
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1 AND payment_request_id IS NULL",[workerEmployee.id])).rows[0].count),Number(directCountBeforePeriodLock.rows[0].count),
        "the closed period must not permit an additional payout");

      // Employee production closure regression: a record created before closure but
      // approved afterwards must remain payable, based on approved_at rather than created_at.
      const closureWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES('Test Production Closure Worker') RETURNING id"
      )).rows[0];
      const closurePassword="Closure-Password-2026!";
      const closureSetup=await app.inject({
        method:"POST",url:"/api/worker-payments/employee-production-closures/access-setup",
        headers:{cookie:managerCookie},payload:{password:closurePassword}
      });
      assert.equal(closureSetup.statusCode,200,closureSetup.body);
      async function insertClosureProduction(status:"APPROVED"|"PENDING",createdAt:string){
        return (await apiPool.query(
          `INSERT INTO production_entries(
             employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
             wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
             status,submitted_by,approved_by,approved_at,created_at
           )
           VALUES($1,$2,$3,$4,CURRENT_DATE,1,$5,$6,100,$7,'PER_PIECE','PER_PIECE',100,50,20,
             $8,$9::uuid,CASE WHEN $8='APPROVED' THEN $10::uuid ELSE NULL END,
             CASE WHEN $8='APPROVED' THEN now() ELSE NULL END,$11)
           RETURNING id,total_earning_amount`,
          [closureWorker.id,hamzaProducts.rows[0].product_id,bonusRate.stage_id,bonusShift.id,
           bonusProduct.unit_id,bonusRate.id,perPieceWageType.id,status,manager.id,manager.id,createdAt]
        )).rows[0];
      }
      const alreadyApproved=await insertClosureProduction("APPROVED",new Date(Date.now()-120000).toISOString());
      const pendingBeforeClosure=await insertClosureProduction("PENDING",new Date(Date.now()-60000).toISOString());
      const paymentsBeforeClosure=Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1",[closureWorker.id]
      )).rows[0].count);
      const ledgerBeforeClosure=Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_ledger WHERE employee_id=$1",[closureWorker.id]
      )).rows[0].count);
      const closureResponse=await app.inject({
        method:"POST",url:"/api/worker-payments/employee-production-closures",
        headers:{cookie:managerCookie,"x-production-closure-password":closurePassword},
        payload:{employeeId:closureWorker.id,notes:"Regression test closure"}
      });
      assert.equal(closureResponse.statusCode,200,closureResponse.body);
      assert.equal(Number(closureResponse.json().data.approved_production_count),1,
        "closure must snapshot only production already approved at closure time");
      assert.equal(Number(closureResponse.json().data.production_amount_snapshot),130);
      await apiPool.query(
        "UPDATE production_entries SET status='APPROVED',approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$1",
        [pendingBeforeClosure.id,manager.id]
      );
      const afterClosureSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${closureWorker.id}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(afterClosureSummary.statusCode,200,afterClosureSummary.body);
      assert.equal(Number(afterClosureSummary.json().data.availableForSettlement),130,
        "production approved after closure remains fully payable even if its created_at predates closure");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payments WHERE employee_id=$1",[closureWorker.id]
      )).rows[0].count),paymentsBeforeClosure,"closure must not create a worker payment");
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM employee_earnings_ledger WHERE employee_id=$1",[closureWorker.id]
      )).rows[0].count),ledgerBeforeClosure,"closure must not create or alter earnings ledger entries");
      const closureEntries=await apiPool.query(
        "SELECT production_entry_id FROM employee_production_closure_entries WHERE closure_id=$1",
        [closureResponse.json().data.id]
      );
      assert.deepEqual(closureEntries.rows.map((row:any)=>row.production_entry_id),[alreadyApproved.id],
        "closure snapshots must not absorb pending production that is approved later");
      for(let attempt=0;attempt<5;attempt++){
        const invalidPassword=await app.inject({
          method:"GET",url:"/api/worker-payments/employee-production-closures",
          headers:{cookie:managerCookie,"x-production-closure-password":"Definitely-Wrong-Password"}
        });
        assert.equal(invalidPassword.statusCode,401,"incorrect closure passwords must be rejected");
      }
      const throttledPassword=await app.inject({
        method:"GET",url:"/api/worker-payments/employee-production-closures",
        headers:{cookie:managerCookie,"x-production-closure-password":closurePassword}
      });
      assert.equal(throttledPassword.statusCode,429,
        "five failed closure password attempts must temporarily lock the caller out");

      // Administrative allocation must use the same order-cost classification as
      // profitability: do not count worker-payment expenses twice, and include a
      // matured settlement-difference transfer as a direct cost of its target order.
      const adminCostWorkerA=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Admin Cost Basis Worker A "+randomBytes(4).toString("hex")]
      )).rows[0].id;
      const adminCostWorkerB=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Admin Cost Basis Worker B "+randomBytes(4).toString("hex")]
      )).rows[0].id;
      async function createAdminCostOrder(label:string){
        const response=await app.inject({
          method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
          payload:{orderName:label+" "+randomBytes(4).toString("hex"),
            stages:[{stageName:label+" stage",sequenceNo:1,outputProductName:label+" product "+randomBytes(4).toString("hex"),
              plannedQuantity:1,stageRate:100,stageRateMethod:"PER_PIECE",isFinalProduct:true}]}
        });
        assert.equal(response.statusCode,201,response.body);
        const stage=(await apiPool.query(
          "SELECT os.id,os.stage_id,os.output_product_id,p.unit_id FROM order_stages os JOIN products p ON p.id=os.output_product_id WHERE os.order_id=$1",
          [response.json().data.id]
        )).rows[0];
        return {orderId:response.json().data.id as string,stage};
      }
      const adminCostA=await createAdminCostOrder("Admin allocation basis A");
      const adminCostB=await createAdminCostOrder("Admin allocation basis B");
      async function insertAdminCostProduction(employeeId:string,stage:any){
        return (await apiPool.query(
          `INSERT INTO production_entries(
             employee_id,order_stage_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,rate_snapshot,
             wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,bonus_amount,deduction_amount,
             status,submitted_by,approved_by,approved_at
           ) VALUES($1,$2,$3,$4,$5,CURRENT_DATE,1,$6,$7,100,$8,'PER_PIECE','PER_PIECE',100,0,0,'APPROVED',$9,$9,now())
           RETURNING id`,
          [employeeId,stage.id,stage.output_product_id,stage.stage_id,bonusShift.id,
           stage.unit_id,bonusRate.id,perPieceWageType.id,manager.id]
        )).rows[0];
      }
      await insertAdminCostProduction(adminCostWorkerA,adminCostA.stage);
      await insertAdminCostProduction(adminCostWorkerB,adminCostB.stage);
      const adminCostPaymentA=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,idempotency_key,idempotency_fingerprint)
         VALUES($1,100,100,0,'CASH',$2,$3,'admin-cost-worker-payment-a') RETURNING id`,
        [adminCostWorkerA,manager.id,randomUUID()]
      )).rows[0].id;
      await apiPool.query(
        `INSERT INTO accounting_expenses(order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,
           expense_type,allocation_type,source_worker_payment_id)
         VALUES($1,$2,'WORKER_PAYMENT','Worker payment already included in labor cost',100,CURRENT_DATE,'CASH',$3,'DIRECT','DIRECT',$4)`,
        [adminCostA.orderId,adminCostA.stage.id,manager.id,adminCostPaymentA]
      );
      const adminCostPaymentB=(await apiPool.query(
        `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,idempotency_key,idempotency_fingerprint)
         VALUES($1,50,50,0,'CASH',$2,$3,'admin-cost-difference-payment-b') RETURNING id`,
        [adminCostWorkerB,manager.id,randomUUID()]
      )).rows[0].id;
      const adminCostSourceExpense=(await apiPool.query(
        `INSERT INTO accounting_expenses(category,description,amount,expense_date,payment_method,created_by,
           expense_type,allocation_type,source_worker_payment_id)
         VALUES('WORKER_PAYMENT','Matured worker difference source expense',50,CURRENT_DATE,'CASH',$1,
           'DIRECT','GENERAL',$2) RETURNING id`,
        [manager.id,adminCostPaymentB]
      )).rows[0].id;
      const adminCostDifference=(await apiPool.query(
        `INSERT INTO worker_payment_settlement_differences(
           worker_payment_id,employee_id,source_order_id,source_order_stage_id,source_expense_id,
           original_amount,payment_date,eligible_at,status,created_by
         ) VALUES($1,$2,$3,$4,$5,50,CURRENT_DATE,CURRENT_DATE,'TRANSFERRED_TO_SOURCE_ORDER',$6) RETURNING id`,
        [adminCostPaymentB,adminCostWorkerB,adminCostB.orderId,adminCostB.stage.id,adminCostSourceExpense,manager.id]
      )).rows[0].id;
      await apiPool.query(
        `INSERT INTO worker_payment_settlement_difference_events(
           difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
           target_order_stage_id,actor_type,actor_user_id,reason,idempotency_key
         ) VALUES($1,$2,$3,'TRANSFERRED_TO_SOURCE_ORDER',50,$4,$4,$5,'USER',$6,
           'مراجعة أساس توزيع المصروفات الإدارية',$7)`,
        [adminCostDifference,adminCostPaymentB,adminCostSourceExpense,adminCostB.orderId,adminCostB.stage.id,manager.id,randomUUID()]
      );
      const adminCostPeriod=await app.inject({
        method:"POST",url:"/api/accounting/periods",headers:{cookie:managerCookie},
        payload:{name:"Administrative allocation basis regression",periodStart:"2099-12-01",periodEnd:"2099-12-31"}
      });
      assert.equal(adminCostPeriod.statusCode,201,adminCostPeriod.body);
      await apiPool.query(
        `INSERT INTO accounting_expenses(category,description,amount,expense_date,payment_method,created_by,expense_type)
         VALUES('ADMIN_TEST','Administrative allocation basis test',1000,'2099-12-15','CASH',$1,'ADMINISTRATIVE')`,
        [manager.id]
      );
      const adminCostAllocation=await app.inject({
        method:"POST",url:`/api/accounting/periods/${adminCostPeriod.json().data.id}/auto-allocate`,
        headers:{cookie:managerCookie},payload:{}
      });
      assert.equal(adminCostAllocation.statusCode,200,adminCostAllocation.body);
      const adminCostShares=await apiPool.query(
        "SELECT order_id,amount FROM accounting_expense_allocations WHERE period_id=$1 AND order_id=ANY($2::uuid[])",
        [adminCostPeriod.json().data.id,[adminCostA.orderId,adminCostB.orderId]]
      );
      assert.equal(adminCostShares.rowCount,2,"both test orders must receive an administrative cost allocation");
      const shareA=Number(adminCostShares.rows.find((row:any)=>row.order_id===adminCostA.orderId).amount);
      const shareB=Number(adminCostShares.rows.find((row:any)=>row.order_id===adminCostB.orderId).amount);
      assert.ok(Math.abs(shareA/shareB-2/3)<0.02,
        `administrative allocation basis must be 100 labor for order A versus 100 labor + 50 transferred difference for order B; got ${shareA} and ${shareB}`);

      // The closed-period assertion above is complete. Move its isolated
      // one-day fixture away from today's date so this later independent scenario
      // can post normally without weakening the closed-period regression itself.
      await apiPool.query(
        "UPDATE accounting_periods SET period_start='2098-01-01',period_end='2098-01-01' WHERE id=$1",
        [lockedPeriod.json().data.id]
      );

      // Multiple active allocations on one difference: reversing one event must
      // leave the other event and its production settlement intact.
      const multiEventWorker=(await apiPool.query(
        "INSERT INTO employees(full_name) VALUES($1) RETURNING id",
        ["Multi Event Difference Worker "+randomBytes(4).toString("hex")]
      )).rows[0].id;
      const multiEventOrder=await createAdminCostOrder("Multi event difference isolation");
      await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1",[multiEventOrder.orderId]);
      await insertAdminCostProduction(multiEventWorker,multiEventOrder.stage);
      const multiEventSourcePayment=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:multiEventWorker,settlementSource:"PREVIOUS_CUSTODY",settlementMode:"ALL_DUES",
          orderId:multiEventOrder.orderId,orderStageId:multiEventOrder.stage.id,amount:300,method:"CASH",
          advanceRepaymentAmount:0,allowOverpayment:true,idempotencyKey:randomUUID()}
      });
      assert.equal(multiEventSourcePayment.statusCode,201,multiEventSourcePayment.body);
      const multiEventPaymentId=multiEventSourcePayment.json().data.payment.id as string;
      const multiEventDifference=(await apiPool.query(
        "SELECT id,original_amount FROM worker_payment_settlement_differences WHERE worker_payment_id=$1",
        [multiEventPaymentId]
      )).rows[0];
      assert.ok(multiEventDifference,"the multi-event source payment must create a settlement difference");
      assert.equal(Number(multiEventDifference.original_amount),200);
      const multiEventProductionA=await insertAdminCostProduction(multiEventWorker,multiEventOrder.stage);
      const multiEventProductionB=await insertAdminCostProduction(multiEventWorker,multiEventOrder.stage);
      async function allocateMultiEventProduction(productionEntryId:string){
        const client=await apiPool.connect();
        try{
          await client.query("BEGIN");
          const allocations=await allocatePendingWorkerPaymentDifferencesForProduction(
            client,multiEventWorker,productionEntryId,manager.id
          );
          await client.query("COMMIT");
          return allocations;
        }catch(error){
          await client.query("ROLLBACK");
          throw error;
        }finally{client.release()}
      }
      const multiEventAllocationA=await allocateMultiEventProduction(multiEventProductionA.id);
      const multiEventAllocationB=await allocateMultiEventProduction(multiEventProductionB.id);
      assert.equal(multiEventAllocationA.length,1);
      assert.equal(multiEventAllocationB.length,1);
      assert.equal(Number(multiEventAllocationA[0].amount),100);
      assert.equal(Number(multiEventAllocationB[0].amount),100);
      const multiEventRows=(await apiPool.query(
        "SELECT id,production_entry_id,worker_payment_order_allocation_id,amount FROM worker_payment_settlement_difference_events WHERE difference_id=$1 AND event_type='ALLOCATED_TO_PRODUCTION' ORDER BY created_at,id",
        [multiEventDifference.id]
      )).rows;
      assert.equal(multiEventRows.length,2,"the difference must retain two distinct active allocation events");
      const multiEventReversal=await app.inject({
        method:"POST",url:"/api/accounting/reversals",headers:{cookie:managerCookie},
        payload:{sourceType:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",sourceId:multiEventRows[0].id,
          amount:Number(multiEventRows[0].amount),reason:"عكس تخصيص واحد من تخصيصين نشطين",
          idempotencyKey:randomUUID()}
      });
      assert.equal(multiEventReversal.statusCode,201,multiEventReversal.body);
      const activeMultiEvents=await apiPool.query(
        `SELECT ev.id,ev.production_entry_id,ev.amount
           FROM worker_payment_settlement_difference_events ev
          WHERE ev.difference_id=$1 AND ev.event_type='ALLOCATED_TO_PRODUCTION'
            AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv
              WHERE rv.reverses_event_id=ev.id AND rv.event_type='REVERSED')`,
        [multiEventDifference.id]
      );
      assert.equal(activeMultiEvents.rowCount,1,
        "reversing one allocation must not reverse or erase the other active allocation");
      assert.equal(activeMultiEvents.rows[0].production_entry_id,multiEventRows[1].production_entry_id);
      assert.equal(Number(activeMultiEvents.rows[0].amount),100);
      assert.equal(Number((await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM worker_payment_allocation_reversals WHERE worker_payment_id=$1",
        [multiEventPaymentId]
      )).rows[0].count),1,"only the selected allocation may receive an allocation-reversal row");
      assert.equal((await apiPool.query(
        "SELECT status FROM worker_payment_settlement_differences WHERE id=$1",
        [multiEventDifference.id]
      )).rows[0].status,"REQUIRES_REVIEW");
      const multiEventSummary=await app.inject({
        method:"GET",url:`/api/worker-payments/settlement-summary?employeeId=${multiEventWorker}`,
        headers:{cookie:managerCookie}
      });
      assert.equal(multiEventSummary.statusCode,200,multiEventSummary.body);
      assert.equal(Number(multiEventSummary.json().data.availableForSettlement),100,
        "the summary must restore only the reversed production while retaining the other active difference allocation");

    }finally{await app.close()}
  }finally{
    if(apiPool)await apiPool.end();
    const cleanup=new pg.Client({connectionString:adminUrl});
    try{await cleanup.connect();await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await cleanup.end()}
  }
});
