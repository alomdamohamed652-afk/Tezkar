import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { consumeInventoryLots, adjustStockValueAfterLotConsumption, createInventoryLot } from "./inventory-lots.service.js";

const warehouseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).nullable().optional(),
  warehouseType: z.enum(["GENERAL","RAW_MATERIAL","WIP","FINISHED_GOODS","SCRAP"]).default("GENERAL")
});
const locationSchema = z.object({
  warehouseId: z.string().uuid(), code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120)
});
const movementSchema = z.object({
  movementType: z.enum(["IN","OUT","ADJUSTMENT","RETURN","TRANSFER_OUT"]),
  productId: z.string().uuid(), warehouseId: z.string().uuid(), locationId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(), cartonCode: z.string().trim().max(100).nullable().optional(),
  batchCode: z.string().trim().max(100).nullable().optional(), weight: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(), adjustmentDirection: z.enum(["IN","OUT"]).default("IN"), unitCost: z.number().nonnegative().nullable().optional(), orderId: z.string().uuid().nullable().optional(), orderStageId: z.string().uuid().nullable().optional(), targetWarehouseId: z.string().uuid().optional(),
  targetLocationId: z.string().uuid().optional()
});

async function resolveLocation(client: import("pg").PoolClient, warehouseId: string, locationId?: string | null) {
  if(locationId){
    await assertLocation(client,warehouseId,locationId);
    return locationId;
  }
  const result=await client.query(
    "SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND is_active=TRUE ORDER BY code,id LIMIT 1",
    [warehouseId]
  );
  if(!result.rowCount) throw new AppError("LOCATION_NOT_FOUND","لا يوجد مكان داخلي للمخزن. سيتم إنشاؤه تلقائيًا عند إعداد المخزن.",422);
  return result.rows[0].id as string;
}

async function assertLocation(client: import("pg").PoolClient, warehouseId: string, locationId: string) {
  const result = await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[locationId,warehouseId]);
  if (!result.rowCount) throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);
}

