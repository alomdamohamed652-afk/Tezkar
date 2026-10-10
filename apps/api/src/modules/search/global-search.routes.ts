import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { hasPermission } from "../rbac/rbac.service.js";

type SearchResult={id:string;code:string|null;title:string;type:string;detail:string|null;created_at:string|null;href:string;};
export async function globalSearchRoutes(app:FastifyInstance){
  app.get("/api/search/global",{preHandler:[authenticateRequest]},async(request)=>{
    const parsed=z.object({q:z.string().trim().min(2).max(120)}).safeParse(request.query);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","اكتب كودًا أو اسمًا من حرفين على الأقل",422);
    const term="%"+parsed.data.q.replace(/[\\%_]/g,"\\$&")+"%";
    const client=await pool.connect();
    try{
      const userId=request.user!.userId;
      const identity=await client.query("SELECT u.employee_id,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.code='worker' AND r.is_active=TRUE) AS is_worker FROM users u WHERE u.id=$1",[userId]);
      const employeeId=identity.rows[0]?.employee_id as string|null|undefined;
      const isWorker=Boolean(identity.rows[0]?.is_worker);
      const [orders,products,warehouse,payments,cash,cashOwn,employees,deliveries,payroll,advances,advancesOwn,tasks,tasksOwn,cartons,expenses,revenues,periodClose,lots]=await Promise.all([
        hasPermission(client,userId,"orders.view","all"),
        hasPermission(client,userId,"products.view","all"),
        hasPermission(client,userId,"warehouse.view","all"),
        hasPermission(client,userId,"payment_requests.view","all"),
        hasPermission(client,userId,"cash_custody.view","all"),
        hasPermission(client,userId,"cash_custody.view_own","own"),
        hasPermission(client,userId,"employees.view","all"),
        hasPermission(client,userId,"deliveries.view","all"),
        hasPermission(client,userId,"payroll.view","all"),
        hasPermission(client,userId,"advances.view","all"),
        hasPermission(client,userId,"advances.view_own","own"),
        hasPermission(client,userId,"tasks.view","all"),
        hasPermission(client,userId,"tasks.view_own","own"),
        hasPermission(client,userId,"cartons.view","all"),
        hasPermission(client,userId,"finance.expenses.view","all"),
        hasPermission(client,userId,"finance.revenues.view","all"),
        hasPermission(client,userId,"finance.period_close.view","all"),
        hasPermission(client,userId,"warehouse.view","all")
      ]);
      const jobs:Promise<{rows:SearchResult[]}>[]=[];
      if(orders)jobs.push(pool.query("SELECT id,code,order_name AS title,'طلبية'::text AS type,status::text AS detail,created_at,'/orders'::text AS href FROM production_orders WHERE code ILIKE $1 OR order_name ILIKE $1 OR id::text ILIKE $1 ORDER BY created_at DESC LIMIT 25",[term]));
      if(products)jobs.push(pool.query("SELECT id,code,name AS title,'صنف'::text AS type,product_type::text AS detail,created_at,'/warehouse'::text AS href FROM products WHERE code ILIKE $1 OR name ILIKE $1 OR COALESCE(barcode,'') ILIKE $1 OR COALESCE(sku,'') ILIKE $1 OR id::text ILIKE $1 ORDER BY name LIMIT 25",[term]));
      if(warehouse)jobs.push(pool.query("SELECT m.id,m.code,('حركة مخزن — '||p.name)::text AS title,'حركة مخزن'::text AS type,m.movement_type::text AS detail,m.created_at,'/warehouse'::text AS href FROM stock_movements m JOIN products p ON p.id=m.product_id WHERE m.code ILIKE $1 OR m.id::text ILIKE $1 OR p.code ILIKE $1 OR p.name ILIKE $1 OR COALESCE(m.notes,'') ILIKE $1 ORDER BY m.created_at DESC LIMIT 25",[term]));
      if(warehouse)jobs.push(pool.query("SELECT wr.id,wr.code,('إذن استلام — '||wr.source)::text AS title,'إذن استلام'::text AS type,wr.receipt_date::text AS detail,wr.created_at,'/receipts'::text AS href FROM warehouse_receipts wr WHERE wr.code ILIKE $1 OR wr.id::text ILIKE $1 OR wr.source ILIKE $1 OR COALESCE(wr.notes,'') ILIKE $1 ORDER BY wr.created_at DESC LIMIT 25",[term]));
      if(deliveries)jobs.push(pool.query("SELECT d.id,d.code,('إذن تسليم — '||d.destination)::text AS title,'إذن تسليم'::text AS type,d.status::text AS detail,d.created_at,'/deliveries'::text AS href FROM delivery_permissions d WHERE d.code ILIKE $1 OR d.id::text ILIKE $1 OR d.destination ILIKE $1 OR COALESCE(d.notes,'') ILIKE $1 ORDER BY d.created_at DESC LIMIT 25",[term]));
      if(payments)jobs.push(pool.query("SELECT pr.id,pr.code,('طلب قبض — '||e.full_name)::text AS title,'طلب قبض'::text AS type,pr.status::text AS detail,pr.requested_at AS created_at,'/payments'::text AS href FROM payment_requests pr JOIN employees e ON e.id=pr.employee_id WHERE (pr.code ILIKE $1 OR pr.id::text ILIKE $1 OR e.code ILIKE $1 OR e.full_name ILIKE $1)"+(isWorker?" AND pr.employee_id=$2":"")+" ORDER BY pr.requested_at DESC LIMIT 25",isWorker?[term,employeeId]:[term]));
      if(cash||cashOwn)jobs.push(pool.query(
        "SELECT c.id,c.code,('عهدة نقدية — '||e.full_name)::text AS title,'حركة عهدة'::text AS type,(c.direction||' · '||c.description||COALESCE(' · طلب قبض '||preq.code,''))::text AS detail,c.created_at,'/accounting'::text AS href FROM cash_custody_transactions c JOIN employees e ON e.id=c.employee_id LEFT JOIN worker_payments wp ON c.source_type='WORKER_PAYMENT' AND wp.id=c.source_id LEFT JOIN payment_requests preq ON preq.id=wp.payment_request_id WHERE (c.code ILIKE $1 OR c.id::text ILIKE $1 OR COALESCE(c.source_id::text,'') ILIKE $1 OR COALESCE(preq.code,'') ILIKE $1 OR e.code ILIKE $1 OR e.full_name ILIKE $1 OR c.description ILIKE $1 OR COALESCE(c.notes,'') ILIKE $1)"+(cash?"":(cashOwn&&employeeId?" AND c.employee_id=$2":" AND FALSE"))+" ORDER BY c.created_at DESC LIMIT 25",cash?[term]:(cashOwn&&employeeId?[term,employeeId]:[term])));
      if(employees)jobs.push(pool.query("SELECT id,code,full_name AS title,'موظف'::text AS type,CASE WHEN is_active THEN 'نشط' ELSE 'معطل' END AS detail,created_at,'/employees'::text AS href FROM employees WHERE code ILIKE $1 OR full_name ILIKE $1 OR id::text ILIKE $1 ORDER BY full_name LIMIT 25",[term]));
      if(payroll)jobs.push(pool.query("SELECT i.id,i.id::text AS code,('مسير مرتب — '||e.full_name)::text AS title,'مسير مرتبات'::text AS type,(p.period_month::text||' · '||i.status)::text AS detail,p.created_at,'/payroll'::text AS href FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id JOIN employees e ON e.id=i.employee_id WHERE i.id::text ILIKE $1 OR p.period_month::text ILIKE $1 OR e.code ILIKE $1 OR e.full_name ILIKE $1 ORDER BY p.period_month DESC LIMIT 25",[term]));
      if(advances||advancesOwn)jobs.push(pool.query("SELECT a.id,a.code,('سلفة — '||e.full_name)::text AS title,'سلفة'::text AS type,a.status::text AS detail,a.created_at,'/advances'::text AS href FROM advance_requests a JOIN employees e ON e.id=a.employee_id WHERE (a.code ILIKE $1 OR a.id::text ILIKE $1 OR a.reason ILIKE $1 OR e.code ILIKE $1 OR e.full_name ILIKE $1)"+(!advances&&advancesOwn?(employeeId?" AND a.employee_id=$2":" AND FALSE"):"")+" ORDER BY a.created_at DESC LIMIT 25",(!advances&&advancesOwn&&employeeId)?[term,employeeId]:[term]));
      if(tasks||tasksOwn)jobs.push(pool.query("SELECT t.id,t.code,t.title,'مهمة'::text AS type,(t.status||' · '||t.priority)::text AS detail,t.created_at,'/tasks'::text AS href FROM tasks t WHERE (t.code ILIKE $1 OR t.id::text ILIKE $1 OR t.title ILIKE $1 OR COALESCE(t.description,'') ILIKE $1)"+(!tasks&&tasksOwn?(employeeId?" AND (EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.employee_id=$2) OR EXISTS(SELECT 1 FROM users u WHERE u.id=t.created_by AND u.employee_id=$2))":" AND FALSE"):"")+" ORDER BY t.created_at DESC LIMIT 25",(!tasks&&tasksOwn&&employeeId)?[term,employeeId]:[term]));
      if(expenses)jobs.push(pool.query("SELECT ae.id,ae.code,('مصروف — '||ae.description)::text AS title,'مصروف مالي'::text AS type,(ae.category||' · '||ae.amount::text)::text AS detail,ae.created_at,'/accounting'::text AS href FROM accounting_expenses ae LEFT JOIN production_orders o ON o.id=ae.order_id WHERE ae.code ILIKE $1 OR ae.id::text ILIKE $1 OR ae.description ILIKE $1 OR ae.category ILIKE $1 OR o.code ILIKE $1 OR o.order_name ILIKE $1 ORDER BY ae.created_at DESC LIMIT 25",[term]));
      if(revenues)jobs.push(pool.query("SELECT rev.id,rev.code,('إيراد — '||COALESCE(o.order_name,'عام'))::text AS title,'إيراد مالي'::text AS type,(rev.source||' · '||rev.amount::text)::text AS detail,rev.created_at,'/accounting'::text AS href FROM order_revenues rev LEFT JOIN production_orders o ON o.id=rev.order_id WHERE rev.code ILIKE $1 OR rev.id::text ILIKE $1 OR COALESCE(rev.notes,'') ILIKE $1 OR o.code ILIKE $1 OR o.order_name ILIKE $1 ORDER BY rev.created_at DESC LIMIT 25",[term]));
      if(periodClose)jobs.push(pool.query("SELECT p.id,p.code,p.name AS title,'فترة مالية'::text AS type,(p.period_start::text||' → '||p.period_end::text||' · '||p.status)::text AS detail,p.created_at,'/accounting'::text AS href FROM accounting_periods p WHERE p.code ILIKE $1 OR p.name ILIKE $1 OR p.id::text ILIKE $1 OR p.period_start::text ILIKE $1 OR p.period_end::text ILIKE $1 ORDER BY p.period_start DESC LIMIT 25",[term]));
      if(lots)jobs.push(pool.query("SELECT l.id,COALESCE(l.batch_code,l.id::text) AS code,('دفعة مخزون — '||p.name)::text AS title,'دفعة مخزون'::text AS type,(l.remaining_quantity::text||' '||u.name||' · '||w.name)::text AS detail,l.created_at,'/warehouse'::text AS href FROM inventory_lots l JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id JOIN units u ON u.id=p.unit_id WHERE COALESCE(l.batch_code,'') ILIKE $1 OR l.id::text ILIKE $1 OR p.code ILIKE $1 OR p.name ILIKE $1 OR w.name ILIKE $1 ORDER BY l.created_at DESC LIMIT 25",[term]));
      if(cartons)jobs.push(pool.query("SELECT c.id,c.code,('كرتونة — '||p.name)::text AS title,'كرتونة'::text AS type,c.status::text AS detail,c.created_at,'/cartons'::text AS href FROM cartons c JOIN products p ON p.id=c.product_id WHERE c.code ILIKE $1 OR COALESCE(c.barcode,'') ILIKE $1 OR c.id::text ILIKE $1 OR p.code ILIKE $1 OR p.name ILIKE $1 ORDER BY c.created_at DESC LIMIT 25",[term]));
      const resultSets=await Promise.all(jobs);
      const results=resultSets.flatMap(r=>r.rows).sort((a,b)=>Date.parse(String(b.created_at??""))-Date.parse(String(a.created_at??""))).slice(0,100);
      return {data:results,meta:{query:parsed.data.q,count:results.length,modulesSearched:[orders&&"orders",products&&"products",warehouse&&"warehouse",payments&&"payments",(cash||cashOwn)&&"cash_custody",employees&&"employees",deliveries&&"deliveries",payroll&&"payroll",(advances||advancesOwn)&&"advances",(tasks||tasksOwn)&&"tasks",cartons&&"cartons",expenses&&"expenses",revenues&&"revenues",periodClose&&"period_close",lots&&"inventory_lots"].filter(Boolean)}};
    }finally{client.release();}
  });
}
