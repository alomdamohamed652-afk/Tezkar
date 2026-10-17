import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

const cartonSchema=z.object({productId:z.string().uuid(),warehouseId:z.string().uuid(),locationId:z.string().uuid(),quantity:z.number().nonnegative(),barcode:z.string().trim().max(120).nullable().optional(),weight:z.number().nonnegative().nullable().optional(),batchCode:z.string().trim().max(100).nullable().optional(),status:z.enum(["OPEN","SEALED","PARTIAL"]).default("OPEN")});
const deliverySchema=z.object({orderId:z.string().uuid(),destination:z.string().trim().min(2).max(200),notes:z.string().trim().max(500).nullable().optional(),deliveryValue:z.number().nonnegative().nullable().optional(),totalWeight:z.number().nonnegative().nullable().optional(),pieceCount:z.number().nonnegative().nullable().optional(),sampleQuantity:z.number().nonnegative().nullable().optional(),details:z.string().trim().max(2000).nullable().optional(),lines:z.array(z.object({orderItemId:z.string().uuid().optional(),productId:z.string().uuid(),warehouseId:z.string().uuid(),locationId:z.string().uuid(),quantity:z.number().positive(),cartonCode:z.string().trim().max(100).nullable().optional(),cartonWeight:z.number().nonnegative().nullable().optional(),pieceCount:z.number().nonnegative().nullable().optional(),sampleQuantity:z.number().nonnegative().nullable().optional(),details:z.string().trim().max(1000).nullable().optional()})).min(1).max(100)});
const releaseSchema=z.object({scanCode:z.string().trim().min(4).max(100)});

