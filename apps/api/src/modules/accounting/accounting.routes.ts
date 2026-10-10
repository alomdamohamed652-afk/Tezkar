import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const expenseSchema=z.object({
  orderId:z.string().uuid().nullable().optional(),
  category:z.string().trim().min(2).max(100),
  description:z.string().trim().min(2).max(300),
  amount:z.number().positive(),
  expenseDate:z.string().date().optional(),
  paymentMethod:z.string().trim().max(50).nullable().optional(),
  expenseType:z.enum(["DIRECT","ADMINISTRATIVE"]).default("DIRECT"),
  paidFromEmployeeId:z.string().uuid().nullable().optional()
}).superRefine((v,ctx)=>{
  if(v.expenseType==="ADMINISTRATIVE"&&v.orderId){
    ctx.addIssue({code:"custom",path:["orderId"],message:"المصروف الإداري يوزع على الطلبيات وقت التصفية ولا يرتبط بطلبية واحدة"});
  }
});
const revenueSchema=z.object({
  orderId:z.string().uuid().nullable().optional(),
  amount:z.number().positive(),
  revenueDate:z.string().date().optional(),
  source:z.string().trim().min(2).max(50).default("MANUAL"),
  notes:z.string().trim().max(500).nullable().optional()
});
const idSchema=z.object({orderId:z.string().uuid()});

