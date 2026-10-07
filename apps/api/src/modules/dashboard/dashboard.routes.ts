import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

export async function dashboardRoutes(app:FastifyInstance){
 app.get("/api/dashboard/summary",{preHandler:[authenticateRequest,requirePermission("dashboard.view")]},async()=>{
  const [production,earnings,stock,payments,advances]=await Promise.all([
   pool.query("SELECT COALESCE(SUM(quantity),0) AS quantity,COUNT(*)::int AS entries FROM production_entries WHERE work_date=CURRENT_DATE AND status='APPROVED'"),
   pool.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance,COALESCE(SUM(credit_amount),0) AS earned,COALESCE(SUM(debit_amount),0) AS paid FROM employee_earnings_ledger"),
   pool.query("SELECT COUNT(*)::int AS lines,COALESCE(SUM(quantity),0) AS quantity FROM stock_balances WHERE quantity>0"),
   pool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status='PENDING'"),
   pool.query("SELECT COUNT(*)::int AS count FROM advance_requests WHERE status='PENDING'")
  ]);
  return {data:{production:production.rows[0],earnings:earnings.rows[0],stock:stock.rows[0],pendingPayments:payments.rows[0].count,pendingAdvances:advances.rows[0].count}};
 });
}