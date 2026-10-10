import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction, pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const line=z.object({
  productId:z.string().uuid(),
  warehouseId:z.string().uuid(),
  quantity:z.number().positive(),
  notes:z.string().trim().max(300).nullable().optional()
});

const schema=z.object({
  shiftId:z.string().uuid(),
  withdrawalDate:z.string().date().optional(),
  employeeId:z.string().uuid(),
  orderId:z.string().uuid().nullable().optional(),
  orderStageId:z.string().uuid().nullable().optional(),
  notes:z.string().trim().max(500).nullable().optional(),
  lines:z.array(line).min(1).max(100)
});

async function consumeWarehouseStock(client: import("pg").PoolClient, input:{
  productId:string; warehouseId:string; quantity:number; withdrawalId:string; orderId:string|null; orderStageId:string|null; createdBy:string;
}) {
  let remaining=input.quantity;
  const lots=await client.query(`
    SELECT id,location_id,remaining_quantity,unit_cost
      FROM inventory_lots
     WHERE product_id=$1 AND warehouse_id=$2 AND remaining_quantity>0
     ORDER BY created_at ASC,id ASC
     FOR UPDATE`,
    [input.productId,input.warehouseId]
  );
  const allocations:{lotId:string;locationId:string;quantity:number;unitCost:number;totalCost:number}[]=[];
  for(const lot of lots.rows){
    if(remaining<=1e-9)break;
    const available=Number(lot.remaining_quantity);
    const take=Math.min(remaining,available);
    const totalCost=take*Number(lot.unit_cost);
    await client.query("UPDATE inventory_lots SET remaining_quantity=remaining_quantity-$1,updated_at=now() WHERE id=$2",[take,lot.id]);
    allocations.push({lotId:lot.id,locationId:lot.location_id,quantity:take,unitCost:Number(lot.unit_cost),totalCost});
    remaining-=take;
  }
  if(remaining>1e-9)throw new AppError("INVENTORY_LOT_INSUFFICIENT","رصيد الصنف في المخزن لا يكفي للمسحوب المطلوب",409);

  const byLocation=new Map<string,{quantity:number;totalCost:number;allocations:typeof allocations}>();
  for(const a of allocations){
    const current=byLocation.get(a.locationId)??{quantity:0,totalCost:0,allocations:[]};
    current.quantity+=a.quantity;current.totalCost+=a.totalCost;current.allocations.push(a);byLocation.set(a.locationId,current);
  }

  for(const [locationId,g] of byLocation){
    const balance=await client.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
      [input.productId,input.warehouseId,locationId]
    );
    const currentQty=Number(balance.rows[0]?.quantity??0);
    const currentValue=Number(balance.rows[0]?.inventory_value??0);
    const nextQty=currentQty-g.quantity;
    const nextValue=Math.max(0,currentValue-g.totalCost);
    if(nextQty<-1e-9)throw new AppError("INSUFFICIENT_STOCK","رصيد المخزن لا يكفي للمسحوب المطلوب",409);
    if(balance.rowCount){
      await client.query(
        "UPDATE stock_balances SET quantity=$1,inventory_value=$2,avg_unit_cost=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",
        [Math.max(0,nextQty),nextValue,nextQty>0?nextValue/nextQty:0,input.productId,input.warehouseId,locationId]
      );
    }
    const unit=await client.query("SELECT unit_id FROM products WHERE id=$1",[input.productId]);
    const movement=await client.query(`
      INSERT INTO stock_movements(
        movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,
        notes,created_by,reference_type,reference_id,order_id,order_stage_id
      )
      VALUES('OUT',$1,$2,$3,$4,$5,$6,$7,$8,$9,'SHIFT_WITHDRAWAL',$10,$11,$12)
      RETURNING id`,
      [
        input.productId,input.warehouseId,locationId,g.quantity,unit.rows[0].unit_id,
        g.quantity>0?g.totalCost/g.quantity:0,g.totalCost,
        "مسحوب وردية "+input.withdrawalId,input.createdBy,input.withdrawalId,input.orderId,input.orderStageId
      ]
    );
    for(const a of g.allocations){
      await client.query(
        "INSERT INTO stock_movement_lots(movement_id,lot_id,quantity,unit_cost,total_cost) VALUES($1,$2,$3,$4,$5)",
        [movement.rows[0].id,a.lotId,a.quantity,a.unitCost,a.totalCost]
      );
    }
  }
  return {totalCost:allocations.reduce((s,a)=>s+a.totalCost,0),locations:[...byLocation.keys()]};
}

