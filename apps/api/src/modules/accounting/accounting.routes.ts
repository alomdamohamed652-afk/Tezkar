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
  paymentMethod:z.string().trim().max(50).nullable().optional()
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
   const r=await client.query("INSERT INTO accounting_expenses(order_id,category,description,amount,expense_date,payment_method,created_by) VALUES($1,$2,$3,$4,COALESCE($5,current_date),$6,$7) RETURNING *",[p.data.orderId??null,p.data.category,p.data.description,p.data.amount,p.data.expenseDate??null,p.data.paymentMethod??null,request.user!.userId]);
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

 app.get("/api/accounting/orders/:orderId/profitability",{preHandler:[authenticateRequest,requirePermission("finance.profitability.view")]},async(request)=>{
  const p=idSchema.safeParse(request.params);if(!p.success)throw new AppError("VALIDATION_ERROR","الطلبية غير صحيحة",422);
  const order=await pool.query("SELECT id,code,order_name,status,customer_name FROM production_orders WHERE id=$1",[p.data.orderId]);if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
  const [revenue,expenses,stockOut,labor]=await Promise.all([
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM order_revenues WHERE order_id=$1",[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM accounting_expenses WHERE order_id=$1",[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(total_cost),0) AS value FROM stock_movements WHERE order_id=$1 AND movement_type='OUT'",[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(COALESCE(total_earning_amount,earning_amount)),0) AS value FROM production_entries WHERE order_stage_id IN (SELECT id FROM order_stages WHERE order_id=$1) AND status='APPROVED'",[p.data.orderId])
  ]);
  const revenueValue=Number(revenue.rows[0].value||0);
  const explicitExpenses=Number(expenses.rows[0].value||0);
  const materialValue=Number(stockOut.rows[0].value||0);
  const laborValue=Number(labor.rows[0].value||0);
  const totalCost=explicitExpenses+materialValue+laborValue;
  return {data:{order:order.rows[0],revenue:revenueValue,expenses:explicitExpenses,materialCost:materialValue,laborCost:laborValue,totalCost,profit:revenueValue-totalCost,marginPercent:revenueValue>0?((revenueValue-totalCost)/revenueValue)*100:null}};
 });
}