async function assertLocation(client:import("pg").PoolClient,w:string,l:string){const r=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[l,w]);if(!r.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);}
async function changeBalance(client:import("pg").PoolClient,p:string,w:string,l:string,delta:number){
 const r=await client.query("SELECT quantity,avg_unit_cost,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[p,w,l]);
 const current=Number(r.rows[0]?.quantity??0),avg=Number(r.rows[0]?.avg_unit_cost??0),value=Number(r.rows[0]?.inventory_value??0),next=current+delta;
 if(next<0)throw new AppError("INSUFFICIENT_STOCK","الرصيد غير كافٍ لتنفيذ إذن التسليم",409);
 const totalCost=Math.abs(delta)*avg;
 const nextValue=delta<0?Math.max(0,value-totalCost):value+totalCost;
 const nextAvg=next>0?nextValue/next:0;
 if(r.rowCount)await client.query("UPDATE stock_balances SET quantity=$1,avg_unit_cost=$2,inventory_value=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",[next,nextAvg,nextValue,p,w,l]);
 else if(delta>0)await client.query("INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value) VALUES($1,$2,$3,$4,$5,$6)",[p,w,l,next,avg,nextValue]);
 return {unitCost:avg,totalCost};
}

export async function cartonDeliveryRoutes(app:FastifyInstance){
 app.get("/api/warehouse/cartons",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
  const r=await pool.query("SELECT c.*,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM cartons c JOIN products p ON p.id=c.product_id JOIN warehouses w ON w.id=c.warehouse_id JOIN warehouse_locations l ON l.id=c.location_id JOIN units u ON u.id=c.unit_id ORDER BY c.created_at DESC LIMIT 300");
  return {data:r.rows};
 });

 app.post("/api/warehouse/cartons",{preHandler:[authenticateRequest,requireAnyPermission(["cartons.manage","all"],["cartons.create","all"])]},async(request,reply)=>{
  const parsed=cartonSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات الكرتونة غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[parsed.data.productId]);if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود",422);
   await assertLocation(client,parsed.data.warehouseId,parsed.data.locationId);
   const quantity=Number(parsed.data.quantity);
   if(quantity<=0)throw new AppError("INVALID_QUANTITY","كمية الكرتونة يجب أن تكون أكبر من صفر",422);
   const stock=await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId]);
   if(Number(stock.rows[0]?.quantity??0)<quantity)throw new AppError("INSUFFICIENT_STOCK","الرصيد المتاح أقل من كمية الكرتونة",409);
   const r=await client.query("INSERT INTO cartons(barcode,product_id,warehouse_id,location_id,quantity,unit_id,weight,batch_code,status,sealed_at,sealed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[parsed.data.barcode??null,parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId,quantity,product.rows[0].unit_id,parsed.data.weight??null,parsed.data.batchCode??null,parsed.data.status,parsed.data.status==="SEALED"?new Date():null,parsed.data.status==="SEALED"?request.user!.userId:null]);
   const created=r.rows[0];
   let finalCarton=created;
   if(!finalCarton.barcode){
    const barcode=finalCarton.code;
    const updated=await client.query("UPDATE cartons SET barcode=$1,updated_at=now() WHERE id=$2 RETURNING *",[barcode,finalCarton.id]);
    finalCarton=updated.rows[0];
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"carton",entityId:finalCarton.id,afterData:finalCarton,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return finalCarton;
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/delivery-permissions",{preHandler:[authenticateRequest,requirePermission("deliveries.view")]},async()=>{
  const r=await pool.query(`SELECT d.*,COUNT(l.id)::int AS line_count,o.code AS order_code,o.order_name,
    COALESCE(json_agg(jsonb_build_object('id',l.id,'order_item_id',l.order_item_id,'product_id',l.product_id,'warehouse_id',l.warehouse_id,'location_id',l.location_id,'product_code',p.code,'product_name',p.name,'quantity',l.quantity,'carton_code',l.carton_code,'carton_weight',l.carton_weight,'piece_count',l.piece_count,'sample_quantity',l.sample_quantity,'details',l.details,'unit_name',u.name) ORDER BY p.name) FILTER (WHERE l.id IS NOT NULL),'[]') AS lines
    FROM delivery_permissions d LEFT JOIN production_orders o ON o.id=d.order_id
    LEFT JOIN delivery_permission_lines l ON l.delivery_permission_id=d.id
    LEFT JOIN products p ON p.id=l.product_id LEFT JOIN units u ON u.id=l.unit_id
    GROUP BY d.id,o.code,o.order_name ORDER BY d.created_at DESC LIMIT 300`);
  return {data:r.rows};
 });


 // Server-persisted continuous-scan drafts. Drafts do not reserve stock until they are marked READY.
 const draftHeaderSchema=z.object({orderId:z.string().uuid(),destination:z.string().trim().min(2).max(200),notes:z.string().trim().max(500).nullable().optional(),deliveryValue:z.number().nonnegative().nullable().optional(),totalWeight:z.number().nonnegative().nullable().optional(),pieceCount:z.number().nonnegative().nullable().optional(),sampleQuantity:z.number().nonnegative().nullable().optional(),details:z.string().trim().max(2000).nullable().optional()});
 const draftScanSchema=z.object({cartonCode:z.string().trim().min(1).max(120),warehouseId:z.string().uuid().optional(),locationId:z.string().uuid().optional()});
 app.get("/api/delivery-permissions/drafts/active",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request)=>{
  const parsed=z.object({orderId:z.string().uuid()}).safeParse(request.query);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","رقم الطلبية غير صحيح",422);
  const result=await pool.query(`SELECT d.*,COALESCE(json_agg(jsonb_build_object('id',l.id,'order_item_id',l.order_item_id,'product_id',l.product_id,'warehouse_id',l.warehouse_id,'location_id',l.location_id,'product_code',p.code,'product_name',p.name,'quantity',l.quantity,'carton_code',l.carton_code,'carton_weight',l.carton_weight,'piece_count',l.piece_count,'sample_quantity',l.sample_quantity,'details',l.details,'unit_name',u.name) ORDER BY l.created_at) FILTER (WHERE l.id IS NOT NULL),'[]') AS lines
   FROM delivery_permissions d LEFT JOIN delivery_permission_lines l ON l.delivery_permission_id=d.id LEFT JOIN products p ON p.id=l.product_id LEFT JOIN units u ON u.id=l.unit_id
   WHERE d.order_id=$1 AND d.created_by=$2 AND d.status='DRAFT'
   GROUP BY d.id ORDER BY d.updated_at DESC LIMIT 1`,[parsed.data.orderId,request.user!.userId]);
  return {data:result.rows[0]??null};
 });
 app.post("/api/delivery-permissions/drafts",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request,reply)=>{
  const parsed=draftHeaderSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات مسودة التسليم غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[parsed.data.orderId]);
   if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
   if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن إنشاء مسودة لطلبية ملغاة",409);
   const existing=await client.query("SELECT * FROM delivery_permissions WHERE order_id=$1 AND created_by=$2 AND status='DRAFT' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[parsed.data.orderId,request.user!.userId]);
   if(existing.rowCount){
    const updated=await client.query("UPDATE delivery_permissions SET destination=$1,notes=$2,delivery_value=$3,total_weight=$4,piece_count=$5,sample_quantity=$6,details=$7,updated_at=now() WHERE id=$8 RETURNING *",[parsed.data.destination,parsed.data.notes??null,parsed.data.deliveryValue??null,parsed.data.totalWeight??null,parsed.data.pieceCount??null,parsed.data.sampleQuantity??null,parsed.data.details??null,existing.rows[0].id]);
    return updated.rows[0];
   }
   const created=await client.query("INSERT INTO delivery_permissions(order_id,destination,notes,delivery_value,total_weight,piece_count,sample_quantity,details,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9) RETURNING *",[parsed.data.orderId,parsed.data.destination,parsed.data.notes??null,parsed.data.deliveryValue??null,parsed.data.totalWeight??null,parsed.data.pieceCount??null,parsed.data.sampleQuantity??null,parsed.data.details??null,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"delivery_permission_draft",entityId:created.rows[0].id,afterData:created.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return created.rows[0];
  });
  return reply.code(201).send({data:row});
 });
 app.post("/api/delivery-permissions/:id/scan",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request,reply)=>{
  const id=(request.params as {id:string}).id;const parsed=draftScanSchema.safeParse(request.body);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","كود الكرتونة مطلوب",422);
  const row=await withTransaction(async(client)=>{
   const draft=await client.query("SELECT * FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);
   if(!draft.rowCount)throw new AppError("NOT_FOUND","مسودة التسليم غير موجودة",404);
   if(draft.rows[0].created_by!==request.user!.userId)throw new AppError("FORBIDDEN","لا يمكنك تعديل مسودة أنشأها مستخدم آخر",403);
   if(draft.rows[0].status!=="DRAFT")throw new AppError("INVALID_STATUS","المسودة لم تعد مفتوحة للمسح",409);
   const code=parsed.data.cartonCode.trim();
   if(Boolean(parsed.data.warehouseId)!==Boolean(parsed.data.locationId))throw new AppError("VALIDATION_ERROR","اختر المخزن والمكان معًا",422);
   const duplicate=await client.query("SELECT 1 FROM delivery_permission_lines WHERE delivery_permission_id=$1 AND upper(trim(carton_code))=upper(trim($2)) LIMIT 1",[id,code]);
   if(duplicate.rowCount)throw new AppError("DUPLICATE_CARTON_CODE","تم مسح الكرتونة بالفعل في هذه المسودة",409);
   const coding=await client.query("SELECT * FROM coding_units WHERE (code=$1 OR barcode=$1) FOR UPDATE",[code]);
   const cartons=coding.rowCount?null:await client.query("SELECT * FROM cartons WHERE (code=$1 OR barcode=$1) FOR UPDATE",[code]);
   const unit=coding.rowCount?coding.rows[0]:null;const box=cartons?.rowCount?cartons.rows[0]:null;const ref=unit??box;
   if(!ref)throw new AppError("CARTON_NOT_FOUND","كود الكرتونة غير موجود",404);
   if(unit&&["CANCELLED","OUT","DELIVERED","RESERVED"].includes(unit.status))throw new AppError("CARTON_UNAVAILABLE","الكرتونة غير متاحة للتسليم بالحالة الحالية",409);
   if(box&&["EMPTY","OPEN"].includes(box.status))throw new AppError("CARTON_UNAVAILABLE","الكرتونة غير مختومة أو فارغة ولا يمكن تسليمها",409);
   if(Number(ref.quantity)<=0)throw new AppError("CARTON_EMPTY","الكرتونة لا تحتوي على كمية متاحة",409);
   if(!ref.warehouse_id||!ref.location_id)throw new AppError("CARTON_LOCATION_REQUIRED","الكرتونة غير مرتبطة بمخزن ومكان تخزين",409);
   if(parsed.data.warehouseId&&parsed.data.warehouseId!==ref.warehouse_id||parsed.data.locationId&&parsed.data.locationId!==ref.location_id)throw new AppError("CARTON_LOCATION_MISMATCH","الكرتونة من مخزن أو مكان مختلف؛ أنشئ إذنًا منفصلًا لكل موقع تخزين",409);
   const orderLine=await client.query("SELECT id FROM production_order_lines WHERE order_id=$1 AND product_id=$2 ORDER BY id",[draft.rows[0].order_id,ref.product_id]);
   if(!orderLine.rowCount)throw new AppError("PRODUCT_NOT_IN_ORDER","منتج الكرتونة غير موجود ضمن الطلبية المحددة",409);
   if(orderLine.rowCount>1)throw new AppError("ORDER_ITEM_REQUIRED","المنتج مكرر في الطلبية؛ لا يمكن ربط الكرتونة تلقائيًا بسطر محدد",409);
   // Match both the canonical code and barcode so one physical carton cannot be added twice via aliases.
   const duplicateAlias=await client.query("SELECT 1 FROM delivery_permission_lines WHERE delivery_permission_id=$1 AND upper(trim(carton_code)) IN (upper(trim($2)),upper(trim($3))) LIMIT 1",[id,ref.code,ref.barcode]);
   if(duplicateAlias.rowCount)throw new AppError("DUPLICATE_CARTON_CODE","تم مسح الكرتونة بالفعل في هذه المسودة",409);
   const assigned=await client.query("SELECT 1 FROM delivery_permission_lines l JOIN delivery_permissions d ON d.id=l.delivery_permission_id WHERE upper(trim(l.carton_code)) IN (upper(trim($1)),upper(trim($2))) AND d.status IN ('DRAFT','READY') AND d.id<>$3 LIMIT 1",[ref.code,ref.barcode,id]);
   if(assigned.rowCount)throw new AppError("CARTON_ALREADY_ASSIGNED","الكرتونة موجودة في مسودة أو إذن تسليم آخر",409);
   const product=await client.query("SELECT unit_id,name,code FROM products WHERE id=$1 AND is_active=TRUE",[ref.product_id]);
   if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","منتج الكرتونة غير موجود أو غير نشط",409);
   const inserted=await client.query("INSERT INTO delivery_permission_lines(delivery_permission_id,order_item_id,product_id,warehouse_id,location_id,quantity,unit_id,carton_code,carton_weight,piece_count,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[id,orderLine.rows[0].id,ref.product_id,ref.warehouse_id,ref.location_id,ref.quantity,product.rows[0].unit_id,ref.code,ref.weight??null,ref.quantity,"إضافة بالمسح المستمر"]);
   await client.query("UPDATE delivery_permissions SET updated_at=now() WHERE id=$1",[id]);
   return {...inserted.rows[0],product_name:product.rows[0].name,product_code:product.rows[0].code,warehouse_id:ref.warehouse_id,location_id:ref.location_id};
  });
  return reply.code(201).send({data:row});
 });
 app.delete("/api/delivery-permissions/:id/scan/:lineId",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request)=>{
  const {id,lineId}=request.params as {id:string;lineId:string};
  await withTransaction(async(client)=>{
   const draft=await client.query("SELECT created_by,status FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);
   if(!draft.rowCount)throw new AppError("NOT_FOUND","مسودة التسليم غير موجودة",404);
   if(draft.rows[0].created_by!==request.user!.userId)throw new AppError("FORBIDDEN","لا يمكنك تعديل مسودة أنشأها مستخدم آخر",403);
   if(draft.rows[0].status!=="DRAFT")throw new AppError("INVALID_STATUS","المسودة لم تعد مفتوحة للتعديل",409);
   const deleted=await client.query("DELETE FROM delivery_permission_lines WHERE id=$1 AND delivery_permission_id=$2 RETURNING id",[lineId,id]);
   if(!deleted.rowCount)throw new AppError("NOT_FOUND","سطر الكرتونة غير موجود في المسودة",404);
   await client.query("UPDATE delivery_permissions SET updated_at=now() WHERE id=$1",[id]);
  });
  return {data:{deleted:true}};
 });
 app.post("/api/delivery-permissions/:id/ready",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const row=await withTransaction(async(client)=>{
   const d=await client.query("SELECT * FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);
   if(!d.rowCount)throw new AppError("NOT_FOUND","مسودة التسليم غير موجودة",404);
   if(d.rows[0].created_by!==request.user!.userId)throw new AppError("FORBIDDEN","لا يمكنك اعتماد مسودة أنشأها مستخدم آخر",403);
   if(d.rows[0].status!=="DRAFT")throw new AppError("INVALID_STATUS","المسودة لم تعد مفتوحة للاعتماد",409);
   const lines=await client.query("SELECT * FROM delivery_permission_lines WHERE delivery_permission_id=$1 ORDER BY id",[id]);
   if(!lines.rowCount)throw new AppError("EMPTY_DELIVERY_DRAFT","امسح كرتونة واحدة على الأقل قبل إنهاء المسودة",422);
   const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[d.rows[0].order_id]);
   if(!order.rowCount||order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","الطلبية غير موجودة أو ملغاة",409);
   const sums=new Map<string,number>();
   for(const line of lines.rows){
    await assertLocation(client,line.warehouse_id,line.location_id);
    const key=String(line.order_item_id);sums.set(key,(sums.get(key)??0)+Number(line.quantity));
    const coding=await client.query("SELECT * FROM coding_units WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.carton_code]);
    const carton=coding.rowCount?null:await client.query("SELECT * FROM cartons WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.carton_code]);
    const ref=coding.rowCount?coding.rows[0]:(carton?.rows[0]??null);
    if(!ref)throw new AppError("CARTON_NOT_FOUND","إحدى الكراتين لم تعد موجودة",409);
    if(ref.product_id!==line.product_id||ref.warehouse_id!==line.warehouse_id||ref.location_id!==line.location_id)throw new AppError("CARTON_MISMATCH","بيانات كرتونة تغيرت منذ المسح؛ أعد مراجعة المسودة",409);
    if((coding.rowCount&&["CANCELLED","OUT","DELIVERED","RESERVED"].includes(ref.status))||(!coding.rowCount&&["EMPTY","OPEN"].includes(ref.status))||Number(ref.quantity)<Number(line.quantity))throw new AppError("CARTON_UNAVAILABLE","إحدى الكراتين لم تعد متاحة بالكمية المطلوبة",409);
   }
   for(const [orderItemId,quantity] of sums){
    const orderLine=await client.query("SELECT id,product_id FROM production_order_lines WHERE id=$1 AND order_id=$2",[orderItemId,d.rows[0].order_id]);
    if(!orderLine.rowCount)throw new AppError("ORDER_ITEM_MISMATCH","سطر منتج لا يتبع الطلبية",409);
    if(lines.rows.some((line:any)=>String(line.order_item_id)===orderItemId&&line.product_id!==orderLine.rows[0].product_id))
     throw new AppError("ORDER_ITEM_MISMATCH","المنتج في مسودة التسليم لا يطابق المنتج المرتبط بسطر الطلبية",409);
    const produced=await client.query("SELECT COALESCE(SUM(pe.quantity),0) AS quantity FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.product_id=$2 AND pe.status='APPROVED' AND os.order_item_id=$3",[d.rows[0].order_id,orderLine.rows[0].product_id,orderItemId]);
    const reserved=await client.query("SELECT COALESCE(SUM(l.quantity),0) AS quantity FROM delivery_permission_lines l JOIN delivery_permissions p ON p.id=l.delivery_permission_id WHERE p.order_id=$1 AND l.product_id=$2 AND (l.order_item_id=$3 OR l.order_item_id IS NULL) AND p.status IN ('READY','RELEASED') AND p.id<>$4",[d.rows[0].order_id,orderLine.rows[0].product_id,orderItemId,id]);
    if(quantity>Number(produced.rows[0].quantity)-Number(reserved.rows[0].quantity)+1e-9)throw new AppError("DELIVERY_EXCEEDS_PRODUCTION","إجمالي الكراتين يتجاوز الإنتاج المعتمد المتبقي للطلبية",409);
   }
   const byLocation=new Map<string,number>();
   for(const line of lines.rows){const key=[line.product_id,line.warehouse_id,line.location_id].join(":");byLocation.set(key,(byLocation.get(key)??0)+Number(line.quantity));}
   for(const [key,quantity] of byLocation){const [productId,warehouseId,locationId]=key.split(":");const stock=await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[productId,warehouseId,locationId]);const reserved=await client.query("SELECT COALESCE(SUM(l.quantity),0) AS quantity FROM delivery_permission_lines l JOIN delivery_permissions p ON p.id=l.delivery_permission_id WHERE l.product_id=$1 AND l.warehouse_id=$2 AND l.location_id=$3 AND p.status='READY' AND p.id<>$4",[productId,warehouseId,locationId,id]);if(quantity>Number(stock.rows[0]?.quantity??0)-Number(reserved.rows[0].quantity)+1e-9)throw new AppError("DELIVERY_EXCEEDS_STOCK","إجمالي الكراتين يتجاوز رصيد المخزن المتاح",409);}
   const updated=await client.query("UPDATE delivery_permissions SET status='READY',updated_at=now() WHERE id=$1 RETURNING *",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"ready",module:"warehouse",entityType:"delivery_permission",entityId:id,afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });
 app.post("/api/delivery-permissions/:id/cancel-draft",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const row=await withTransaction(async(client)=>{
   const d=await client.query("SELECT * FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);
   if(!d.rowCount)throw new AppError("NOT_FOUND","المسودة غير موجودة",404);
   if(d.rows[0].created_by!==request.user!.userId)throw new AppError("FORBIDDEN","لا يمكنك إلغاء مسودة أنشأها مستخدم آخر",403);
   if(d.rows[0].status!=="DRAFT")throw new AppError("INVALID_STATUS","لا يمكن إلغاء سجل لم يعد مسودة",409);
   const updated=await client.query("UPDATE delivery_permissions SET status='CANCELLED',updated_at=now() WHERE id=$1 RETURNING *",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"cancel",module:"warehouse",entityType:"delivery_permission",entityId:id,afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });

 app.get("/api/delivery-permissions/availability",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request)=>{
  const parsed=z.object({orderId:z.string().uuid(),orderItemId:z.string().uuid().optional(),productId:z.string().uuid(),warehouseId:z.string().uuid().optional(),locationId:z.string().uuid().optional()}).safeParse(request.query);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات الاستعلام عن المتاح غير صحيحة",422);
  if(Boolean(parsed.data.warehouseId)!==Boolean(parsed.data.locationId))throw new AppError("VALIDATION_ERROR","اختر المخزن والمكان معًا لحساب المتاح في المخزن",422);
  const {orderId,orderItemId,productId,warehouseId,locationId}=parsed.data;
  const result=await withTransaction(async(client)=>{
   const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1",[orderId]);
   if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
   let orderLine;
   if(orderItemId){
    orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND id=$2 AND product_id=$3",[orderId,orderItemId,productId]);
    if(!orderLine.rowCount)throw new AppError("ORDER_ITEM_MISMATCH","سطر المنتج لا يتبع الطلبية أو لا يطابق الصنف",422);
   }else{
    orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND product_id=$2 ORDER BY id",[orderId,productId]);
    if((orderLine.rowCount??0)>1)throw new AppError("ORDER_ITEM_REQUIRED","الصنف مكرر في الطلبية؛ اختر سطر المنتج النهائي المحدد",422);
   }
   if(!orderLine.rowCount||Number(orderLine.rows[0]?.quantity??0)<=0)throw new AppError("PRODUCT_NOT_IN_ORDER","الصنف ليس ضمن الطلبية المحددة",422);
   const resolvedOrderItemId=orderLine.rows[0].id;
   const produced=await client.query(`SELECT COALESCE(SUM(pe.quantity),0) AS quantity
     FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id
     WHERE os.order_id=$1 AND pe.product_id=$2 AND pe.status='APPROVED' AND os.order_item_id=$3`,[orderId,productId,resolvedOrderItemId]);
   const reserved=await client.query(`SELECT COALESCE(SUM(dl.quantity),0) AS quantity
     FROM delivery_permission_lines dl JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id
     WHERE dp.order_id=$1 AND dl.product_id=$2 AND (dl.order_item_id=$3 OR dl.order_item_id IS NULL) AND dp.status IN ('READY','RELEASED')`,[orderId,productId,resolvedOrderItemId]);
   let stockQuantity:number|null=null,stockReserved:number|null=null,stockAvailable:number|null=null;
   if(warehouseId&&locationId){
    await assertLocation(client,warehouseId,locationId);
    const stock=await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",[productId,warehouseId,locationId]);
    const stockRes=await client.query(`SELECT COALESCE(SUM(dl.quantity),0) AS quantity
      FROM delivery_permission_lines dl JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id
      WHERE dl.product_id=$1 AND dl.warehouse_id=$2 AND dl.location_id=$3 AND dp.status='READY'`,[productId,warehouseId,locationId]);
    stockQuantity=Number(stock.rows[0]?.quantity??0);stockReserved=Number(stockRes.rows[0].quantity);stockAvailable=Math.max(0,stockQuantity-stockReserved);
   }
   const producedQuantity=Number(produced.rows[0].quantity),reservedQuantity=Number(reserved.rows[0].quantity);
   return {orderId,orderItemId:resolvedOrderItemId,productId,orderedQuantity:Number(orderLine.rows[0].quantity),approvedProduction:producedQuantity,reservedDelivery:reservedQuantity,productionAvailable:Math.max(0,producedQuantity-reservedQuantity),stockQuantity,stockReserved,stockAvailable};
  });
  return {data:result};
 });
 
 app.post("/api/delivery-permissions",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request,reply)=>{
  const parsed=deliverySchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات إذن التسليم غير صحيحة",422);
  const scannedCodes=new Set<string>();
  for(const line of parsed.data.lines){
   const code=line.cartonCode?.trim();
   if(!code)continue;
   const normalized=code.toLocaleUpperCase("en-US");
   if(scannedCodes.has(normalized))throw new AppError("DUPLICATE_CARTON_CODE","لا يمكن إضافة كود الكرتونة نفسه أكثر من مرة في إذن التسليم",409);
   scannedCodes.add(normalized);
  }
  const row=await withTransaction(async(client)=>{
   const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[parsed.data.orderId]);
   if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
   if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن إنشاء تسليم لطلبية ملغاة",409);
   const d=await client.query("INSERT INTO delivery_permissions(order_id,destination,notes,delivery_value,total_weight,piece_count,sample_quantity,details,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9) RETURNING *",[parsed.data.orderId,parsed.data.destination,parsed.data.notes??null,parsed.data.deliveryValue??null,parsed.data.totalWeight??null,parsed.data.pieceCount??null,parsed.data.sampleQuantity??null,parsed.data.details??null,request.user!.userId]);
   for(const line of parsed.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[line.productId]);if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","منتج في الإذن غير موجود",422);
    await assertLocation(client,line.warehouseId,line.locationId);
    let orderLine;
    if(line.orderItemId){
      orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND id=$2 AND product_id=$3",[parsed.data.orderId,line.orderItemId,line.productId]);
      if(!orderLine.rowCount)throw new AppError("ORDER_ITEM_MISMATCH","سطر المنتج لا يتبع الطلبية أو لا يطابق الصنف",422);
    }else{
      orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND product_id=$2 ORDER BY id",[parsed.data.orderId,line.productId]);
      if((orderLine.rowCount??0)>1)throw new AppError("ORDER_ITEM_REQUIRED","الصنف مكرر في الطلبية؛ اختر سطر المنتج النهائي المحدد",422);
    }
    if(!orderLine.rowCount || Number(orderLine.rows[0].quantity)<=0)throw new AppError("PRODUCT_NOT_IN_ORDER","المنتج المحدد ليس ضمن منتجات الطلبية",422);
    const resolvedOrderItemId=orderLine.rows[0].id;
    let canonicalCartonCode:string|null=line.cartonCode??null;

    if(line.cartonCode){
     const coding=await client.query("SELECT * FROM coding_units WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.cartonCode]);
     const carton=coding.rowCount?null:await client.query("SELECT * FROM cartons WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.cartonCode]);
     const unit=coding.rowCount?coding.rows[0]:null;
     const box=carton?.rowCount?carton.rows[0]:null;
     if(!unit&&!box)throw new AppError("CARTON_NOT_FOUND","كود الكرتونة غير موجود في مرجع التكويد أو المخزن",422);
     const reference=unit??box;
     canonicalCartonCode=reference.code;
     if(reference.product_id!==line.productId||reference.warehouse_id!==line.warehouseId||reference.location_id!==line.locationId)
      throw new AppError("CARTON_MISMATCH","بيانات الكرتونة لا تطابق الصنف أو المخزن أو المكان المحدد",409);
     if(unit&&["CANCELLED","OUT","DELIVERED","RESERVED"].includes(unit.status))throw new AppError("CARTON_UNAVAILABLE","الكرتونة غير متاحة للتسليم بالحالة الحالية",409);
     if(box&&["EMPTY","OPEN"].includes(box.status))throw new AppError("CARTON_UNAVAILABLE","الكرتونة غير مختومة أو فارغة ولا يمكن تسليمها",409);
     if(Number(reference.quantity)<Number(line.quantity))throw new AppError("CARTON_INSUFFICIENT","كمية الكرتونة أقل من كمية التسليم المطلوبة",409);
     // A carton may be scanned by its code or barcode; compare both aliases and store its canonical code.
     const alreadyAssigned=await client.query("SELECT 1 FROM delivery_permission_lines dl JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id WHERE upper(trim(dl.carton_code)) IN (upper(trim($1)),upper(trim($2))) AND dp.status IN ('DRAFT','READY') LIMIT 1",[reference.code,reference.barcode]);
     if(alreadyAssigned.rowCount)throw new AppError("CARTON_ALREADY_ASSIGNED","الكرتونة مرتبطة بالفعل بإذن تسليم آخر غير منتهٍ",409);
    }

    const produced=await client.query(
      `SELECT COALESCE(SUM(pe.quantity),0) AS quantity
         FROM production_entries pe
         JOIN order_stages os ON os.id=pe.order_stage_id
        WHERE os.order_id=$1 AND pe.product_id=$2 AND pe.status='APPROVED' AND os.order_item_id=$3`,
      [parsed.data.orderId,line.productId,resolvedOrderItemId]);
    const reserved=await client.query(
      `SELECT COALESCE(SUM(dl.quantity),0) AS quantity
         FROM delivery_permission_lines dl
         JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id
        WHERE dp.order_id=$1 AND dl.product_id=$2 AND (dl.order_item_id=$3 OR dl.order_item_id IS NULL) AND dp.status IN ('READY','RELEASED')`,
      [parsed.data.orderId,line.productId,resolvedOrderItemId]);
    const productionAvailable=Number(produced.rows[0].quantity)-Number(reserved.rows[0].quantity);
    if(Number(line.quantity)>productionAvailable+1e-9)throw new AppError("DELIVERY_EXCEEDS_PRODUCTION","كمية إذن التسليم تتجاوز الإنتاج المعتمد المتبقي للطلبية",409);

    const stock=await client.query(
      `SELECT quantity
         FROM stock_balances
        WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3
        FOR UPDATE`,
      [line.productId,line.warehouseId,line.locationId]);
    const reservedAtLocation=await client.query(
      `SELECT COALESCE(SUM(dl.quantity),0) AS quantity
         FROM delivery_permission_lines dl
         JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id
        WHERE dl.product_id=$1 AND dl.warehouse_id=$2 AND dl.location_id=$3 AND dp.status='READY'`,
      [line.productId,line.warehouseId,line.locationId]);
    const stockAvailable=Number(stock.rows[0]?.quantity??0)-Number(reservedAtLocation.rows[0].quantity);
    if(Number(line.quantity)>stockAvailable+1e-9)throw new AppError("DELIVERY_EXCEEDS_STOCK","كمية إذن التسليم تتجاوز رصيد المخزن المتاح بعد الأذونات الجاهزة",409);

    await client.query("INSERT INTO delivery_permission_lines(delivery_permission_id,order_item_id,product_id,warehouse_id,location_id,quantity,unit_id,carton_code,carton_weight,piece_count,sample_quantity,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[d.rows[0].id,resolvedOrderItemId,line.productId,line.warehouseId,line.locationId,line.quantity,product.rows[0].unit_id,canonicalCartonCode,line.cartonWeight??null,line.pieceCount??null,line.sampleQuantity??null,line.details??null]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"delivery_permission",entityId:d.rows[0].id,afterData:d.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return d.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.post("/api/delivery-permissions/:id/release",{preHandler:[authenticateRequest,requirePermission("deliveries.release")]},async(request)=>{
  const id=(request.params as {id:string}).id;const parsed=releaseSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","كود المسح مطلوب",422);
  const row=await withTransaction(async(client)=>{
   await assertAccountingPeriodOpen(client,new Date().toISOString().slice(0,10));
   const d=await client.query("SELECT * FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);if(!d.rowCount)throw new AppError("NOT_FOUND","إذن التسليم غير موجود",404);
   if(d.rows[0].status!=="READY")throw new AppError("INVALID_STATUS","إذن التسليم ليس جاهزًا للخروج",409);
   if(parsed.data.scanCode!==d.rows[0].code)throw new AppError("SCAN_MISMATCH","كود المسح لا يطابق إذن التسليم",409);
   if(!d.rows[0].order_id)throw new AppError("ORDER_REQUIRED","إذن التسليم يجب أن يكون مرتبطًا بطلبية",409);
   const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[d.rows[0].order_id]);
   if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية المرتبطة بإذن التسليم غير موجودة",409);
   if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن إخراج تسليم لطلبية ملغاة",409);
   const lines=await client.query("SELECT * FROM delivery_permission_lines WHERE delivery_permission_id=$1 ORDER BY id",[id]);
   for(const line of lines.rows){
    let orderLine;
    if(line.order_item_id){
      orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND id=$2 AND product_id=$3",[d.rows[0].order_id,line.order_item_id,line.product_id]);
    }else{
      orderLine=await client.query("SELECT id,quantity FROM production_order_lines WHERE order_id=$1 AND product_id=$2 ORDER BY id",[d.rows[0].order_id,line.product_id]);
      if((orderLine.rowCount??0)>1)throw new AppError("LEGACY_DELIVERY_LINE_AMBIGUOUS","إذن التسليم القديم لا يحدد سطر المنتج، والصنف مكرر في الطلبية. راجع الربط يدويًا قبل إخراج الإذن.",409);
      if((orderLine.rowCount??0)===1){
        await client.query("UPDATE delivery_permission_lines SET order_item_id=$1 WHERE id=$2",[orderLine.rows[0].id,line.id]);
        line.order_item_id=orderLine.rows[0].id;
      }
    }
    if(!orderLine.rowCount)throw new AppError("PRODUCT_NOT_IN_ORDER","المنتج المحدد ليس ضمن منتجات الطلبية",409);
    const delivered=await client.query("SELECT COALESCE(SUM(quantity),0) AS quantity FROM stock_movements WHERE reference_type='DELIVERY' AND order_id=$1 AND product_id=$2 AND movement_type='OUT' AND (order_item_id=$3 OR order_item_id IS NULL)",[d.rows[0].order_id,line.product_id,orderLine.rows[0].id]);
    const orderedQuantity=Number(orderLine.rows[0].quantity||0);
    const deliveredQuantity=Number(delivered.rows[0].quantity||0);
    if(deliveredQuantity+Number(line.quantity)>orderedQuantity+1e-9){
      throw new AppError("DELIVERY_EXCEEDS_ORDER","كمية التسليم تتجاوز الكمية المتبقية في الطلبية",409);
    }
    if(line.carton_code){
     const coding=await client.query("SELECT * FROM coding_units WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.carton_code]);
     if(coding.rowCount){
      const unit=coding.rows[0];
      if(unit.product_id!==line.product_id || unit.warehouse_id!==line.warehouse_id || unit.location_id!==line.location_id){
       throw new AppError("CODING_UNIT_MISMATCH","بيانات وحدة التكويد لا تطابق الصنف أو المخزن أو مكان التخزين في الإذن",409);
      }
      if(["CANCELLED","OUT","DELIVERED"].includes(unit.status)) throw new AppError("CODING_UNIT_UNAVAILABLE","وحدة التكويد غير متاحة للخروج",409);
      const remaining=Number(unit.quantity)-Number(line.quantity);
      if(remaining<0) throw new AppError("CODING_UNIT_INSUFFICIENT","كمية وحدة التكويد أقل من الكمية المطلوبة",409);
      const nextStatus=remaining===0?"OUT":"IN_STOCK";
      await client.query("UPDATE coding_units SET quantity=$1,status=$2,updated_at=now() WHERE id=$3",[remaining,nextStatus,unit.id]);
      await client.query("INSERT INTO coding_unit_movements(coding_unit_id,movement_type,from_warehouse_id,from_location_id,reference_type,reference_id,notes,created_by) VALUES($1,'OUT',$2,$3,'DELIVERY',$4,$5,$6)",[unit.id,unit.warehouse_id,unit.location_id,id,"خروج وحدة التكويد عبر إذن التسليم "+d.rows[0].code,request.user!.userId]);
     } else {
      const carton=await client.query("SELECT * FROM cartons WHERE (code=$1 OR barcode=$1) FOR UPDATE",[line.carton_code]);
      if(!carton.rowCount) throw new AppError("CARTON_NOT_FOUND","الكرتونة المحددة في إذن التسليم غير موجودة",422);
      const c=carton.rows[0];
      if(c.product_id!==line.product_id || c.warehouse_id!==line.warehouse_id || c.location_id!==line.location_id){
       throw new AppError("CARTON_MISMATCH","بيانات الكرتونة لا تطابق صنف أو مخزن أو مكان التخزين في الإذن",409);
      }
      const remaining=Number(c.quantity)-Number(line.quantity);
      if(remaining<0) throw new AppError("CARTON_INSUFFICIENT","كمية الكرتونة أقل من الكمية المطلوبة في الإذن",409);
      await client.query("UPDATE cartons SET quantity=$1,status=$2,updated_at=now() WHERE id=$3",[remaining,remaining===0?"EMPTY":"PARTIAL",c.id]);
     }
    }
    const movementCost=await changeBalance(client,line.product_id,line.warehouse_id,line.location_id,-Number(line.quantity));
    await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,order_id,order_item_id,carton_code,reference_type,reference_id,notes,created_by) VALUES('OUT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DELIVERY',$11,$12,$13)",[line.product_id,line.warehouse_id,line.location_id,line.quantity,line.unit_id,movementCost.unitCost,movementCost.totalCost,d.rows[0].order_id,line.order_item_id??orderLine.rows[0].id,line.carton_code,id,"Delivery permission "+d.rows[0].code,request.user!.userId]);
   }
   const updated=await client.query("UPDATE delivery_permissions SET status='RELEASED',released_by=$1,released_at=now(),updated_at=now() WHERE id=$2 RETURNING *",[request.user!.userId,id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"release",module:"warehouse",entityType:"delivery_permission",entityId:id,afterData:updated.rows[0],metadata:{scanCode:parsed.data.scanCode},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });
}