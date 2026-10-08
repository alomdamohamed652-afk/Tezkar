import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

export async function dashboardRoutes(app:FastifyInstance){
 app.get("/api/dashboard/summary",{preHandler:[authenticateRequest,requirePermission("dashboard.view")]},async()=>{
  const [production,earnings,stock,payments,advances,revenue,expenses,receiptsToday,deliveriesToday,pendingProduction,orders]=await Promise.all([
   pool.query("SELECT COALESCE(SUM(quantity),0) AS quantity,COUNT(*)::int AS entries FROM production_entries WHERE work_date=CURRENT_DATE AND status='APPROVED'"),
   pool.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance,COALESCE(SUM(credit_amount),0) AS earned,COALESCE(SUM(debit_amount),0) AS paid FROM employee_earnings_ledger"),
   pool.query("SELECT COUNT(*)::int AS lines,COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(inventory_value),0) AS value FROM stock_balances WHERE quantity>0"),
   pool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status='PENDING'"),
   pool.query("SELECT COUNT(*)::int AS count FROM advance_requests WHERE status='PENDING'"),
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM order_revenues"),
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM accounting_expenses"),
   pool.query("SELECT COALESCE(SUM(quantity),0) AS quantity FROM warehouse_receipt_lines wrl JOIN warehouse_receipts wr ON wr.id=wrl.receipt_id WHERE wr.receipt_date=CURRENT_DATE"),
   pool.query("SELECT COALESCE(SUM(quantity),0) AS quantity FROM stock_movements WHERE movement_type='OUT' AND reference_type='DELIVERY' AND created_at::date=CURRENT_DATE"),
   pool.query("SELECT COUNT(*)::int AS count FROM production_entries WHERE status='PENDING'"),
   pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status IN ('PLANNED','IN_PROGRESS'))::int AS active,COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed FROM production_orders")
  ]);
  const revenueValue=Number(revenue.rows[0].value||0);
  const expenseValue=Number(expenses.rows[0].value||0);
  return {data:{
    production:production.rows[0],
    earnings:earnings.rows[0],
    stock:stock.rows[0],
    finance:{revenue:revenueValue,expenses:expenseValue,net:revenueValue-expenseValue},
    warehouse:{receiptsToday:receiptsToday.rows[0].quantity,deliveriesToday:deliveriesToday.rows[0].quantity},
    pendingProduction:pendingProduction.rows[0].count,
    pendingPayments:payments.rows[0].count,
    pendingAdvances:advances.rows[0].count,
    orders:orders.rows[0]
  }};
 });
}
