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
    const [{default:Fastify},{default:cookie},{authRoutes},{paymentsRoutes},{globalSearchRoutes},{accountingRoutes},{operationsMasterRoutes},{warehouseRoutes},{orderRoutes},{hashPassword},poolModule]=await Promise.all([
      import("fastify"),import("@fastify/cookie"),import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/payments/payments.routes.js"),import("../src/modules/search/global-search.routes.js"),import("../src/modules/accounting/accounting.routes.js"),import("../src/modules/operations-master/operations-master.routes.js"),import("../src/modules/warehouse/warehouse.routes.js"),import("../src/modules/orders/orders.routes.js"),import("../src/modules/auth/auth.service.js"),
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
    await app.register(globalSearchRoutes);
    await app.register(accountingRoutes);
    await app.register(operationsMasterRoutes);
    await app.register(warehouseRoutes);
    await app.register(orderRoutes);
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
      const approved=await app.inject({
        method:"POST",url:`/api/payment-requests/${requestId}/approve`,headers:{cookie:managerCookie},payload:{advanceRepaymentAmount:50}
      });
      assert.equal(approved.statusCode,200,approved.body);
      assert.equal(approved.json().data.request.status,"PAID");
      assert.ok(approved.json().data.request.paid_payment_id);
      assert.equal(approved.json().data.payment.transfer_reference,"IP-TEST-2026-001");
      const custodyDebit=await apiPool.query("SELECT direction,amount,source_type,source_id,description FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[approved.json().data.payment.id]);
      assert.equal(custodyDebit.rowCount,1,"payment must create exactly one linked cash-custody debit");
      assert.equal(custodyDebit.rows[0].direction,"OUT");
      assert.equal(Number(custodyDebit.rows[0].amount),100,"cash custody must record only the net cash actually paid");
      assert.equal(custodyDebit.rows[0].source_id,approved.json().data.payment.id);
      assert.match(custodyDebit.rows[0].description,/صرف مستحقات العامل/);
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
      const closePeriod=await closePeriodWithApproval(financePeriod.json().data.id);
      assert.equal(closePeriod.statusCode,200,closePeriod.body);
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
          orderId:hamzaOrder.json().data.id,
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
        "SELECT order_id,order_stage_id,category,amount,expense_type,paid_from_employee_id,idempotency_key FROM accounting_expenses WHERE idempotency_key=$1",
        [previousCustodyKey]
      );
      assert.equal(previousCustodyExpense.rowCount,1,"previous-custody settlement must create exactly one order expense");
      assert.equal(previousCustodyExpense.rows[0].order_id,hamzaOrder.json().data.id);
      assert.equal(previousCustodyExpense.rows[0].order_stage_id,null);
      assert.equal(previousCustodyExpense.rows[0].category,"WORKER_PAYMENT");
      assert.equal(previousCustodyExpense.rows[0].expense_type,"DIRECT");
      assert.equal(previousCustodyExpense.rows[0].paid_from_employee_id,null,"the expense must not be tied to today's custody");
      assert.equal(previousCustodyExpense.rows[0].idempotency_key,previousCustodyKey);
      const previousCustodyRetry=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{
          employeeId:previousCustodyEmployee.id,
          settlementSource:"PREVIOUS_CUSTODY",
          orderId:hamzaOrder.json().data.id,
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
      const unpaidProductionBeforePayout=await app.inject({
        method:"GET",url:`/api/worker-payments/unpaid-production?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(unpaidProductionBeforePayout.statusCode,200,unpaidProductionBeforePayout.body);
      assert.equal(unpaidProductionBeforePayout.json().data.some((row:any)=>row.id===bonusProduction.id),true,
        "the payments screen must list approved production that still has a due balance");
      assert.equal(Number(unpaidProductionBeforePayout.json().data.find((row:any)=>row.id===bonusProduction.id).remaining_amount),130);
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
      assert.equal(unpaidProductionAfterPayout.json().data.some((row:any)=>row.id===bonusProduction.id),false,
        "fully settled production must disappear from the unpaid production list");

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
      assert.equal(unpaidAfterHistoricalReconcile.json().data.some((row:any)=>row.id===reconcileProduction.id),false,
        "a reconciled historical settlement must not reappear as unpaid production");

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

      const employeeStatementAfterReconcile=await app.inject({
        method:"GET",url:`/api/worker-payments/employee-statement?employeeId=${bonusWorkerEmployee.id}`,headers:{cookie:managerCookie}
      });
      assert.equal(employeeStatementAfterReconcile.statusCode,200,employeeStatementAfterReconcile.body);
      const reconciledProductionStatement=employeeStatementAfterReconcile.json().data.production.find((row:any)=>row.id===reconcileProduction.id);
      assert.ok(reconciledProductionStatement);
      assert.equal(Number(reconciledProductionStatement.paid_amount),10,
        "employee statement must not count settlement and order allocation rows for the same payment twice");

      const duplicateCurrentCustodyKey=randomUUID();
      const duplicateCurrentCustodyPayout=await app.inject({
        method:"POST",url:"/api/worker-payments/direct",headers:{cookie:managerCookie},
        payload:{employeeId:bonusWorkerEmployee.id,cashCustodyEmployeeId:managerEmployee.id,
          settlementSource:"CURRENT_CUSTODY",settlementMode:"SELECTED_PRODUCTION",
          productionEntryIds:[reconcileProduction.id],amount:1,method:"CASH",idempotencyKey:duplicateCurrentCustodyKey}
      });
      assert.equal(duplicateCurrentCustodyPayout.statusCode,409,duplicateCurrentCustodyPayout.body);
      assert.equal(duplicateCurrentCustodyPayout.json().error.code,"PRODUCTION_ALREADY_SETTLED",
        "current-custody payout must also reject production already paid through a prior settlement");
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
    }finally{await app.close()}
  }finally{
    if(apiPool)await apiPool.end();
    const cleanup=new pg.Client({connectionString:adminUrl});
    try{await cleanup.connect();await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await cleanup.end()}
  }
});
