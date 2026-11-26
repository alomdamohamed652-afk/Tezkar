import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

// Global dashboard filters (2026-11-26 request): one filter state drives every
// period-based card, chart and list. Instant balances (stock value, pending
// counts, order status) stay unfiltered and are labeled "current" in the UI.
// Defaults are exactly the pre-filter behavior: today for daily stats, last 7
// days for trends, all-time for finance totals.

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const ID_RE=/^(\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

type Filters={
  from:string|null;to:string|null;productId:string|null;
  orderId:string|null;employeeId:string|null;stageId:string|null;
};

function parseFilters(q:Record<string,unknown>):Filters{
  const s=(v:unknown)=>typeof v==="string"?v:null;
  const d=(v:unknown)=>{const x=s(v);return x&&DATE_RE.test(x)?x:null};
  const i=(v:unknown)=>{const x=s(v);return x&&ID_RE.test(x)?x:null};
  return {from:d(q.from),to:d(q.to),productId:i(q.product_id),orderId:i(q.order_id),employeeId:i(q.employee_id),stageId:i(q.stage_id)};
}

// Builds WHERE fragments for production_entries (alias pe) with positional params.
function peConds(f:Filters,params:unknown[],opts:{date:"today"|"range"},alias:string="pe"):string{
  const w=[alias+".status='APPROVED'"];
  if(opts.date==="today"){
    if(f.from||f.to){
      if(f.from){params.push(f.from);w.push(alias+".work_date>=$"+params.length+"::date")}
      if(f.to){params.push(f.to);w.push(alias+".work_date<=$"+params.length+"::date")}
    }else w.push(alias+".work_date=CURRENT_DATE");
  }else{
    if(f.from){params.push(f.from);w.push(alias+".work_date>=$"+params.length+"::date")}
    else w.push(alias+".work_date>=CURRENT_DATE-6");
    if(f.to){params.push(f.to);w.push(alias+".work_date<=$"+params.length+"::date")}
  }
  if(f.productId){params.push(f.productId);w.push(alias+".product_id=$"+params.length)}
  if(f.employeeId){params.push(f.employeeId);w.push(alias+".employee_id=$"+params.length)}
  if(f.stageId){params.push(f.stageId);w.push(alias+".stage_id=$"+params.length)}
  if(f.orderId){params.push(f.orderId);w.push(alias+".order_stage_id IN (SELECT id FROM order_stages WHERE order_id=$"+params.length+")")}
  return w.join(" AND ");
}

function trendDays(f:Filters,params:unknown[]):string{
  if(f.from||f.to){
    const lo=f.from?f.from:f.to!;const hi=f.to?f.to:f.from!;
    params.push(lo,hi);
    return "SELECT generate_series($"+(params.length-1)+"::date,$"+params.length+"::date,INTERVAL '1 day')::date AS day";
  }
  return "SELECT generate_series(CURRENT_DATE-INTERVAL '6 days',CURRENT_DATE,INTERVAL '1 day')::date AS day";
}

export async function dashboardRoutes(app:FastifyInstance){
 app.get("/api/dashboard/filter-options",{preHandler:[authenticateRequest,requirePermission("dashboard.view")]},async()=>{
  const [products,orders,employees,stages]=await Promise.all([
   pool.query("SELECT id,name FROM products WHERE is_active=TRUE ORDER BY name LIMIT 200"),
   pool.query("SELECT id,code,order_name FROM production_orders WHERE status NOT IN ('CANCELLED') ORDER BY id DESC LIMIT 200"),
   pool.query("SELECT id,full_name FROM employees WHERE is_active=TRUE ORDER BY full_name LIMIT 200"),
   pool.query("SELECT id,name FROM stages WHERE is_active=TRUE ORDER BY name LIMIT 200")
  ]);
  return {data:{products:products.rows,orders:orders.rows,employees:employees.rows,stages:stages.rows}};
 });

 // Per-product production trends + multi-product comparison (2026-11-26 request).
 // Read-only; grouped by day (default last 7d), week (last 8w) or month (last 12m);
 // honors the global dashboard filters (from/to/employee/order/stage).
 app.get("/api/dashboard/product-trends",{preHandler:[authenticateRequest,requirePermission("dashboard.view")]},async(req)=>{
  const q=(req.query||{}) as Record<string,unknown>;
  const f=parseFilters(q);
  const groupRaw=typeof q.group==="string"?q.group:"day";
  const group=(["day","week","month"] as const).includes(groupRaw as "day"|"week"|"month")?groupRaw as "day"|"week"|"month":"day";
  const idsRaw=typeof q.product_ids==="string"?q.product_ids.split(","):[]; 
  const ids=idsRaw.map(x=>x.trim()).filter(x=>ID_RE.test(x)).slice(0,5);
  if(!ids.length)return {data:{group,labels:[],series:[]}};

  const trunc=group==="day"?"day":group==="week"?"week":"month";
  const step=group==="day"?"1 day":group==="week"?"1 week":"1 month";
  const back=group==="day"?"6 days":group==="week"?"7 weeks":"11 months";

  const params:unknown[]=[];
  params.push(...ids);
  const idList="("+ids.map((_,i)=>"$"+(i+1)).join(",")+")";
  let rangeSql:string;
  if(f.from||f.to){
   const lo=f.from||f.to!;const hi=f.to||f.from!;
   params.push(lo,hi);
   rangeSql="SELECT generate_series(date_trunc('"+trunc+"',$"+(params.length-1)+"::date)::date,date_trunc('"+trunc+"',$"+params.length+"::date)::date,INTERVAL '"+step+"')::date AS bucket";
  }else{
   rangeSql="SELECT generate_series(date_trunc('"+trunc+"',CURRENT_DATE-INTERVAL '"+back+"')::date,date_trunc('"+trunc+"',CURRENT_DATE)::date,INTERVAL '"+step+"')::date AS bucket";
  }
  const w=["pe.status='APPROVED'","pe.product_id IN "+idList];
  if(f.employeeId){params.push(f.employeeId);w.push("pe.employee_id=$"+params.length)}
  if(f.stageId){params.push(f.stageId);w.push("pe.stage_id=$"+params.length)}
  if(f.orderId){params.push(f.orderId);w.push("pe.order_stage_id IN (SELECT id FROM order_stages WHERE order_id=$"+params.length+")")}
  const sql="WITH buckets AS ("+rangeSql+"), x AS (SELECT pe.product_id,date_trunc('"+trunc+"',pe.work_date)::date AS bucket,COALESCE(SUM(pe.quantity),0) AS quantity FROM production_entries pe WHERE "+w.join(" AND ")+" GROUP BY pe.product_id,bucket) SELECT to_char(b.bucket,'YYYY-MM-DD') AS bucket,p.id AS product_id,p.name AS product_name,COALESCE(x.quantity,0) AS quantity FROM buckets b CROSS JOIN products p LEFT JOIN x ON x.bucket=b.bucket AND x.product_id=p.id WHERE p.id IN "+idList+" ORDER BY b.bucket,p.name";
  const r=await pool.query(sql,params);
  const labels:string[]=[];const byProduct=new Map<string,{name:string;values:number[]}>();
  for(const row of r.rows){
   const b=String(row.bucket);
   if(!labels.includes(b))labels.push(b);
   if(!byProduct.has(row.product_id))byProduct.set(row.product_id,{name:row.product_name,values:[]});
   byProduct.get(row.product_id)!.values.push(Number(row.quantity));
  }
  return {data:{group,labels,series:[...byProduct.entries()].map(([id,v])=>({product_id:id,name:v.name,values:v.values}))}};
 });

 app.get("/api/dashboard/summary",{preHandler:[authenticateRequest,requirePermission("dashboard.view")]},async(req)=>{
  const f=parseFilters((req.query||{}) as Record<string,unknown>);
  const hasPeriod=Boolean(f.from||f.to);

  // --- production_entries-based queries (share one param list per query) ---
  const pProduction:unknown[]=[];
  const productionSql="SELECT COALESCE(SUM(quantity),0) AS quantity,COUNT(*)::int AS entries FROM production_entries pe WHERE "+peConds(f,pProduction,{date:"today"});

  const pTrend:unknown[]=[];
  const trendDaysSql=trendDays(f,pTrend);
  const trendCond=peConds(f,pTrend,{date:"range"});
  const productionTrendSql="WITH days AS ("+trendDaysSql+"), x AS (SELECT pe.work_date AS day,COALESCE(SUM(pe.quantity),0) AS quantity,COUNT(*)::int AS entries FROM production_entries pe WHERE "+trendCond+" GROUP BY pe.work_date) SELECT d.day,COALESCE(x.quantity,0) AS quantity,COALESCE(x.entries,0) AS entries FROM days d LEFT JOIN x ON x.day=d.day ORDER BY d.day";

  const pTop:unknown[]=[];
  const topProductsSql="SELECT p.name AS product_name,COALESCE(SUM(pe.quantity),0) AS quantity FROM production_entries pe JOIN products p ON p.id=pe.product_id WHERE "+peConds(f,pTop,{date:"range"})+" GROUP BY p.id,p.name ORDER BY quantity DESC LIMIT 5";

  const pScrap:unknown[]=[];
  const scrapInner=peConds(f,pScrap,{date:"range"},"pe2");
  const grossInner=peConds(f,pScrap,{date:"range"},"pe");
  const scrapFinal="SELECT (SELECT COALESCE(SUM(psr.quantity),0) FROM production_scrap_records psr JOIN production_entries pe2 ON pe2.id=psr.production_entry_id WHERE "+scrapInner+") AS scrap,(SELECT COALESCE(SUM(pe.quantity),0) FROM production_entries pe WHERE "+grossInner+") AS gross";

  const pWorkers:unknown[]=[];
  const topWorkersSql="SELECT e.full_name AS employee_name,COALESCE(SUM(pe.quantity),0) AS quantity,COUNT(*)::int AS entries FROM production_entries pe JOIN employees e ON e.id=pe.employee_id WHERE "+peConds(f,pWorkers,{date:"range"})+" GROUP BY e.id,e.full_name ORDER BY quantity DESC LIMIT 5";

  // --- earnings ledger: employee filter + optional period on created_at ---
  const pEarn:unknown[]=[];const earnW:string[]=["TRUE"];
  if(f.employeeId){pEarn.push(f.employeeId);earnW.push("employee_id=$"+pEarn.length)}
  if(f.from){pEarn.push(f.from);earnW.push("created_at::date>=$"+pEarn.length+"::date")}
  if(f.to){pEarn.push(f.to);earnW.push("created_at::date<=$"+pEarn.length+"::date")}
  const earningsSql="SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance,COALESCE(SUM(credit_amount),0) AS earned,COALESCE(SUM(debit_amount),0) AS paid FROM employee_earnings_ledger WHERE "+earnW.join(" AND ");

  // --- finance: period + order filter; totals stay all-time without period ---
  const pRev:unknown[]=[];const revW:string[]=["TRUE"];
  if(f.from){pRev.push(f.from);revW.push("revenue_date>=$"+pRev.length+"::date")}
  if(f.to){pRev.push(f.to);revW.push("revenue_date<=$"+pRev.length+"::date")}
  if(f.orderId){pRev.push(f.orderId);revW.push("order_id=$"+pRev.length)}
  const revenueSql="SELECT COALESCE(SUM(amount),0) AS value FROM order_revenues WHERE "+revW.join(" AND ");

  const pExp:unknown[]=[];const expW:string[]=["TRUE"];
  if(f.from){pExp.push(f.from);expW.push("e.expense_date>=$"+pExp.length+"::date")}
  if(f.to){pExp.push(f.to);expW.push("e.expense_date<=$"+pExp.length+"::date")}
  if(f.orderId){pExp.push(f.orderId);expW.push("e.order_id=$"+pExp.length)}
  const expensesSql="SELECT COALESCE(SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)),0) AS value FROM accounting_expenses e WHERE "+expW.join(" AND ");

  const pFinTrend:unknown[]=[];
  const finDaysSql=trendDays(f,pFinTrend);
  const revT:string[]=["TRUE"];const expT:string[]=["TRUE"];
  if(f.orderId){pFinTrend.push(f.orderId);const n="$"+pFinTrend.length;revT.push("order_id="+n);expT.push("ae.order_id="+n)}
  const financeTrendSql="WITH days AS ("+finDaysSql+"), r AS (SELECT created_at::date AS day,COALESCE(SUM(amount),0) AS value FROM order_revenues WHERE "+revT.join(" AND ")+" GROUP BY 1), e AS (SELECT expense_date AS day,COALESCE(SUM(ae.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=ae.id),0)),0) AS value FROM accounting_expenses ae WHERE "+expT.join(" AND ")+" GROUP BY 1) SELECT d.day,COALESCE(r.value,0) AS revenue,COALESCE(e.value,0) AS expenses FROM days d LEFT JOIN r ON r.day=d.day LEFT JOIN e ON e.day=d.day ORDER BY d.day";

  // --- warehouse movements: period on created_at + product/order filters ---
  const pRcpt:unknown[]=[];const rcptW:string[]=["TRUE"];
  if(hasPeriod){if(f.from){pRcpt.push(f.from);rcptW.push("wr.receipt_date>=$"+pRcpt.length+"::date")}if(f.to){pRcpt.push(f.to);rcptW.push("wr.receipt_date<=$"+pRcpt.length+"::date")}}
  else rcptW.push("wr.receipt_date=CURRENT_DATE");
  if(f.productId){pRcpt.push(f.productId);rcptW.push("wrl.product_id=$"+pRcpt.length)}
  const receiptsSql="SELECT COALESCE(SUM(quantity),0) AS quantity FROM warehouse_receipt_lines wrl JOIN warehouse_receipts wr ON wr.id=wrl.receipt_id WHERE "+rcptW.join(" AND ");

  const pDel:unknown[]=[];const delW:string[]=["movement_type='OUT'","reference_type='DELIVERY'"];
  if(hasPeriod){if(f.from){pDel.push(f.from);delW.push("created_at::date>=$"+pDel.length+"::date")}if(f.to){pDel.push(f.to);delW.push("created_at::date<=$"+pDel.length+"::date")}}
  else delW.push("created_at::date=CURRENT_DATE");
  if(f.productId){pDel.push(f.productId);delW.push("product_id=$"+pDel.length)}
  if(f.orderId){pDel.push(f.orderId);delW.push("order_id=$"+pDel.length)}
  const deliveriesSql="SELECT COALESCE(SUM(quantity),0) AS quantity FROM stock_movements WHERE "+delW.join(" AND ");

  const pWd:unknown[]=[];const wdW:string[]=["sm.movement_type='OUT'","sm.reference_type='SHIFT_WITHDRAWAL'"];
  if(hasPeriod){if(f.from){pWd.push(f.from);wdW.push("sm.created_at::date>=$"+pWd.length+"::date")}if(f.to){pWd.push(f.to);wdW.push("sm.created_at::date<=$"+pWd.length+"::date")}}
  else wdW.push("sm.created_at::date=CURRENT_DATE");
  if(f.productId){pWd.push(f.productId);wdW.push("sm.product_id=$"+pWd.length)}
  const withdrawalsSql="SELECT COUNT(DISTINCT sm.reference_id)::int AS count,COALESCE(SUM(sm.quantity),0) AS quantity,COALESCE(SUM(sm.total_cost),0) AS value FROM stock_movements sm WHERE "+wdW.join(" AND ");

  const [production,earnings,stock,payments,advances,revenue,expenses,receiptsToday,deliveriesToday,pendingProduction,orders,productionTrend,financeTrend,orderStatus,topProducts,overdueOrders,overdueOrdersList,lowStock,withdrawalsToday,scrap7d,topWorkers]=await Promise.all([
   pool.query(productionSql,pProduction),
   pool.query(earningsSql,pEarn),
   pool.query("SELECT COUNT(*)::int AS lines,COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(inventory_value),0) AS value FROM stock_balances WHERE quantity>0"),
   pool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status='PENDING'"),
   pool.query("SELECT COUNT(*)::int AS count FROM advance_requests WHERE status='PENDING'"),
   pool.query(revenueSql,pRev),
   pool.query(expensesSql,pExp),
   pool.query(receiptsSql,pRcpt),
   pool.query(deliveriesSql,pDel),
   pool.query("SELECT COUNT(*)::int AS count FROM production_entries WHERE status='PENDING'"),
   pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE status IN ('PLANNED','IN_PROGRESS'))::int AS active,COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed FROM production_orders"),
   pool.query(productionTrendSql,pTrend),
   pool.query(financeTrendSql,pFinTrend),
   pool.query("SELECT status,COUNT(*)::int AS count FROM production_orders GROUP BY status ORDER BY status"),
   pool.query(topProductsSql,pTop),
   pool.query("SELECT COUNT(*)::int AS count FROM production_orders WHERE due_date<CURRENT_DATE AND status NOT IN ('COMPLETED','CANCELLED')"),
   pool.query("SELECT code,order_name,customer_name,due_date FROM production_orders WHERE due_date<CURRENT_DATE AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY due_date ASC LIMIT 5"),
   pool.query("SELECT code,name,minimum_stock AS minimum,COALESCE((SELECT SUM(b.quantity) FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.product_id=p.id AND w.is_active=TRUE AND w.warehouse_type<>'SCRAP'),0) AS quantity FROM products p WHERE p.is_active=TRUE AND p.track_inventory=TRUE AND p.minimum_stock>0 AND COALESCE((SELECT SUM(b.quantity) FROM stock_balances b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.product_id=p.id AND w.is_active=TRUE AND w.warehouse_type<>'SCRAP'),0)<=p.minimum_stock ORDER BY quantity ASC LIMIT 5"),
   pool.query(withdrawalsSql,pWd),
   pool.query(scrapFinal,pScrap),
   pool.query(topWorkersSql,pWorkers)
  ]);
  const scrapGross=Number(scrap7d.rows[0].gross||0),scrapQty=Number(scrap7d.rows[0].scrap||0);
  const revenueValue=Number(revenue.rows[0].value||0),expenseValue=Number(expenses.rows[0].value||0);
  return {data:{
    filters:{from:f.from,to:f.to,product_id:f.productId,order_id:f.orderId,employee_id:f.employeeId,stage_id:f.stageId,period:hasPeriod?"custom":"default"},
    production:production.rows[0],earnings:earnings.rows[0],stock:stock.rows[0],
    finance:{revenue:revenueValue,expenses:expenseValue,net:revenueValue-expenseValue},
    warehouse:{receiptsToday:receiptsToday.rows[0].quantity,deliveriesToday:deliveriesToday.rows[0].quantity},
    pendingProduction:pendingProduction.rows[0].count,pendingPayments:payments.rows[0].count,pendingAdvances:advances.rows[0].count,
    orders:orders.rows[0],productionTrend:productionTrend.rows,financeTrend:financeTrend.rows,orderStatus:orderStatus.rows,topProducts:topProducts.rows,
    overdueOrders:{count:overdueOrders.rows[0].count,items:overdueOrdersList.rows},
    lowStock:{count:lowStock.rows.length,items:lowStock.rows},
    withdrawalsToday:{count:withdrawalsToday.rows[0].count,quantity:withdrawalsToday.rows[0].quantity,value:withdrawalsToday.rows[0].value},
    scrap7d:{scrap:scrapQty,gross:scrapGross,ratio:scrapGross>0?scrapQty/scrapGross:0},
    topWorkers:topWorkers.rows
  }};
 });
}
