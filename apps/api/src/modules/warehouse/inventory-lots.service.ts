import type { PoolClient } from "pg";
import { AppError } from "../../http/errors.js";

export async function createInventoryLot(client: PoolClient, input: {
  productId:string; warehouseId:string; locationId:string; quantity:number; unitCost:number;
  batchCode?:string|null; sourceType:string; sourceId?:string|null;
}) {
  const r=await client.query(
    `INSERT INTO inventory_lots(product_id,warehouse_id,location_id,batch_code,unit_cost,original_quantity,remaining_quantity,source_type,source_id)
     VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8) RETURNING *`,
    [input.productId,input.warehouseId,input.locationId,input.batchCode??null,input.unitCost,input.quantity,input.sourceType,input.sourceId??null]
  );
  return r.rows[0];
}

export async function consumeInventoryLots(client: PoolClient, input: {
  movementId:string; productId:string; warehouseId:string; locationId:string; quantity:number;
}) {
  let remaining=input.quantity;
  let totalCost=0;
  const allocations:{lotId:string;quantity:number;unitCost:number;totalCost:number}[]=[];
  const lots=await client.query(
    `SELECT id,remaining_quantity,unit_cost
       FROM inventory_lots
      WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 AND remaining_quantity>0
      ORDER BY created_at ASC,id ASC
      FOR UPDATE`,
    [input.productId,input.warehouseId,input.locationId]
  );
  for(const lot of lots.rows){
    if(remaining<=1e-9)break;
    const available=Number(lot.remaining_quantity);
    const take=Math.min(remaining,available);
    const cost=take*Number(lot.unit_cost);
    await client.query(
      "UPDATE inventory_lots SET remaining_quantity=remaining_quantity-$1,updated_at=now() WHERE id=$2",
      [take,lot.id]
    );
    await client.query(
      "INSERT INTO stock_movement_lots(movement_id,lot_id,quantity,unit_cost,total_cost) VALUES($1,$2,$3,$4,$5)",
      [input.movementId,lot.id,take,lot.unit_cost,cost]
    );
    allocations.push({lotId:lot.id,quantity:take,unitCost:Number(lot.unit_cost),totalCost:cost});
    remaining-=take;
    totalCost+=cost;
  }
  if(remaining>1e-9){
    throw new AppError("INVENTORY_LOT_INSUFFICIENT","رصيد دفعات التكلفة لا يكفي لهذه الحركة. راجع أرصدة الدفعات.",409);
  }
  return {totalCost,unitCost:input.quantity>0?totalCost/input.quantity:0,allocations};
}

export async function adjustStockValueAfterLotConsumption(client: PoolClient, productId:string, warehouseId:string, locationId:string, actualCost:number) {
  const r=await client.query(
    "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
    [productId,warehouseId,locationId]
  );
  if(!r.rowCount)return;
  const quantity=Number(r.rows[0].quantity);
  const value=Math.max(0,Number(r.rows[0].inventory_value)-actualCost);
  const avg=quantity>0?value/quantity:0;
  await client.query(
    "UPDATE stock_balances SET inventory_value=$1,avg_unit_cost=$2,updated_at=now() WHERE product_id=$3 AND warehouse_id=$4 AND location_id=$5",
    [value,avg,productId,warehouseId,locationId]
  );
}