async function changeBalance(client: import("pg").PoolClient, productId: string, warehouseId: string, locationId: string, delta: number, movementUnitCost?: number | null) {
  const locked = await client.query("SELECT quantity,avg_unit_cost,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[productId,warehouseId,locationId]);
  const current = Number(locked.rows[0]?.quantity ?? 0);
  const currentValue = Number(locked.rows[0]?.inventory_value ?? 0);
  const currentAvg = Number(locked.rows[0]?.avg_unit_cost ?? 0);
  const next = current + delta;
  if (next < -1e-9) throw new AppError("INSUFFICIENT_STOCK","الرصيد المتاح في هذا المكان لا يكفي للصرف",409);
  const cost = movementUnitCost == null ? currentAvg : movementUnitCost;
  let nextValue = currentValue;
  if (delta > 0) nextValue = currentValue + delta * cost;
  else if (delta < 0) nextValue = Math.max(0,currentValue - Math.abs(delta) * currentAvg);
  const nextAvg = next > 0 ? nextValue / next : 0;
  if (locked.rowCount) {
    await client.query("UPDATE stock_balances SET quantity=$1,avg_unit_cost=$2,inventory_value=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",[Math.max(0,next),nextAvg,nextValue,productId,warehouseId,locationId]);
  } else {
    if (delta < 0) throw new AppError("INSUFFICIENT_STOCK","لا يوجد رصيد متاح في هذا المكان",409);
    await client.query("INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value) VALUES($1,$2,$3,$4,$5,$6)",[productId,warehouseId,locationId,next,cost,nextValue]);
  }
  return {unitCost: cost,totalCost: Math.abs(delta) * cost};
}

export async function warehouseRoutes(app: FastifyInstance) {
  app.delete("/api/warehouses/:id",{preHandler:[authenticateRequest,requirePermission("warehouses.delete")]},async(req)=>{
    const id=(req.params as {id:string}).id;
    const stock=await pool.query("SELECT COALESCE(SUM(quantity),0) AS q FROM stock_balances WHERE warehouse_id=$1",[id]);
    if(Number(stock.rows[0].q)>0)throw new AppError("WAREHOUSE_HAS_STOCK","لا يمكن تعطيل مخزن به رصيد. انقل الرصيد أولاً.",409);
    const r=await pool.query("UPDATE warehouses SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("WAREHOUSE_NOT_FOUND","المخزن غير موجود",404);return {data:r.rows[0]};
  });


  app.get("/api/warehouses",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async()=>{
    const result=await pool.query("SELECT w.id,w.code,w.name,w.address,w.warehouse_type,w.is_active,COUNT(l.id)::int AS location_count FROM warehouses w LEFT JOIN warehouse_locations l ON l.warehouse_id=w.id AND l.is_active=TRUE WHERE w.is_active=TRUE GROUP BY w.id ORDER BY w.name");
    return {data:result.rows};
  });

  app.post("/api/warehouse/locations/:id/deactivate",{preHandler:[authenticateRequest,requirePermission("warehouse.manage")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({targetWarehouseId:z.string().uuid().nullable().optional(),targetLocationId:z.string().uuid().nullable().optional()}).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","وجهة النقل غير صحيحة",422);
    const row=await withTransaction(async client=>{
      const location=await client.query("SELECT l.*,w.name AS warehouse_name FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 FOR UPDATE",[id]);
      if(!location.rowCount)throw new AppError("LOCATION_NOT_FOUND","المكان غير موجود",404);
      if(!location.rows[0].is_active)return location.rows[0];
      const stock=await client.query("SELECT product_id,quantity FROM stock_balances WHERE location_id=$1 AND quantity>0 FOR UPDATE",[id]);
      if(stock.rowCount){
        if(!parsed.data.targetWarehouseId||!destinationLocationId){
          throw new AppError("LOCATION_HAS_STOCK","المكان يحتوي على رصيد. اختر مخزنًا ومكانًا بديلًا لنقل الرصيد قبل التعطيل.",409);
        }
        if(parsed.data.targetWarehouseId===location.rows[0].warehouse_id&&destinationLocationId===id)throw new AppError("INVALID_TRANSFER_TARGET","اختر مكانًا مختلفًا للنقل",422);
        const target=await client.query("SELECT l.id,l.warehouse_id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 AND l.warehouse_id=$2 AND l.is_active=TRUE AND w.is_active=TRUE",[destinationLocationId,parsed.data.targetWarehouseId]);
        if(!target.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان النقل غير موجود أو غير نشط",422);
        for(const balance of stock.rows){
          const lots=await client.query("SELECT id,remaining_quantity,unit_cost,batch_code FROM inventory_lots WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 AND remaining_quantity>0 ORDER BY created_at,id FOR UPDATE",[balance.product_id,location.rows[0].warehouse_id,id]);
          for(const lot of lots.rows){
            const qty=Number(lot.remaining_quantity);
            const sourceCost=await changeBalance(client,balance.product_id,location.rows[0].warehouse_id,id,-qty,Number(lot.unit_cost));
            const source=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,batch_code,notes,created_by,reference_type) SELECT 'TRANSFER_OUT',$1,$2,$3,$4,p.unit_id,$5,$6,$7,'نقل قبل تعطيل المكان',$8,'LOCATION_DEACTIVATION' FROM products p WHERE p.id=$1 RETURNING id",[balance.product_id,location.rows[0].warehouse_id,id,qty,lot.unit_cost,qty*Number(lot.unit_cost),lot.batch_code,request.user!.userId]);
            await client.query("UPDATE inventory_lots SET remaining_quantity=0,updated_at=now() WHERE id=$1",[lot.id]);
            await client.query("INSERT INTO stock_movement_lots(movement_id,lot_id,quantity,unit_cost,total_cost) VALUES($1,$2,$3,$4,$5)",[source.rows[0].id,lot.id,qty,lot.unit_cost,qty*Number(lot.unit_cost)]);
            await changeBalance(client,balance.product_id,parsed.data.targetWarehouseId!,destinationLocationId!,qty,Number(lot.unit_cost));
            const dest=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,batch_code,notes,created_by,reference_type,reference_id) SELECT 'TRANSFER_IN',$1,$2,$3,$4,p.unit_id,$5,$6,$7,'نقل قبل تعطيل المكان',$8,'LOCATION_DEACTIVATION',$9 FROM products p WHERE p.id=$1 RETURNING id",[balance.product_id,parsed.data.targetWarehouseId,destinationLocationId,qty,lot.unit_cost,qty*Number(lot.unit_cost),lot.batch_code,request.user!.userId,source.rows[0].id]);
            await createInventoryLot(client,{productId:balance.product_id,warehouseId:parsed.data.targetWarehouseId!,locationId:destinationLocationId!,quantity:qty,unitCost:Number(lot.unit_cost),batchCode:lot.batch_code,sourceType:"LOCATION_TRANSFER",sourceId:dest.rows[0].id});
          }
          const remainingValue=await client.query("SELECT COALESCE(SUM(remaining_quantity*unit_cost),0) AS value,COALESCE(SUM(remaining_quantity),0) AS quantity FROM inventory_lots WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 AND remaining_quantity>0",[balance.product_id,location.rows[0].warehouse_id,id]);
          await client.query("UPDATE stock_balances SET quantity=$1,inventory_value=$2,avg_unit_cost=CASE WHEN $1>0 THEN $2/$1 ELSE 0 END,updated_at=now() WHERE product_id=$3 AND warehouse_id=$4 AND location_id=$5",[remainingValue.rows[0].quantity,remainingValue.rows[0].value,balance.product_id,location.rows[0].warehouse_id,id]);
        }
      }
      const updated=await client.query("UPDATE warehouse_locations SET is_active=FALSE WHERE id=$1 RETURNING *",[id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"deactivate",module:"warehouse",entityType:"warehouse_location",entityId:id,beforeData:location.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.get("/api/warehouse/locations",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional()}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلتر المخزن غير صحيح",422);
    const params:unknown[]=[]; const where=["l.is_active=TRUE"];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("l.warehouse_id=$"+params.length);}
    const result=await pool.query("SELECT l.id,l.code,l.name,l.warehouse_id,w.code AS warehouse_code,w.name AS warehouse_name FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE "+where.join(" AND ")+" ORDER BY w.name,l.code",params);
    return {data:result.rows};
  });

  app.get("/api/warehouse/stock",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional(),productId:z.string().uuid().optional()}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلاتر المخزون غير صحيحة",422);
    const params:unknown[]=[]; const where=["b.quantity > 0"];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("b.warehouse_id=$"+params.length);}
    if(parsed.data.productId){params.push(parsed.data.productId);where.push("b.product_id=$"+params.length);}
    const result=await pool.query("SELECT b.product_id,b.warehouse_id,b.location_id,b.quantity,b.avg_unit_cost,b.inventory_value,p.code AS product_code,p.name AS product_name,u.name AS unit_name,w.code AS warehouse_code,w.name AS warehouse_name,l.code AS location_code,l.name AS location_name FROM stock_balances b JOIN products p ON p.id=b.product_id JOIN units u ON u.id=p.unit_id JOIN warehouses w ON w.id=b.warehouse_id JOIN warehouse_locations l ON l.id=b.location_id WHERE "+where.join(" AND ")+" ORDER BY p.name,w.name,l.code",params);
    return {data:result.rows};
  });

  app.get("/api/warehouse/lots",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional(),productId:z.string().uuid().optional()}).safeParse(request.query);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","فلاتر دفعات التكلفة غير صحيحة",422);
    const params:unknown[]=[];const where:string[]=["l.remaining_quantity>0"];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("l.warehouse_id=$"+params.length)}
    if(parsed.data.productId){params.push(parsed.data.productId);where.push("l.product_id=$"+params.length)}
    const r=await pool.query(`SELECT l.id,l.batch_code,l.unit_cost,l.original_quantity,l.remaining_quantity,l.source_type,l.created_at,
      p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,loc.code AS location_code,loc.name AS location_name,u.name AS unit_name
      FROM inventory_lots l JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id
      JOIN warehouse_locations loc ON loc.id=l.location_id JOIN units u ON u.id=p.unit_id
      WHERE ${where.join(" AND ")} ORDER BY p.name,l.created_at,l.id`,params);
    return {data:r.rows};
  });

  app.get("/api/warehouse/movements",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional(),productId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(300).default(100)}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلاتر الحركات غير صحيحة",422);
    const params:unknown[]=[]; const where:string[]=[];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("m.warehouse_id=$"+params.length);}
    if(parsed.data.productId){params.push(parsed.data.productId);where.push("m.product_id=$"+params.length);}
    params.push(parsed.data.limit);
    const result=await pool.query("SELECT m.id,m.code,m.movement_type,m.quantity,m.unit_cost,m.total_cost,m.carton_code,m.batch_code,m.weight,m.notes,m.created_at,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id JOIN warehouse_locations l ON l.id=m.location_id JOIN units u ON u.id=m.unit_id "+(where.length?"WHERE "+where.join(" AND "):"")+" ORDER BY m.created_at DESC LIMIT $"+params.length,params);
    return {data:result.rows};
  });

  app.get("/api/warehouse/dashboard",{preHandler:[authenticateRequest,requirePermission("warehouse.dashboard")]},async(request)=>{
    const q=z.object({from:z.string().date().optional(),to:z.string().date().optional(),warehouseId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success) throw new AppError("VALIDATION_ERROR","فلاتر تكلفة المخزن غير صحيحة",422);
    const params:unknown[]=[]; const where:string[]=["1=1"];
    if(q.data.from){params.push(q.data.from);where.push("created_at::date >= $"+params.length);}
    if(q.data.to){params.push(q.data.to);where.push("created_at::date <= $"+params.length);}
    if(q.data.warehouseId){params.push(q.data.warehouseId);where.push("warehouse_id=$"+params.length);}
    const r=await pool.query("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('IN','RETURN','TRANSFER_IN','ADJUSTMENT') THEN total_cost ELSE 0 END),0) AS total_in,COALESCE(SUM(CASE WHEN movement_type IN ('OUT','TRANSFER_OUT') THEN total_cost ELSE 0 END),0) AS total_out,COALESCE(SUM(CASE WHEN movement_type IN ('IN','RETURN','TRANSFER_IN','ADJUSTMENT') THEN total_cost ELSE -total_cost END),0) AS net FROM stock_movements WHERE "+where.join(" AND "),params);
    const current=await pool.query("SELECT COALESCE(SUM(inventory_value),0) AS current_value,COUNT(*)::int AS lines FROM stock_balances WHERE quantity>0"+(q.data.warehouseId?" AND warehouse_id=$1":"") ,q.data.warehouseId?[q.data.warehouseId]:[]);
    return {data:{...r.rows[0],current_value:current.rows[0].current_value,stock_lines:current.rows[0].lines}};
  });

  app.post("/api/warehouses",{preHandler:[authenticateRequest,requirePermission("warehouse.manage")]},async(request,reply)=>{
    const parsed=warehouseSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المخزن غير صحيحة",422);
    const result=await pool.query("INSERT INTO warehouses(name,address,warehouse_type) VALUES($1,$2,$3) RETURNING *",[parsed.data.name,parsed.data.address??null,parsed.data.warehouseType]);
    return reply.code(201).send({data:result.rows[0]});
  });

  app.post("/api/warehouse/locations",{preHandler:[authenticateRequest,requirePermission("warehouse.manage")]},async(request,reply)=>{
    const parsed=locationSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات مكان التخزين غير صحيحة",422);
    const warehouse=await pool.query("SELECT id FROM warehouses WHERE id=$1 AND is_active=TRUE",[parsed.data.warehouseId]);
    if(!warehouse.rowCount) throw new AppError("WAREHOUSE_NOT_FOUND","المخزن غير موجود أو غير نشط",422);
    const result=await pool.query("INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES($1,$2,$3) RETURNING *",[parsed.data.warehouseId,parsed.data.code,parsed.data.name]);
    return reply.code(201).send({data:result.rows[0]});
  });

  app.post("/api/warehouse/movements",{preHandler:[authenticateRequest,requirePermission("warehouse.move")]},async(request,reply)=>{
    const parsed=movementSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات حركة المخزن غير صحيحة",422);
    const row=await withTransaction(async(client)=>{
      const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[parsed.data.productId]);
      if(!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير متابع مخزنيًا",422);
      const sourceLocationId=await resolveLocation(client,parsed.data.warehouseId,sourceLocationId);
      let destinationLocationId:string|undefined;
      if(parsed.data.movementType==="TRANSFER_OUT"){
        if(!parsed.data.targetWarehouseId) throw new AppError("TRANSFER_TARGET_REQUIRED","التحويل يحتاج مخزن وصول",422);
        destinationLocationId=await resolveLocation(client,parsed.data.targetWarehouseId,destinationLocationId);
      }
      if(parsed.data.orderStageId){
        const stage=await client.query(`SELECT os.id,os.order_id,os.output_product_id,po.status
          FROM order_stages os JOIN production_orders po ON po.id=os.order_id
          WHERE os.id=$1 FOR UPDATE`,[parsed.data.orderStageId]);
        if(!stage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        if(parsed.data.orderId && stage.rows[0].order_id!==parsed.data.orderId) throw new AppError("ORDER_STAGE_ORDER_MISMATCH","مرحلة الطلب لا تنتمي إلى الطلبية المحددة",409);
        if(stage.rows[0].status==="CANCELLED") throw new AppError("ORDER_CANCELLED","لا يمكن ربط حركة مخزن بمرحلة طلبية ملغاة",409);
        if(stage.rows[0].output_product_id && stage.rows[0].output_product_id!==parsed.data.productId) throw new AppError("ORDER_STAGE_PRODUCT_MISMATCH","المنتج لا يطابق منتج مرحلة الطلب",409);
      } else if(parsed.data.orderId){
        const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[parsed.data.orderId]);
        if(!order.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",422);
        if(order.rows[0].status==="CANCELLED") throw new AppError("ORDER_CANCELLED","لا يمكن ربط حركة مخزن بطلبية ملغاة",409);
      }
      if(["IN","ADJUSTMENT"].includes(parsed.data.movementType) && parsed.data.adjustmentDirection==="IN" && parsed.data.unitCost==null){
        throw new AppError("UNIT_COST_REQUIRED","يجب تحديد تكلفة الوحدة عند إدخال رصيد للمخزن",422);
      }
      const delta=(parsed.data.movementType==="OUT"||parsed.data.movementType==="TRANSFER_OUT"||(parsed.data.movementType==="ADJUSTMENT"&&parsed.data.adjustmentDirection==="OUT"))?-parsed.data.quantity:parsed.data.quantity;
      const effectiveUnitCost=(delta<0 || parsed.data.movementType==="RETURN")?null:parsed.data.unitCost;
      const sourceCost=await changeBalance(client,parsed.data.productId,parsed.data.warehouseId,sourceLocationId,delta,effectiveUnitCost);
      const source=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,carton_code,batch_code,weight,notes,created_by,order_id,order_stage_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *",[parsed.data.movementType,parsed.data.productId,parsed.data.warehouseId,sourceLocationId,parsed.data.quantity,product.rows[0].unit_id,sourceCost.unitCost,sourceCost.totalCost,parsed.data.cartonCode??null,parsed.data.batchCode??null,parsed.data.weight??null,parsed.data.notes??null,request.user!.userId,parsed.data.orderId??null,parsed.data.orderStageId??null]);
      let finalSourceCost=sourceCost;
      if(delta<0){
        const consumed=await consumeInventoryLots(client,{movementId:source.rows[0].id,productId:parsed.data.productId,warehouseId:parsed.data.warehouseId,locationId:sourceLocationId,quantity:parsed.data.quantity});
        finalSourceCost={unitCost:consumed.unitCost,totalCost:consumed.totalCost};
        await client.query("UPDATE stock_movements SET unit_cost=$1,total_cost=$2 WHERE id=$3",[finalSourceCost.unitCost,finalSourceCost.totalCost,source.rows[0].id]);
        await adjustStockValueAfterLotConsumption(client,parsed.data.productId,parsed.data.warehouseId,sourceLocationId,finalSourceCost.totalCost);
      } else {
        await createInventoryLot(client,{productId:parsed.data.productId,warehouseId:parsed.data.warehouseId,locationId:sourceLocationId,quantity:parsed.data.quantity,unitCost:sourceCost.unitCost,batchCode:parsed.data.batchCode??null,sourceType:parsed.data.movementType,sourceId:source.rows[0].id});
      }
      let destination=null;
      if(parsed.data.movementType==="TRANSFER_OUT"){
        await changeBalance(client,parsed.data.productId,parsed.data.targetWarehouseId!,destinationLocationId!,parsed.data.quantity,finalSourceCost.unitCost);
        const d=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,carton_code,batch_code,weight,notes,created_by,reference_type,reference_id,order_id,order_stage_id) VALUES('TRANSFER_IN',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'TRANSFER',$12,$13,$14) RETURNING *",[parsed.data.productId,parsed.data.targetWarehouseId,destinationLocationId,parsed.data.quantity,product.rows[0].unit_id,finalSourceCost.unitCost,finalSourceCost.totalCost,parsed.data.cartonCode??null,parsed.data.batchCode??null,parsed.data.weight??null,parsed.data.notes??null,request.user!.userId,source.rows[0].id,parsed.data.orderId??null,parsed.data.orderStageId??null]);
        await createInventoryLot(client,{productId:parsed.data.productId,warehouseId:parsed.data.targetWarehouseId!,locationId:destinationLocationId!,quantity:parsed.data.quantity,unitCost:finalSourceCost.unitCost,batchCode:parsed.data.batchCode??null,sourceType:"TRANSFER_IN",sourceId:d.rows[0].id});
        destination=d.rows[0];
        await client.query("UPDATE stock_movements SET reference_type='TRANSFER',reference_id=$1 WHERE id=$2",[destination.id,source.rows[0].id]);
      }
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"stock_movement",entityId:source.rows[0].id,afterData:{source:source.rows[0],destination},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {source:source.rows[0],destination};
    });
    return reply.code(201).send({data:row});
  });
}