export async function shiftWithdrawalRoutes(app:FastifyInstance){
 app.get("/api/shift-withdrawals",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async()=>{
  const r=await pool.query(`
    SELECT sw.id,sw.code,sw.withdrawal_date,sw.notes,
           s.code AS shift_code,s.name AS shift_name,
           e.code AS employee_code,e.full_name AS employee_name,
           o.code AS order_code,o.order_name,
           COUNT(l.id)::int AS line_count,
           COALESCE(SUM(l.quantity),0) AS total_quantity
      FROM shift_withdrawals sw
      JOIN shifts s ON s.id=sw.shift_id
      LEFT JOIN employees e ON e.id=sw.employee_id
      LEFT JOIN production_orders o ON o.id=sw.order_id
      LEFT JOIN shift_withdrawal_lines l ON l.withdrawal_id=sw.id
     GROUP BY sw.id,s.code,s.name,e.code,e.full_name,o.code,o.order_name
     ORDER BY sw.withdrawal_date DESC,sw.created_at DESC
     LIMIT 300`);
  return {data:r.rows};
 });

 app.get("/api/shift-withdrawals/:id",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const header=await pool.query(`
    SELECT sw.*,s.code AS shift_code,s.name AS shift_name,e.full_name AS employee_name,
           o.code AS order_code,o.order_name
      FROM shift_withdrawals sw
      JOIN shifts s ON s.id=sw.shift_id
      LEFT JOIN employees e ON e.id=sw.employee_id
      LEFT JOIN production_orders o ON o.id=sw.order_id
     WHERE sw.id=$1`,[id]);
  if(!header.rowCount)throw new AppError("WITHDRAWAL_NOT_FOUND","مسحوب الوردية غير موجود",404);
  const lines=await pool.query(`
    SELECT l.*,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,
           u.name AS unit_name
      FROM shift_withdrawal_lines l
      JOIN products p ON p.id=l.product_id
      JOIN warehouses w ON w.id=l.warehouse_id
      JOIN units u ON u.id=l.unit_id
     WHERE l.withdrawal_id=$1 ORDER BY l.id`,[id]);
  return {data:{withdrawal:header.rows[0],lines:lines.rows}};
 });

 app.post("/api/shift-withdrawals",{preHandler:[authenticateRequest,requirePermission("warehouse.move")]},async(request,reply)=>{
  const p=schema.safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات مسحوبات الوردية غير صحيحة",422);
  const result=await withTransaction(async client=>{
   const shift=await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE",[p.data.shiftId]);
   if(!shift.rowCount)throw new AppError("SHIFT_NOT_FOUND","الوردية غير موجودة أو غير نشطة",422);

   const employee=await client.query(`
     SELECT e.id
       FROM employees e
       JOIN shift_employees se ON se.employee_id=e.id
      WHERE e.id=$1 AND se.shift_id=$2 AND e.is_active=TRUE AND se.is_active=TRUE
        AND (se.starts_on IS NULL OR se.starts_on<=COALESCE($3::date,CURRENT_DATE))
        AND (se.ends_on IS NULL OR se.ends_on>=COALESCE($3::date,CURRENT_DATE))`,
     [p.data.employeeId,p.data.shiftId,p.data.withdrawalDate??null]
   );
   if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_ASSIGNED_TO_SHIFT","الموظف غير مربوط بالوردية المحددة",422);

   if(p.data.orderStageId&&!p.data.orderId)throw new AppError("ORDER_REQUIRED_FOR_STAGE","اختيار مرحلة الطلب يحتاج اختيار الطلبية أولًا",422);
   if(p.data.orderId){
     const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[p.data.orderId]);
     if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",422);
     if(order.rows[0].status==="CANCELLED"||order.rows[0].status==="COMPLETED")throw new AppError("ORDER_CLOSED","لا يمكن تسجيل مسحوبات على طلبية مكتملة أو ملغاة",409);
   }
   if(p.data.orderStageId){
     const stage=await client.query(`
       SELECT os.id,os.order_id,os.output_product_id,os.status
         FROM order_stages os WHERE os.id=$1 FOR UPDATE`,[p.data.orderStageId]);
     if(!stage.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
     if(stage.rows[0].order_id!==p.data.orderId)throw new AppError("ORDER_STAGE_ORDER_MISMATCH","مرحلة الطلب لا تنتمي إلى الطلبية المحددة",409);
     if(stage.rows[0].status==="CANCELLED"||stage.rows[0].status==="COMPLETED")throw new AppError("ORDER_STAGE_CLOSED","لا يمكن تسجيل مسحوبات على مرحلة مغلقة",409);
   }

   const h=await client.query(`
     INSERT INTO shift_withdrawals(shift_id,withdrawal_date,employee_id,order_id,order_stage_id,notes,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
     [p.data.shiftId,p.data.withdrawalDate??new Date().toISOString().slice(0,10),p.data.employeeId,p.data.orderId??null,p.data.orderStageId??null,p.data.notes??null,request.user!.userId]
   );

   for(const item of p.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[item.productId]);
    if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","الصنف غير موجود أو غير متابع مخزنيًا",422);
    const warehouse=await client.query("SELECT id FROM warehouses WHERE id=$1 AND is_active=TRUE",[item.warehouseId]);
    if(!warehouse.rowCount)throw new AppError("WAREHOUSE_NOT_FOUND","المخزن غير موجود أو غير نشط",422);
    // A stage withdrawal represents consumed inputs, not the stage output. Input
    // products must be allowed to differ from order_stages.output_product_id.
    const available=await client.query(
      "SELECT COALESCE(SUM(remaining_quantity),0) AS quantity FROM inventory_lots WHERE product_id=$1 AND warehouse_id=$2 AND remaining_quantity>0",
      [item.productId,item.warehouseId]
    );
    if(Number(available.rows[0].quantity)<item.quantity)throw new AppError("INSUFFICIENT_STOCK","الكمية المطلوبة أكبر من رصيد الصنف في المخزن",409);

    const consumed=await consumeWarehouseStock(client,{
      productId:item.productId,warehouseId:item.warehouseId,quantity:item.quantity,
      withdrawalId:h.rows[0].id,orderId:p.data.orderId??null,orderStageId:p.data.orderStageId??null,createdBy:request.user!.userId
    });

    const locations=consumed.locations;
    await client.query(`
      INSERT INTO shift_withdrawal_lines(withdrawal_id,product_id,warehouse_id,location_id,quantity,unit_id,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [h.rows[0].id,item.productId,item.warehouseId,locations.length===1?locations[0]:null,item.quantity,product.rows[0].unit_id,item.notes??null]
    );
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"shift_withdrawal",entityId:h.rows[0].id,afterData:h.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return h.rows[0];
  });
  return reply.code(201).send({data:result});
 });
}
