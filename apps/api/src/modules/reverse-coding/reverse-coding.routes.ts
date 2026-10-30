import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";
import { writeAudit } from "../audit/audit.service.js";
import { classifyReverseCodeScan } from "./reverse-coding.logic.js";

const createSchema=z.object({packagingType:z.string().trim().min(2).max(100),productId:z.string().uuid(),displayProductName:z.string().trim().min(1).max(180).nullable().optional(),codeCount:z.number().int().positive().max(5000),piecesPerCode:z.number().int().positive().max(1000000),weightMinKg:z.number().nonnegative().max(100000).nullable().optional(),weightMaxKg:z.number().nonnegative().max(100000).nullable().optional(),notes:z.string().trim().max(1000).nullable().optional()}).refine(v=>v.weightMinKg==null||v.weightMaxKg==null||v.weightMinKg<=v.weightMaxKg,{message:'الحد الأدنى للوزن يجب ألا يتجاوز الحد الأقصى'}).refine(v=>v.codeCount*v.piecesPerCode<=10000000,{message:'إجمالي القطع يتجاوز الحد المسموح'});
async function audit(client:any,request:any,action:string,type:string,id:string|null,beforeData?:unknown,afterData?:unknown){
 await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action,module:"reverse_coding",entityType:type,entityId:id,beforeData,afterData,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
}
export async function reverseCodingRoutes(app:FastifyInstance){
 app.get("/api/reverse-coding/bootstrap",{preHandler:[authenticateRequest,requirePermission("reverse_coding.view")]},async()=>{
  const [products,orders,employees,settings,labelSettings]=await Promise.all([
   pool.query("SELECT id,code,name FROM products WHERE is_active=TRUE ORDER BY name"),
   pool.query("SELECT id,code,order_name FROM production_orders ORDER BY created_at DESC LIMIT 500"),
   pool.query("SELECT id,code,full_name AS name FROM employees WHERE is_active=TRUE ORDER BY full_name"),
   pool.query("SELECT setting_value FROM reverse_code_settings WHERE setting_key='company'"),
   pool.query("SELECT setting_value FROM reverse_code_settings WHERE setting_key='label_layout'")
  ]);
  return {data:{products:products.rows,orders:orders.rows,employees:employees.rows,company:settings.rows[0]?.setting_value??{},labelSettings:labelSettings.rows[0]?.setting_value??{width:80,height:50,margin:2}}};
 });
 app.put("/api/reverse-coding/company-settings",{preHandler:[authenticateRequest,requirePermission("reverse_coding.manage")]},async request=>{
  const p=z.object({companyName:z.string().trim().min(2).max(160),address:z.string().trim().max(300).nullable().optional(),phone:z.string().trim().max(60).nullable().optional(),logoUrl:z.string().trim().max(1000).nullable().optional()}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الشركة غير صحيحة",422);
  const saved=await withTransaction(async c=>{
   const r=await c.query("INSERT INTO reverse_code_settings(setting_key,setting_value,updated_by) VALUES('company',$1::jsonb,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING setting_value",[JSON.stringify(p.data),request.user!.userId]);
   await audit(c,request,"update_company_label_settings","reverse_code_settings",null,undefined,r.rows[0].setting_value);return r.rows[0].setting_value;
  });return {data:saved};
 });
 app.put("/api/reverse-coding/label-settings",{preHandler:[authenticateRequest,requirePermission("reverse_coding.manage")]},async request=>{
  const p=z.object({width:z.number().min(20).max(300),height:z.number().min(15).max(300),margin:z.number().min(0).max(10)}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","مقاس الملصق غير صحيح",422);
  const saved=await withTransaction(async c=>{
   const r=await c.query("INSERT INTO reverse_code_settings(setting_key,setting_value,updated_by) VALUES('label_layout',$1::jsonb,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING setting_value",[JSON.stringify(p.data),request.user!.userId]);
   await audit(c,request,"update_label_layout","reverse_code_settings",null,undefined,r.rows[0].setting_value);return r.rows[0].setting_value;
  });return {data:saved};
 });
 app.get("/api/reverse-coding/groups",{preHandler:[authenticateRequest,requirePermission("reverse_coding.view")]},async request=>{
  const q=String((request.query as any)?.search??"").trim();
  const r=await pool.query(`SELECT g.*,p.name product_name,p.code product_code,o.code order_code,o.order_name,
   (SELECT COUNT(*)::int FROM reverse_codes c WHERE c.group_id=g.id) generated_codes,
   (SELECT COUNT(*)::int FROM reverse_codes c WHERE c.group_id=g.id AND c.first_printed_at IS NOT NULL) printed_codes
   FROM reverse_code_groups g LEFT JOIN products p ON p.id=g.product_id LEFT JOIN production_orders o ON o.id=g.order_id
   WHERE ($1='' OR g.name ILIKE '%'||$1||'%' OR g.packaging_type ILIKE '%'||$1||'%' OR o.code ILIKE '%'||$1||'%')
   ORDER BY g.created_at DESC LIMIT 300`,[q]);return {data:r.rows};
 });
 app.post("/api/reverse-coding/groups",{preHandler:[authenticateRequest,requirePermission("reverse_coding.manage")]},async(request,reply)=>{
  const parsed=createSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات مجموعة الأكواد غير صحيحة",422);
  const p=parsed.data;
  if(p.displayProductName){const client=await pool.connect();try{if(!await hasPermission(client,request.user!.userId,"reverse_coding.rename_product_label","all"))throw new AppError("FORBIDDEN","ليس لديك صلاحية تغيير اسم المنتج الظاهر على الملصق",403);}finally{client.release();}}
  if(p.productId&&!(await pool.query("SELECT 1 FROM products WHERE id=$1 AND is_active=TRUE",[p.productId])).rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج المحدد غير موجود",422);
  const created=await withTransaction(async c=>{
   const n=Number((await c.query("SELECT nextval('reverse_code_number_seq') n")).rows[0].n),totalQuantity=p.codeCount*p.piecesPerCode,quantities=Array.from({length:p.codeCount},()=>p.piecesPerCode),count=quantities.length;
   const g=(await c.query("INSERT INTO reverse_code_groups(group_number,name,packaging_type,product_id,order_id,total_quantity,pieces_per_code,code_count,created_by,notes,display_product_name,weight_min_kg,weight_max_kg) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",[n,"تشغيل "+n,p.packagingType,p.productId,totalQuantity,p.piecesPerCode,count,request.user!.userId,p.notes??null,p.displayProductName?.trim()||null,p.weightMinKg??null,p.weightMaxKg??null])).rows[0];
   const codes=(await c.query(`WITH source AS MATERIALIZED (
     SELECT quantity,ord FROM unnest($2::integer[]) WITH ORDINALITY AS items(quantity,ord) ORDER BY ord
    ), numbered AS MATERIALIZED (
     SELECT nextval('reverse_code_number_seq') AS code_number,quantity,ord FROM source
    )
    INSERT INTO reverse_codes(group_id,code_number,code,quantity,weight_grams)
    SELECT $1,code_number,'RVC-'||to_char(current_date,'YY')||'-'||lpad(code_number::text,8,'0'),quantity,$3
    FROM numbered ORDER BY ord
    RETURNING id,code,quantity,weight_grams,status,first_printed_at`,[g.id,quantities,null])).rows;
   await audit(c,request,"create","reverse_code_group",g.id,undefined,{group:g,codeCount:codes.length,firstCode:codes[0]?.code??null,lastCode:codes[codes.length-1]?.code??null});return {...g,codes};
  });return reply.code(201).send({data:created});
 });
 app.get("/api/reverse-coding/groups/:id",{preHandler:[authenticateRequest,requirePermission("reverse_coding.view")]},async request=>{
  const id=String((request.params as any).id),g=await pool.query("SELECT g.*,p.name product_name,p.code product_code,o.code order_code,o.order_name FROM reverse_code_groups g LEFT JOIN products p ON p.id=g.product_id LEFT JOIN production_orders o ON o.id=g.order_id WHERE g.id=$1",[id]);
  if(!g.rowCount)throw new AppError("GROUP_NOT_FOUND","مجموعة الأكواد غير موجودة",404);
  const codes=await pool.query(`SELECT c.*,COALESCE(json_agg(json_build_object('id',e.id,'name',e.full_name,'code',e.code)) FILTER(WHERE e.id IS NOT NULL),'[]') employees
   FROM reverse_codes c LEFT JOIN reverse_code_workers w ON w.code_id=c.id LEFT JOIN employees e ON e.id=w.employee_id
   WHERE c.group_id=$1 GROUP BY c.id ORDER BY c.code_number`,[id]);return {data:{...g.rows[0],codes:codes.rows}};
 });
 app.patch("/api/reverse-coding/codes/:id/metadata",{preHandler:[authenticateRequest,requirePermission("reverse_coding.manage")]},async request=>{
  const id=String((request.params as any).id),p=z.object({notes:z.string().trim().max(1000).nullable().optional(),weightGrams:z.number().nonnegative().max(1000000).nullable().optional(),employeeIds:z.array(z.string().uuid()).max(50).optional()}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الوزن أو العمال أو الملاحظات غير صحيحة",422);
  return withTransaction(async c=>{
   const current=await c.query("SELECT c.* FROM reverse_codes c WHERE c.id=$1 FOR UPDATE", [id]);
   const previousWorkers=await c.query("SELECT employee_id FROM reverse_code_workers WHERE code_id=$1 ORDER BY employee_id",[id]);
   if(!current.rowCount)throw new AppError("CODE_NOT_FOUND","الكود غير موجود",404);
   if(p.data.weightGrams!==undefined){if(current.rows[0].first_printed_at)throw new AppError("PRINTED_CODE_LOCKED","لا يمكن تعديل وزن الكود بعد طباعته",409);await c.query("UPDATE reverse_codes SET weight_grams=$1,updated_at=now() WHERE id=$2",[p.data.weightGrams,id]);}
   if(p.data.employeeIds){const ids=[...new Set(p.data.employeeIds)],valid=await c.query("SELECT id FROM employees WHERE id=ANY($1::uuid[]) AND is_active=TRUE",[ids]);if(valid.rowCount!==ids.length)throw new AppError("EMPLOYEE_NOT_FOUND","يوجد عامل غير موجود أو غير نشط",422);await c.query("DELETE FROM reverse_code_workers WHERE code_id=$1",[id]);for(const eid of ids)await c.query("INSERT INTO reverse_code_workers(code_id,employee_id) VALUES($1,$2)",[id,eid]);}
   if(p.data.notes!==undefined)await c.query("UPDATE reverse_codes SET notes=$1,updated_at=now() WHERE id=$2",[p.data.notes,id]);
   const workers=await c.query("SELECT e.id,e.full_name name,e.code FROM reverse_code_workers w JOIN employees e ON e.id=w.employee_id WHERE w.code_id=$1",[id]);
   await audit(c,request,"update_metadata","reverse_code",id,{notes:current.rows[0].notes,weightGrams:current.rows[0].weight_grams,employeeIds:previousWorkers.rows.map((x:any)=>x.employee_id)},{notes:p.data.notes!==undefined?p.data.notes:current.rows[0].notes,weightGrams:p.data.weightGrams!==undefined?p.data.weightGrams:current.rows[0].weight_grams,employees:workers.rows});
   return {data:{id,notes:p.data.notes!==undefined?p.data.notes:current.rows[0].notes,weightGrams:p.data.weightGrams!==undefined?p.data.weightGrams:current.rows[0].weight_grams,employees:workers.rows}};
  });
 });
 app.post("/api/reverse-coding/print",{preHandler:[authenticateRequest,requirePermission("reverse_coding.print")]},async request=>{
  const p=z.object({codeIds:z.array(z.string().uuid()).min(1).max(5000)}).safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","حدد كودًا واحدًا على الأقل للطباعة",422);
  const ids=[...new Set(p.data.codeIds)];return withTransaction(async c=>{
   const rows=await c.query(`SELECT c.*,g.packaging_type,g.notes group_notes,g.product_id,g.display_product_name,g.weight_min_kg,g.weight_max_kg,p.name product_name,p.code product_code,o.code order_code,o.order_name,cr.display_product_name AS carton_display_product_name,s.setting_value company
    FROM reverse_codes c JOIN reverse_code_groups g ON g.id=c.group_id LEFT JOIN products p ON p.id=g.product_id LEFT JOIN production_orders o ON o.id=g.order_id LEFT JOIN reverse_code_carton_records cr ON cr.code_id=c.id
    LEFT JOIN reverse_code_settings s ON s.setting_key='company' WHERE c.id=ANY($1::uuid[]) AND c.status='ACTIVE' ORDER BY c.code_number FOR UPDATE OF c`,[ids]);
   if(rows.rowCount!==ids.length)throw new AppError("CODE_NOT_PRINTABLE","بعض الأكواد غير موجودة أو غير نشطة",409);
   const result=[];for(const r of rows.rows){const snap=r.print_snapshot??{code:r.code,quantity:r.quantity,weightGrams:r.weight_grams,createdAt:r.created_at,packagingType:r.packaging_type,productName:r.carton_display_product_name||r.display_product_name||r.product_name,productId:r.product_id,weightMinKg:r.weight_min_kg,weightMaxKg:r.weight_max_kg,productCode:r.product_code,orderCode:r.order_code,orderName:r.order_name,company:r.company??{}},reprint=Boolean(r.first_printed_at);
    await c.query("UPDATE reverse_codes SET print_snapshot=$1::jsonb,first_printed_at=COALESCE(first_printed_at,now()),last_printed_at=now(),print_count=print_count+1,updated_at=now() WHERE id=$2",[JSON.stringify(snap),r.id]);
    await c.query("INSERT INTO reverse_code_print_logs(code_id,printed_by,reprint) VALUES($1,$2,$3)",[r.id,request.user!.userId,reprint]);result.push({id:r.id,snapshot:snap});}
   await audit(c,request,"print","reverse_codes",ids[0]??null,undefined,{count:result.length});return {data:result};
  });
 });
 app.post("/api/reverse-coding/scan",{preHandler:[authenticateRequest,requirePermission("reverse_coding.scan")]},async request=>{
  const p=z.object({values:z.array(z.string().trim().min(1).max(200)).min(1).max(200),sessionId:z.string().uuid().nullable().optional()}).safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات المسح غير صحيحة",422);
  return withTransaction(async c=>{const seen=new Set<string>(),out=[];for(const value of p.data.values){const duplicate=seen.has(value);seen.add(value);
   const f=await c.query(`SELECT c.id,c.code,c.quantity,c.weight_grams,c.status,c.first_printed_at,c.created_at,g.id group_id,g.name,g.packaging_type,g.product_id,g.order_id,g.notes,g.display_product_name,g.weight_min_kg,g.weight_max_kg,p.name product_name,p.code product_code,o.code order_code,o.order_name
    FROM reverse_codes c JOIN reverse_code_groups g ON g.id=c.group_id LEFT JOIN products p ON p.id=g.product_id LEFT JOIN production_orders o ON o.id=g.order_id WHERE c.code=$1 LIMIT 1`,[value]),row=f.rows[0]??null;
   const alreadyScanned=Boolean(!duplicate&&p.data.sessionId&&(await c.query("SELECT 1 FROM reverse_code_scan_logs WHERE session_id=$1 AND scanned_value=$2 LIMIT 1",[p.data.sessionId,value])).rowCount);
   const result=classifyReverseCodeScan({duplicateInRequest:duplicate,alreadyScannedInSession:alreadyScanned,codeStatus:row?.status??null});
   await c.query("INSERT INTO reverse_code_scan_logs(code_id,scanned_value,session_id,result,scanned_by) VALUES($1,$2,$3,$4,$5)",[row?.id??null,value,p.data.sessionId??null,result,request.user!.userId]);const carton=row?await c.query("SELECT * FROM reverse_code_carton_records WHERE code_id=$1",[row.id]):{rows:[]};out.push({value,result,code:row,carton:carton.rows[0]??null});}return {data:out};});
 });
 app.post("/api/reverse-coding/codes/:id/carton",{preHandler:[authenticateRequest,requirePermission("reverse_coding.scan")]},async request=>{
  const id=String((request.params as any).id);
  const p=z.object({productId:z.string().uuid(),displayProductName:z.string().trim().min(1).max(180).nullable().optional(),productionPartnerEmployeeId:z.string().uuid().nullable().optional(),packerEmployeeId:z.string().uuid().nullable().optional(),packerPartnerEmployeeId:z.string().uuid().nullable().optional(),actualWeightKg:z.number().nonnegative().max(100000).nullable().optional(),notes:z.string().trim().max(1000).nullable().optional()}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الكرتونة غير صحيحة",422);
  return withTransaction(async c=>{
   const code=await c.query("SELECT c.id,c.code,c.quantity,c.status,g.product_id,g.display_product_name,p.name product_name FROM reverse_codes c JOIN reverse_code_groups g ON g.id=c.group_id LEFT JOIN products p ON p.id=g.product_id WHERE c.id=$1 FOR UPDATE OF c",[id]);
   if(!code.rowCount)throw new AppError("CODE_NOT_FOUND","الكود غير موجود",404);
   if(code.rows[0].status!=="ACTIVE")throw new AppError("CODE_NOT_ACTIVE","الكود غير نشط",409);
   const product=await c.query("SELECT id,name FROM products WHERE id=$1 AND is_active=TRUE",[p.data.productId]);
   if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج المحدد غير موجود أو غير نشط",422);
   if(product.rows[0].id!==code.rows[0].product_id)throw new AppError("PRODUCT_MISMATCH","لا يمكن تغيير المنتج الرئيسي المرتبط بالكود",409);
   const ids=[p.data.productionPartnerEmployeeId,p.data.packerEmployeeId,p.data.packerPartnerEmployeeId].filter(Boolean);
   if(ids.length){const valid=await c.query("SELECT id FROM employees WHERE id=ANY($1::uuid[]) AND is_active=TRUE",[ids]);if(valid.rowCount!==new Set(ids).size)throw new AppError("EMPLOYEE_NOT_FOUND","يوجد عامل غير موجود أو غير نشط",422);}
   if(!p.data.packerEmployeeId)throw new AppError("PACKER_REQUIRED","يجب تحديد القائم بالتقفيل",422);
   if(p.data.displayProductName?.trim() && !await hasPermission(c,request.user!.userId,"reverse_coding.rename_product_label","all"))throw new AppError("FORBIDDEN","ليس لديك صلاحية تغيير اسم المنتج الظاهر على الملصق",403);
   const display=p.data.displayProductName?.trim()||code.rows[0].display_product_name||product.rows[0].name;
   
   const saved=await c.query("INSERT INTO reverse_code_carton_records(code_id,product_id,display_product_name,production_partner_employee_id,packer_employee_id,packer_partner_employee_id,coded_by,received_by,actual_weight_kg,notes,saved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$7) ON CONFLICT(code_id) DO UPDATE SET product_id=EXCLUDED.product_id,display_product_name=EXCLUDED.display_product_name,production_partner_employee_id=EXCLUDED.production_partner_employee_id,packer_employee_id=EXCLUDED.packer_employee_id,packer_partner_employee_id=EXCLUDED.packer_partner_employee_id,actual_weight_kg=EXCLUDED.actual_weight_kg,notes=EXCLUDED.notes,saved_by=EXCLUDED.saved_by,updated_at=now() RETURNING *",[id,p.data.productId,display,p.data.productionPartnerEmployeeId??null,p.data.packerEmployeeId??null,p.data.packerPartnerEmployeeId??null,request.user!.userId,p.data.actualWeightKg??null,p.data.notes??null]);
   await audit(c,request,"save_carton_record","reverse_code_carton_record",saved.rows[0].id,undefined,saved.rows[0]);
   return {data:{...saved.rows[0],code:code.rows[0].code,product_name:product.rows[0].name}};
  });
 });
 app.get("/api/reverse-coding/scans",{preHandler:[authenticateRequest,requirePermission("reverse_coding.view")]},async()=>{const r=await pool.query("SELECT l.*,c.code,g.name group_name,u.username FROM reverse_code_scan_logs l LEFT JOIN reverse_codes c ON c.id=l.code_id LEFT JOIN reverse_code_groups g ON g.id=c.group_id LEFT JOIN users u ON u.id=l.scanned_by ORDER BY l.scanned_at DESC LIMIT 500");return {data:r.rows};});
}
