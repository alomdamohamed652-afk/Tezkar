import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const range=z.object({from:z.string().date().optional(),to:z.string().date().optional()});

export async function reportsRoutes(app:FastifyInstance){
 app.get("/api/reports/production",{preHandler:[authenticateRequest,requirePermission("reports.view")]},async(request)=>{
  const q=range.safeParse(request.query);if(!q.success)throw new AppError("INVALID_DATE_RANGE","نطاق التاريخ غير صحيح",422);
  const params=[q.data.from??"1900-01-01",q.data.to??"2999-12-31"];
  const r=await pool.query(`SELECT p.work_date,p.code AS production_code,e.code AS employee_code,e.full_name AS employee_name,pr.code AS product_code,pr.name AS product_name,s.name AS stage_name,sh.name AS shift_name,p.quantity,u.name AS unit_name,COALESCE(p.total_earning_amount,p.earning_amount) AS earning_amount,p.status,creator.username AS created_by_username FROM production_entries p JOIN employees e ON e.id=p.employee_id JOIN products pr ON pr.id=p.product_id JOIN stages s ON s.id=p.stage_id JOIN shifts sh ON sh.id=p.shift_id JOIN units u ON u.id=p.unit_id LEFT JOIN users creator ON creator.id=p.created_by WHERE p.work_date BETWEEN $1 AND $2 ORDER BY p.work_date DESC,p.created_at DESC LIMIT 1000`,params);
  return {data:r.rows};
 });
 app.get("/api/reports/employee-earnings",{preHandler:[authenticateRequest,requirePermission("reports.view")]},async()=>{
  const r=await pool.query(`SELECT e.code,e.full_name,COALESCE(SUM(l.credit_amount),0) AS earned,COALESCE(SUM(l.debit_amount),0) AS debited,COALESCE(SUM(l.credit_amount-l.debit_amount),0) AS balance FROM employees e LEFT JOIN employee_earnings_ledger l ON l.employee_id=e.id WHERE e.is_active=TRUE GROUP BY e.id ORDER BY e.full_name`);
  return {data:r.rows};
 });
 app.get("/api/reports/warehouse",{preHandler:[authenticateRequest,requirePermission("reports.view")]},async()=>{
  const r=await pool.query(`SELECT p.code AS product_code,p.name AS product_name,w.code AS warehouse_code,w.name AS warehouse_name,l.code AS location_code,l.name AS location_name,b.quantity,u.name AS unit_name,p.minimum_stock,(b.quantity < p.minimum_stock) AS below_minimum FROM stock_balances b JOIN products p ON p.id=b.product_id JOIN warehouses w ON w.id=b.warehouse_id JOIN warehouse_locations l ON l.id=b.location_id JOIN units u ON u.id=p.unit_id WHERE b.quantity>0 ORDER BY below_minimum DESC,p.name,w.name,l.code`);
  return {data:r.rows};
 });
 app.get("/api/reports/summary",{preHandler:[authenticateRequest,requirePermission("reports.view")]},async()=>{
  const [p,s,e,pay,a]=await Promise.all([pool.query("SELECT COUNT(*)::int AS entries,COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(COALESCE(total_earning_amount,earning_amount)),0) AS earnings FROM production_entries WHERE work_date=CURRENT_DATE AND status='APPROVED'"),pool.query("SELECT COUNT(*)::int AS lines,COALESCE(SUM(quantity),0) AS quantity FROM stock_balances WHERE quantity>0"),pool.query("SELECT COALESCE(SUM(credit_amount),0) AS earned,COALESCE(SUM(debit_amount),0) AS debited,COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger"),pool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status='PENDING'"),pool.query("SELECT COUNT(*)::int AS count FROM advance_requests WHERE status='PENDING'")]);
  return {data:{production:p.rows[0],stock:s.rows[0],earnings:e.rows[0],pendingPayments:pay.rows[0].count,pendingAdvances:a.rows[0].count}};
 });
 app.get("/api/audit-log",{preHandler:[authenticateRequest,requirePermission("audit.view")]},async(request)=>{
  const q=z.object({limit:z.coerce.number().int().min(1).max(300).default(100)}).safeParse(request.query);if(!q.success)throw new AppError("INVALID_LIMIT","عدد السجلات غير صحيح",422);
  const r=await pool.query(`SELECT a.id,a.occurred_at,a.action,a.module,a.entity_type,a.entity_id,a.metadata,u.username,e.full_name AS employee_name,a.ip_address FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN employees e ON e.id=a.actor_employee_id ORDER BY a.occurred_at DESC LIMIT $1`,[q.data.limit]);
  return {data:r.rows};
 });
}