export async function accountingRoutes(app:FastifyInstance){
 app.get("/api/accounting/expenses",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async(request)=>{
  const q=z.object({orderId:z.string().uuid().optional()}).safeParse(request.query);
  if(!q.success)throw new AppError("VALIDATION_ERROR","فلتر المصروفات غير صحيح",422);
  const params:unknown[]=[];let where="";
  if(q.data.orderId){params.push(q.data.orderId);where=" WHERE e.order_id=$1 ";}
  const r=await pool.query(`SELECT e.*,o.code AS order_code,o.order_name,u.username AS created_by_username
    FROM accounting_expenses e
    LEFT JOIN production_orders o ON o.id=e.order_id
    LEFT JOIN users u ON u.id=e.created_by
    ${where} ORDER BY e.expense_date DESC,e.created_at DESC LIMIT 500`,params);
  return {data:r.rows};
 });

 app.post("/api/accounting/expenses",{preHandler:[authenticateRequest,requirePermission("finance.expenses.create")]},async(request,reply)=>{
  const p=expenseSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات المصروف غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   if(p.data.orderId){
    const order=await client.query("SELECT id FROM production_orders WHERE id=$1",[p.data.orderId]);
    if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
   }
   if(p.data.paidFromEmployeeId){
    const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[p.data.paidFromEmployeeId]);
    if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
   }
   let r=await client.query("INSERT INTO accounting_expenses(order_id,category,description,amount,expense_date,payment_method,created_by,expense_type,paid_from_employee_id) VALUES($1,$2,$3,$4,COALESCE($5,current_date),$6,$7,$8,$9) RETURNING *",[p.data.orderId??null,p.data.category,p.data.description,p.data.amount,p.data.expenseDate??null,p.data.paymentMethod??null,request.user!.userId,p.data.expenseType,p.data.paidFromEmployeeId??null]);
   if(p.data.paidFromEmployeeId){
    // Administrative/direct expense payment is an actual custody OUT movement.
    // Expenses may drive custody negative as requested; this is distinct from an
    // ordinary manual OUT movement, which still checks available balance.
    const cash=await client.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'OUT',$2,COALESCE($3::date,current_date),$4,$5,'ACCOUNTING_EXPENSE',$6,$7) RETURNING id",
      [p.data.paidFromEmployeeId,p.data.amount,p.data.expenseDate??null,p.data.description,"صرف مصروف: "+p.data.category,r.rows[0].id,request.user!.userId]);
    r=await client.query("UPDATE accounting_expenses SET cash_custody_transaction_id=$1 WHERE id=$2 RETURNING *",[cash.rows[0].id,r.rows[0].id]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"expense",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/accounting/revenues",{preHandler:[authenticateRequest,requirePermission("finance.revenues.view")]},async()=>{
  const r=await pool.query("SELECT r.*,o.code AS order_code,o.order_name,u.username AS created_by_username FROM order_revenues r LEFT JOIN production_orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=r.created_by ORDER BY r.revenue_date DESC,r.created_at DESC LIMIT 500");
  return {data:r.rows};
 });

 app.post("/api/accounting/revenues",{preHandler:[authenticateRequest,requirePermission("finance.revenues.create")]},async(request,reply)=>{
  const p=revenueSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الإيراد غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   if(p.data.orderId){
     const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1",[p.data.orderId]);
     if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
   }
   const codeResult=await client.query("SELECT 'REV-' || lpad(nextval('revenue_code_seq')::text,8,'0') AS code");
   const code=codeResult.rows[0].code;
   const r=await client.query("INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by) VALUES($1,$2,$3,COALESCE($4,current_date),$5,$6,$7) RETURNING *",[p.data.orderId??null,code,p.data.amount,p.data.revenueDate??null,p.data.source,p.data.notes??null,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"revenue",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/accounting/summary",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view"),requirePermission("finance.revenues.view")]},async()=>{
  const r=await pool.query(`
    SELECT
      COALESCE((SELECT SUM(amount) FROM order_revenues),0) AS total_in,
      COALESCE((SELECT SUM(amount) FROM accounting_expenses),0) AS total_out,
      COALESCE((SELECT SUM(amount) FROM order_revenues),0)-COALESCE((SELECT SUM(amount) FROM accounting_expenses),0) AS net,
      COALESCE((SELECT COUNT(*) FROM order_revenues),0)::int AS revenue_count,
      COALESCE((SELECT COUNT(*) FROM accounting_expenses),0)::int AS expense_count,
      COALESCE((SELECT SUM(amount) FROM accounting_expenses WHERE order_id IS NULL),0) AS general_expenses,
      COALESCE((SELECT SUM(amount) FROM order_revenues WHERE order_id IS NULL),0) AS general_income`);
  return {data:r.rows[0]};
 });


 const periodSchema=z.object({
  name:z.string().trim().min(2).max(120),
  periodStart:z.string().date(),
  periodEnd:z.string().date(),
  notes:z.string().trim().max(1000).nullable().optional()
 }).refine(v=>v.periodEnd>=v.periodStart,{message:"تاريخ نهاية الفترة يجب أن يكون بعد بدايتها",path:["periodEnd"]});
 const allocationSchema=z.object({
  allocations:z.array(z.object({
   expenseId:z.string().uuid(),
   orderId:z.string().uuid(),
   amount:z.number().nonnegative().refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"مبلغ التوزيع يجب أن يكون بحد أقصى منزلتين عشريتين"})
  }))
 });
 const toMinorUnits=(value:unknown)=>Math.round(Number(value||0)*100);
 app.get("/api/accounting/periods",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async()=>{
  const r=await pool.query(`SELECT p.*,
    (SELECT COUNT(*)::int FROM accounting_expense_allocations a WHERE a.period_id=p.id) AS allocation_count,
    COALESCE((SELECT SUM(amount) FROM accounting_expense_allocations a WHERE a.period_id=p.id),0) AS allocated_amount
    FROM accounting_periods p ORDER BY p.period_start DESC,p.created_at DESC`);
  return {data:r.rows};
 });
 app.post("/api/accounting/periods",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request,reply)=>{
  const p=periodSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الفترة المالية غير صحيحة",422);
  const row=await withTransaction(async client=>{
   // Serialize period creation so concurrent requests cannot both pass the overlap check.
   await client.query("SELECT pg_advisory_xact_lock(hashtext('tezkar_accounting_period_overlap'))");
   const overlap=await client.query("SELECT id FROM accounting_periods WHERE period_start<=$2::date AND period_end>=$1::date LIMIT 1",[p.data.periodStart,p.data.periodEnd]);
   if(overlap.rowCount)throw new AppError("ACCOUNTING_PERIOD_OVERLAP","الفترة تتداخل مع فترة مالية مسجلة بالفعل",409);
   const r=await client.query("INSERT INTO accounting_periods(name,period_start,period_end,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[p.data.name,p.data.periodStart,p.data.periodEnd,p.data.notes??null,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"accounting_period",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });
 app.get("/api/accounting/periods/:id",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const period=await pool.query("SELECT * FROM accounting_periods WHERE id=$1",[id]);
  if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
  const [expenses,allocations]=await Promise.all([
   pool.query("SELECT e.id,e.code,e.category,e.description,e.amount,e.expense_date FROM accounting_expenses e WHERE e.expense_type='ADMINISTRATIVE' AND e.expense_date BETWEEN $1 AND $2 ORDER BY e.expense_date,e.created_at",[period.rows[0].period_start,period.rows[0].period_end]),
   pool.query("SELECT a.*,e.code AS expense_code,e.description AS expense_description,o.code AS order_code,o.order_name FROM accounting_expense_allocations a JOIN accounting_expenses e ON e.id=a.expense_id JOIN production_orders o ON o.id=a.order_id WHERE a.period_id=$1 ORDER BY e.expense_date,e.created_at,o.code",[id])
  ]);
  const orders=await pool.query("SELECT id,code,order_name,status FROM production_orders WHERE status<>'CANCELLED' ORDER BY created_at DESC");
  return {data:{period:period.rows[0],expenses:expenses.rows,allocations:allocations.rows,orders:orders.rows}};
 });
 app.post("/api/accounting/periods/:id/auto-allocate",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","لا يمكن تعديل فترة مقفلة",409);
   const expenses=await client.query("SELECT id,amount FROM accounting_expenses WHERE expense_type='ADMINISTRATIVE' AND expense_date BETWEEN $1 AND $2 ORDER BY id",[period.rows[0].period_start,period.rows[0].period_end]);
   if(!expenses.rowCount)throw new AppError("NO_ADMIN_EXPENSES","لا توجد مصروفات إدارية في هذه الفترة",409);
   const orders=await client.query(`SELECT o.id,
    COALESCE((SELECT SUM(e.amount) FROM accounting_expenses e WHERE e.order_id=o.id),0)
    +COALESCE((SELECT SUM(sm.total_cost) FROM stock_movements sm WHERE sm.order_id=o.id AND sm.movement_type='OUT' AND sm.reference_type IS DISTINCT FROM 'DELIVERY'),0)
    +COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=o.id AND pe.status='APPROVED'),0) AS cost
    FROM production_orders o WHERE o.status<>'CANCELLED' ORDER BY o.code`);
   const eligibleOrders=orders.rows.filter(row=>Number(row.cost||0)>0);
   const totalCost=eligibleOrders.reduce((sum,row)=>sum+Number(row.cost||0),0);
   if(!eligibleOrders.length||totalCost<=0)throw new AppError("NO_COST_BASIS","لا توجد تكاليف موجبة للطلبيات يمكن توزيع المصروفات عليها",409);
   await client.query("DELETE FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   for(const expense of expenses.rows){
    const amountMinor=toMinorUnits(expense.amount);
    let allocatedMinor=0;
    for(let i=0;i<eligibleOrders.length;i++){
     const order=eligibleOrders[i];
     const shareMinor=i===eligibleOrders.length-1
       ? amountMinor-allocatedMinor
       : Math.round(amountMinor*Number(order.cost||0)/totalCost);
     allocatedMinor+=shareMinor;
     await client.query("INSERT INTO accounting_expense_allocations(period_id,expense_id,order_id,amount,created_by) VALUES($1,$2,$3,$4,$5)",[id,expense.id,order.id,shareMinor/100,request.user!.userId]);
    }
    if(allocatedMinor!==amountMinor)throw new AppError("ALLOCATION_ROUNDING_ERROR","تعذر موازنة توزيع المصروفات إلى القرش",500);
   }
   const result=await client.query("SELECT COALESCE(SUM(amount),0) AS allocated FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"auto_allocate",module:"finance",entityType:"accounting_period",entityId:id,afterData:{periodId:id,expenseCount:expenses.rowCount,allocationCount:expenses.rowCount*orders.rows.length,allocatedAmount:result.rows[0].allocated},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {periodId:id,expenseCount:expenses.rowCount,allocationCount:expenses.rowCount*orders.rows.length,allocatedAmount:result.rows[0].allocated};
  })};
 });
 app.put("/api/accounting/periods/:id/allocations",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const p=allocationSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات توزيع المصروفات غير صحيحة",422);
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","لا يمكن تعديل فترة مقفلة",409);
   const expenses=await client.query("SELECT id,amount FROM accounting_expenses WHERE expense_type='ADMINISTRATIVE' AND expense_date BETWEEN $1 AND $2",[period.rows[0].period_start,period.rows[0].period_end]);
   const sums=new Map<string,number>();
   for(const item of p.data.allocations)sums.set(item.expenseId,(sums.get(item.expenseId)||0)+toMinorUnits(item.amount));
   for(const expense of expenses.rows){
    if((sums.get(expense.id)||0)!==toMinorUnits(expense.amount))throw new AppError("ALLOCATION_TOTAL_MISMATCH","يجب أن يساوي مجموع توزيع كل مصروف إداري قيمته الأصلية بدقة القرش",422);
   }
   if(p.data.allocations.some(a=>!expenses.rows.some(e=>e.id===a.expenseId)))throw new AppError("INVALID_ALLOCATION_EXPENSE","يوجد مصروف خارج الفترة أو ليس مصروفًا إداريًا",422);
   const validOrders=await client.query("SELECT id FROM production_orders WHERE status<>'CANCELLED'");
   const orderIds=new Set(validOrders.rows.map(r=>r.id));
   if(p.data.allocations.some(a=>!orderIds.has(a.orderId)))throw new AppError("INVALID_ALLOCATION_ORDER","يوجد اختيار طلبية غير صالح",422);
   const grouped=new Map<string,{expenseId:string;orderId:string;amount:number}>();
   for(const a of p.data.allocations){
    const key=a.expenseId+":"+a.orderId;
    const current=grouped.get(key);
    if(current)current.amount=Number((current.amount+a.amount).toFixed(4));
    else grouped.set(key,{expenseId:a.expenseId,orderId:a.orderId,amount:a.amount});
   }
   await client.query("DELETE FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   for(const a of grouped.values()){
    await client.query("INSERT INTO accounting_expense_allocations(period_id,expense_id,order_id,amount,created_by) VALUES($1,$2,$3,$4,$5)",[id,a.expenseId,a.orderId,a.amount,request.user!.userId]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update_allocations",module:"finance",entityType:"accounting_period",entityId:id,afterData:{periodId:id,allocationCount:grouped.size},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {periodId:id,allocationCount:grouped.size};
  })};
 });
 app.post("/api/accounting/periods/:id/close",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","الفترة مقفلة بالفعل",409);
   const expenses=await client.query("SELECT e.id,e.amount,COALESCE(SUM(a.amount),0) AS allocated FROM accounting_expense_allocations a RIGHT JOIN accounting_expenses e ON e.id=a.expense_id AND a.period_id=$3 WHERE e.expense_type='ADMINISTRATIVE' AND e.expense_date BETWEEN $1 AND $2 GROUP BY e.id,e.amount",[period.rows[0].period_start,period.rows[0].period_end,id]);
   const unbalanced=expenses.rows.filter(e=>toMinorUnits(e.amount)!==toMinorUnits(e.allocated));
   if(unbalanced.length)throw new AppError("UNALLOCATED_ADMIN_EXPENSES","لا يمكن قفل الفترة قبل توزيع كامل المصروفات الإدارية على الطلبيات",409);
   const r=await client.query("UPDATE accounting_periods SET status='CLOSED',closed_by=$2,closed_at=now() WHERE id=$1 RETURNING *",[id,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"close",module:"finance",entityType:"accounting_period",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });

 app.get("/api/accounting/orders/:orderId/profitability",{preHandler:[authenticateRequest,requirePermission("finance.profitability.view")]},async(request)=>{
  const p=idSchema.safeParse(request.params);if(!p.success)throw new AppError("VALIDATION_ERROR","الطلبية غير صحيحة",422);
  const order=await pool.query("SELECT id,code,order_name,status,customer_name FROM production_orders WHERE id=$1",[p.data.orderId]);if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
  const [revenue,expenses,stockOut,labor]=await Promise.all([
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM order_revenues WHERE order_id=$1",[p.data.orderId]),
   pool.query(`SELECT
     COALESCE((SELECT SUM(amount) FROM accounting_expenses WHERE order_id=$1),0) AS value,
     COALESCE((SELECT SUM(a.amount) FROM accounting_expense_allocations a JOIN accounting_periods ap ON ap.id=a.period_id WHERE a.order_id=$1 AND ap.status='CLOSED'),0) AS administrative_allocation`,[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(total_cost),0) AS value FROM stock_movements WHERE order_id=$1 AND movement_type='OUT' AND reference_type IS DISTINCT FROM 'DELIVERY'",[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(COALESCE(total_earning_amount,earning_amount)),0) AS value FROM production_entries WHERE order_stage_id IN (SELECT id FROM order_stages WHERE order_id=$1) AND status='APPROVED'",[p.data.orderId])
  ]);
  const revenueValue=Number(revenue.rows[0].value||0);
  const explicitExpenses=Number(expenses.rows[0].value||0);
  const administrativeAllocation=Number(expenses.rows[0].administrative_allocation||0);
  const materialValue=Number(stockOut.rows[0].value||0);
  const laborValue=Number(labor.rows[0].value||0);
  const totalCost=explicitExpenses+administrativeAllocation+materialValue+laborValue;
  return {data:{order:order.rows[0],revenue:revenueValue,expenses:explicitExpenses,administrativeAllocation,materialCost:materialValue,laborCost:laborValue,totalCost,profit:revenueValue-totalCost,marginPercent:revenueValue>0?((revenueValue-totalCost)/revenueValue)*100:null}};
 });
}
