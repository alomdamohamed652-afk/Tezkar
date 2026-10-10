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
      const productSuffix=randomBytes(4).toString("hex");
      const multiProductOrder=await app.inject({
        method:"POST",url:"/api/orders",headers:{cookie:managerCookie},
        payload:{
          orderName:"Multi-final-product test "+productSuffix,
          customerName:"Isolated integration test",
          lines:[],
          stages:[
            {stageName:"Prepare A "+productSuffix,outputProductName:"WIP A "+productSuffix,sequenceNo:1,plannedQuantity:10,stageRate:1,stageRateMethod:"PER_PIECE",isFinalOutput:false},
            {stageName:"Finish A "+productSuffix,outputProductName:"Finished A "+productSuffix,sequenceNo:2,plannedQuantity:10,stageRate:2,stageRateMethod:"PER_PIECE",isFinalOutput:true},
            {stageName:"Prepare B "+productSuffix,outputProductName:"WIP B "+productSuffix,sequenceNo:3,plannedQuantity:20,stageRate:1,stageRateMethod:"PER_PIECE",isFinalOutput:false},
            {stageName:"Finish B "+productSuffix,outputProductName:"Finished B "+productSuffix,sequenceNo:4,plannedQuantity:20,stageRate:2,stageRateMethod:"PER_PIECE",isFinalOutput:true}
          ]
        }
      });
      assert.equal(multiProductOrder.statusCode,201,multiProductOrder.body);
      const multiOrderId=multiProductOrder.json().data.id;
      const finalLines=await apiPool.query(
        "SELECT p.name,pol.quantity,os.is_final_output FROM production_order_lines pol JOIN products p ON p.id=pol.product_id LEFT JOIN order_stages os ON os.order_id=pol.order_id AND os.output_product_id=pol.product_id AND os.is_final_output=TRUE WHERE pol.order_id=$1 ORDER BY p.name",
        [multiOrderId]
      );
      assert.equal(finalLines.rowCount,2,"one order must retain each distinct final product");
      assert.deepEqual(finalLines.rows.map(row=>({name:row.name,quantity:Number(row.quantity)})),[
        {name:"Finished A "+productSuffix,quantity:10},
        {name:"Finished B "+productSuffix,quantity:20}
      ]);
      assert.ok(finalLines.rows.every(row=>row.is_final_output===true));
      const multiDashboard=await app.inject({method:"GET",url:"/api/orders/"+multiOrderId+"/dashboard",headers:{cookie:managerCookie}});
      assert.equal(multiDashboard.statusCode,200,multiDashboard.body);
      assert.equal(multiDashboard.json().data.finalProducts.length,2);
      assert.equal(multiDashboard.json().data.finalProduct,null,"single-product compatibility field must be null for multi-product orders");
      const finalStageRows=await apiPool.query("SELECT sequence_no,is_final_output FROM order_stages WHERE order_id=$1 ORDER BY sequence_no",[multiOrderId]);
      assert.deepEqual(finalStageRows.rows.map(row=>({sequence:Number(row.sequence_no),isFinal:row.is_final_output})),[
        {sequence:1,isFinal:false},{sequence:2,isFinal:true},{sequence:3,isFinal:false},{sequence:4,isFinal:true}
      ]);
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
      assert.match(custodyDebit.rows[0].description,/صرف طلب القبض/);
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
      const closePeriod=await app.inject({
        method:"POST",url:`/api/accounting/periods/${financePeriod.json().data.id}/close`,
        headers:{cookie:managerCookie},payload:{}
      });
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
    }finally{await app.close()}
  }finally{
    if(apiPool)await apiPool.end();
    const cleanup=new pg.Client({connectionString:adminUrl});
    try{await cleanup.connect();await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)}finally{await cleanup.end()}
  }
});
