import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";

const createSchema=z.object({
  employeeId:z.string().uuid(),
  custodyType:z.string().trim().min(2).max(80),
  description:z.string().trim().min(2).max(500),
  quantity:z.number().positive(),
  unitValue:z.number().nonnegative().default(0),
  dueDate:z.string().date().nullable().optional(),
  notes:z.string().trim().max(1000).nullable().optional()
});

const transferCustodySchema=z.object({
  toEmployeeId:z.string().uuid(),
  notes:z.string().trim().max(1000).nullable().optional()
});

const cashTransferSchema=z.object({
  fromEmployeeId:z.string().uuid(),
  toEmployeeId:z.string().uuid(),
  amount:z.number().positive(),
  transactionDate:z.string().date().optional(),
  description:z.string().trim().min(2).max(500),
  notes:z.string().trim().max(1000).nullable().optional()
}).refine(v=>v.fromEmployeeId!==v.toEmployeeId,{message:"لا يمكن التحويل لنفس الموظف",path:["toEmployeeId"]});

const settleSchema=z.object({
  returnedQuantity:z.number().nonnegative().default(0),
  lostQuantity:z.number().nonnegative().default(0),
  damageValue:z.number().nonnegative().default(0),
  shortageValue:z.number().nonnegative().default(0),
  notes:z.string().trim().max(1000).nullable().optional()
}).superRefine((v,ctx)=>{
  if(v.returnedQuantity+v.lostQuantity<=0)ctx.addIssue({code:"custom",path:["returnedQuantity"],message:"يجب تسجيل كمية مرتجعة أو مفقودة"});
});

async function workerInfo(userId:string){
  const r=await pool.query("SELECT u.employee_id,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE) AS is_worker FROM users u WHERE u.id=$1",[userId]);
  return r.rows[0]??null;
}

const cashSchema=z.object({
  employeeId:z.string().uuid().optional(),
  direction:z.enum(["IN","OUT"]),
  amount:z.number().positive(),
  transactionDate:z.string().date().optional(),
  description:z.string().trim().min(2).max(500),
  notes:z.string().trim().max(1000).nullable().optional(),
  sourceType:z.enum(["MANAGER_TOPUP","CASH_CUSTODY"]).optional().default("CASH_CUSTODY"),
  confirmDuplicate:z.boolean().optional().default(false)
}).superRefine((v,ctx)=>{
  if(v.sourceType==="MANAGER_TOPUP"&&v.direction!=="IN")ctx.addIssue({code:"custom",path:["direction"],message:"توريد المدير المالي يجب أن يكون حركة داخلة"});
});

async function cashAccess(client:import("pg").PoolClient,userId:string,employeeId:string|undefined,permissionCode:"cash_custody.view"|"cash_custody.create"){
  const user=await client.query("SELECT employee_id FROM users WHERE id=$1",[userId]);
  const row=user.rows[0];
  if(!row)throw new AppError("USER_NOT_FOUND","المستخدم غير موجود",403);
  // Scope comes from RBAC permissions, not role names. A non-finance role explicitly
  // granted an all-scope cash-custody permission must be able to manage all employees.
  if(await hasPermission(client,userId,permissionCode,"all"))return {employeeId:employeeId??null,isFinance:true};
  if(!row.employee_id)throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
  if(employeeId && employeeId!==row.employee_id)throw new AppError("OWN_SCOPE_ONLY","لا يمكنك الحركة إلا على عهدتك",403);
  return {employeeId:row.employee_id,isFinance:false};
}
export async function custodyRoutes(app:FastifyInstance){
  app.get("/api/custodies/eligible-employees",{preHandler:[authenticateRequest]},async(request)=>{
    const client=await pool.connect();
    try{
      const userId=request.user!.userId;
      // Own-scope permissions use their explicit *_own codes in the permission
      // catalog; checking the base code with scope="own" would miss those users.
      const permissionScopes:Array<[string,"own"|"all"]>=[
        ["custody.create","all"],["custody.create_own","own"],
        ["custody.view","all"],["custody.view_own","own"],
        ["cash_custody.create","all"],["cash_custody.create_own","own"],
        ["cash_custody.view","all"],["cash_custody.view_own","own"],
        ["custody.transfer","all"],["cash_custody.transfer","all"]
      ];
      let hasAny=false;let hasAll=false;
      for(const [code,scope] of permissionScopes){
        if(await hasPermission(client,userId,code,scope)){
          hasAny=true;
          if(scope==="all")hasAll=true;
        }
      }
      if(!hasAny)throw new AppError("FORBIDDEN","ليس لديك صلاحية لاختيار موظف في العهد",403);
      if(hasAll){
        const result=await client.query("SELECT id,code,full_name FROM employees WHERE is_active=TRUE ORDER BY full_name,code");
        return {data:result.rows};
      }
      const own=await client.query("SELECT e.id,e.code,e.full_name FROM users u JOIN employees e ON e.id=u.employee_id WHERE u.id=$1 AND e.is_active=TRUE",[userId]);
      return {data:own.rows};
    }finally{client.release();}
  });
  app.get("/api/custodies",{preHandler:[authenticateRequest]},async(request)=>{
    const user=await workerInfo(request.user!.userId);
    const scopeClient=await pool.connect();
    let canViewAll=false;let canViewOwn=false;
    try{canViewAll=await hasPermission(scopeClient,request.user!.userId,"custody.view","all");canViewOwn=await hasPermission(scopeClient,request.user!.userId,"custody.view_own","own")}finally{scopeClient.release()}
    const assignedOnly=!canViewAll&&!canViewOwn;
    if(assignedOnly){
      if(!user?.employee_id)throw new AppError("FORBIDDEN","لا توجد عهدة مسجلة على حسابك",403);
      const active=await pool.query("SELECT 1 FROM employee_custodies WHERE employee_id=$1 AND status IN ('ACTIVE','PARTIAL_RETURNED') LIMIT 1",[user.employee_id]);
      if(!active.rowCount)throw new AppError("FORBIDDEN","لا توجد عهدة مفتوحة على حسابك",403);
    }
    const params:unknown[]=[];const where:string[]=["c.status <> 'CANCELLED'"];
    if(!canViewAll){
      params.push(user!.employee_id);where.push("c.employee_id=$"+params.length);
      if(assignedOnly||user?.is_worker)where.push("c.status IN ('ACTIVE','PARTIAL_RETURNED')");
    }
    const r=await pool.query(
      `SELECT c.*,e.code AS employee_code,e.full_name AS employee_name,
              COALESCE((SELECT SUM(returned_quantity) FROM custody_settlements cs WHERE cs.custody_id=c.id),0) AS returned_quantity,
              COALESCE((SELECT SUM(lost_quantity) FROM custody_settlements cs WHERE cs.custody_id=c.id),0) AS lost_quantity,
              GREATEST(c.quantity-COALESCE((SELECT SUM(returned_quantity+lost_quantity) FROM custody_settlements cs WHERE cs.custody_id=c.id),0),0) AS remaining_quantity,
              (SELECT COUNT(*) FROM employee_custody_transfers ct WHERE ct.custody_id=c.id) AS transfer_count
         FROM employee_custodies c JOIN employees e ON e.id=c.employee_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.created_at DESC LIMIT 500`,params);
    return {data:r.rows};
  });

  app.post("/api/custodies",{preHandler:[authenticateRequest,requirePermission("custody.create")]},async(request,reply)=>{
    const p=createSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات العهدة غير صحيحة",422);
    const employee=await pool.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[p.data.employeeId]);
    if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
    const total=p.data.quantity*p.data.unitValue;
    const r=await withTransaction(async client=>{
      const x=await client.query(
        "INSERT INTO employee_custodies(employee_id,custody_type,description,quantity,unit_value,total_value,due_date,created_by,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [p.data.employeeId,p.data.custodyType,p.data.description,p.data.quantity,p.data.unitValue,total,p.data.dueDate??null,request.user!.userId,p.data.notes??null]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"custody",entityType:"employee_custody",entityId:x.rows[0].id,afterData:x.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return x.rows[0];
    });
    return reply.code(201).send({data:r});
  });

  app.get("/api/custodies/:id/settlements",{preHandler:[authenticateRequest]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const user=await workerInfo(request.user!.userId);
    const scopeClient=await pool.connect();
    let canViewAll=false;let canViewOwn=false;
    try{canViewAll=await hasPermission(scopeClient,request.user!.userId,"custody.view","all");canViewOwn=await hasPermission(scopeClient,request.user!.userId,"custody.view_own","own")}finally{scopeClient.release()}
    const params:unknown[]=[id];let scope="";
    if(!canViewAll){
      if(!user?.employee_id)throw new AppError("FORBIDDEN","لا توجد عهدة مرتبطة بحسابك",403);
      if(!canViewOwn){const active=await pool.query("SELECT 1 FROM employee_custodies WHERE id=$1 AND employee_id=$2 AND status IN ('ACTIVE','PARTIAL_RETURNED')",[id,user.employee_id]);if(!active.rowCount)throw new AppError("FORBIDDEN","لا يمكنك عرض سجل هذه العهدة",403)}
      params.push(user.employee_id);scope=" AND cs.employee_id=$2";
    }
    const r=await pool.query(
      `SELECT cs.*,u.username AS settled_by_username FROM custody_settlements cs JOIN users u ON u.id=cs.settled_by WHERE cs.custody_id=$1${scope} ORDER BY cs.settled_at DESC`,
      params
    );
    return {data:r.rows};
  });

  app.get("/api/custodies/:id/transfers",{preHandler:[authenticateRequest]},async(request)=>{
    const id=(request.params as {id:string}).id;const user=await workerInfo(request.user!.userId);const client=await pool.connect();
    try{
      const all=await hasPermission(client,request.user!.userId,"custody.view","all");const own=await hasPermission(client,request.user!.userId,"custody.view_own","own");
      if(!all&&!own){if(!user?.employee_id)throw new AppError("FORBIDDEN","لا يمكنك عرض سجل التحويل",403);const active=await client.query("SELECT 1 FROM employee_custodies WHERE id=$1 AND employee_id=$2 AND status IN ('ACTIVE','PARTIAL_RETURNED')",[id,user.employee_id]);if(!active.rowCount)throw new AppError("FORBIDDEN","لا يمكنك عرض سجل هذه العهدة",403)}
      const params:unknown[]=[id];let scope="";if(!all){params.push(user!.employee_id);scope=" AND (ct.from_employee_id=$2 OR ct.to_employee_id=$2)"}
      const rows=await client.query("SELECT ct.*,f.full_name AS from_employee_name,t.full_name AS to_employee_name,u.username AS created_by_username FROM employee_custody_transfers ct JOIN employees f ON f.id=ct.from_employee_id JOIN employees t ON t.id=ct.to_employee_id JOIN users u ON u.id=ct.created_by WHERE ct.custody_id=$1"+scope+" ORDER BY ct.created_at DESC",params);
      return {data:rows.rows};
    }finally{client.release()}
  });

  app.post("/api/custodies/:id/transfer",{preHandler:[authenticateRequest,requirePermission("custody.transfer")]},async(request,reply)=>{
    const id=(request.params as {id:string}).id;const p=transferCustodySchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات تحويل العهدة غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const custody=await client.query("SELECT * FROM employee_custodies WHERE id=$1 FOR UPDATE",[id]);if(!custody.rowCount)throw new AppError("CUSTODY_NOT_FOUND","العهدة غير موجودة",404);
      if(!["ACTIVE","PARTIAL_RETURNED"].includes(custody.rows[0].status))throw new AppError("CUSTODY_CLOSED","لا يمكن تحويل عهدة مغلقة أو تمت تسويتها",409);
      const sums=await client.query("SELECT COALESCE(SUM(returned_quantity+lost_quantity),0) AS accounted FROM custody_settlements WHERE custody_id=$1",[id]);const remaining=Number(custody.rows[0].quantity)-Number(sums.rows[0].accounted||0);
      if(remaining<=0)throw new AppError("CUSTODY_CLOSED","لا توجد كمية متبقية للتحويل",409);
      if(custody.rows[0].employee_id===p.data.toEmployeeId)throw new AppError("SAME_CUSTODY_OWNER","العهدة مسجلة بالفعل على هذا الموظف",422);
      const target=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[p.data.toEmployeeId]);if(!target.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف المستلم غير موجود أو غير نشط",422);
      const fromEmployeeId=custody.rows[0].employee_id;
      const transfer=await client.query("INSERT INTO employee_custody_transfers(custody_id,from_employee_id,to_employee_id,remaining_quantity,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[id,fromEmployeeId,p.data.toEmployeeId,remaining,p.data.notes??null,request.user!.userId]);
      const updated=await client.query("UPDATE employee_custodies SET employee_id=$1,updated_at=now() WHERE id=$2 RETURNING *",[p.data.toEmployeeId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"transfer",module:"custody",entityType:"employee_custody",entityId:id,beforeData:custody.rows[0],afterData:updated.rows[0],metadata:{transfer:transfer.rows[0]},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {custody:updated.rows[0],transfer:transfer.rows[0],remainingQuantity:remaining};
    });return reply.code(201).send({data:result});
  });

  app.post("/api/custodies/:id/settlements",{preHandler:[authenticateRequest,requirePermission("custody.settle")]},async(request,reply)=>{
    const id=(request.params as {id:string}).id;const p=settleSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات تسوية العهدة غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const custody=await client.query("SELECT * FROM employee_custodies WHERE id=$1 FOR UPDATE",[id]);
      if(!custody.rowCount)throw new AppError("CUSTODY_NOT_FOUND","العهدة غير موجودة",404);
      if(["RETURNED","CANCELLED","DAMAGED","LOST"].includes(custody.rows[0].status))throw new AppError("CUSTODY_CLOSED","العهدة مغلقة بالفعل",409);
      const returned=await client.query("SELECT COALESCE(SUM(returned_quantity+lost_quantity),0) AS q FROM custody_settlements WHERE custody_id=$1",[id]);
      const already=Number(returned.rows[0].q||0);const remaining=Number(custody.rows[0].quantity)-already;
      const accounted=p.data.returnedQuantity+p.data.lostQuantity;
      if(accounted>remaining+1e-9)throw new AppError("CUSTODY_RETURN_EXCEEDS_BALANCE","الكمية المرتجعة أو المفقودة أكبر من المتبقي في العهدة",409);
      const next=remaining-accounted;
      const status=next<=1e-9?(p.data.lostQuantity>0?"LOST":p.data.damageValue>0||p.data.shortageValue>0?"DAMAGED":"FULL"):"PARTIAL";
      const x=await client.query(
        "INSERT INTO custody_settlements(custody_id,employee_id,returned_quantity,lost_quantity,damage_value,shortage_value,status,notes,settled_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [id,custody.rows[0].employee_id,p.data.returnedQuantity,p.data.lostQuantity,p.data.damageValue,p.data.shortageValue,status,p.data.notes??null,request.user!.userId]
      );
      const custodyStatus=next<=1e-9?(status==="LOST"?"LOST":status==="DAMAGED"?"DAMAGED":"RETURNED"):"PARTIAL_RETURNED";
      const updated=await client.query("UPDATE employee_custodies SET status=$1,returned_at=CASE WHEN $2='RETURNED' OR $2='LOST' OR $2='DAMAGED' THEN now() ELSE returned_at END,updated_at=now() WHERE id=$3 RETURNING *",[custodyStatus,status,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"settle",module:"custody",entityType:"employee_custody",entityId:id,beforeData:custody.rows[0],afterData:updated.rows[0],metadata:{settlement:x.rows[0]},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {custody:updated.rows[0],settlement:x.rows[0],remainingQuantity:next};
    });
    return reply.code(201).send({data:result});
  });
  app.get("/api/cash-custody", { preHandler:[authenticateRequest,requireAnyPermission(["cash_custody.view","all"],["cash_custody.view_own","own"])] }, async(request)=>{
    const client=await pool.connect();
    try{
      const access=await cashAccess(client,request.user!.userId,undefined,"cash_custody.view");
      const params:unknown[]=[]; const where:string[]=[];
      if(!access.isFinance){params.push(access.employeeId);where.push("c.employee_id=$"+params.length);}
      const r=await client.query(`SELECT c.*,e.code AS employee_code,e.full_name AS employee_name,creator.username AS created_by_username,ct.code AS transfer_code,
        SUM(CASE WHEN c.direction='IN' THEN c.amount ELSE -c.amount END) OVER (
          PARTITION BY c.employee_id
          ORDER BY c.transaction_date,c.created_at,c.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS balance
        FROM cash_custody_transactions c JOIN employees e ON e.id=c.employee_id
        LEFT JOIN users creator ON creator.id=c.created_by
        LEFT JOIN cash_custody_transfers ct ON ct.id=c.transfer_id
        ${where.length?"WHERE "+where.join(" AND "):""}
        ORDER BY c.transaction_date DESC,c.created_at DESC,c.id DESC LIMIT 500`,params);
      return {data:r.rows};
    }finally{client.release();}
  });

  app.post("/api/cash-custody/transfers",{preHandler:[authenticateRequest,requirePermission("cash_custody.transfer")]},async(request,reply)=>{
    const p=cashTransferSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات تحويل العهدة النقدية غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const ids=[p.data.fromEmployeeId,p.data.toEmployeeId].sort();const locked=await client.query("SELECT id FROM employees WHERE id=ANY($1::uuid[]) AND is_active=TRUE ORDER BY id FOR UPDATE",[ids]);
      if(locked.rowCount!==2)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف المحول أو المستلم غير موجود أو غير نشط",422);
      const date=p.data.transactionDate??new Date().toISOString().slice(0,10);
      const balance=await client.query("SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1 AND transaction_date<=$2",[p.data.fromEmployeeId,date]);
      if(p.data.amount>Number(balance.rows[0]?.balance??0)+1e-9)throw new AppError("INSUFFICIENT_CASH_CUSTODY_BALANCE","مبلغ التحويل أكبر من رصيد العهدة النقدية المتاح",409);
      const transfer=await client.query("INSERT INTO cash_custody_transfers(from_employee_id,to_employee_id,amount,transaction_date,description,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[p.data.fromEmployeeId,p.data.toEmployeeId,p.data.amount,date,p.data.description,p.data.notes??null,request.user!.userId]);
      const txOut=await client.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,confirmed_duplicate,created_by,transfer_id) VALUES($1,'OUT',$2,$3,$4,$5,FALSE,$6,$7) RETURNING *",[p.data.fromEmployeeId,p.data.amount,date,"تحويل إلى موظف آخر: "+p.data.description,p.data.notes??null,request.user!.userId,transfer.rows[0].id]);
      const txIn=await client.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,confirmed_duplicate,created_by,transfer_id) VALUES($1,'IN',$2,$3,$4,$5,FALSE,$6,$7) RETURNING *",[p.data.toEmployeeId,p.data.amount,date,"استلام تحويل عهدة: "+p.data.description,p.data.notes??null,request.user!.userId,transfer.rows[0].id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"transfer",module:"cash_custody",entityType:"cash_custody_transfer",entityId:transfer.rows[0].id,afterData:transfer.rows[0],metadata:{outgoingTransactionId:txOut.rows[0].id,incomingTransactionId:txIn.rows[0].id},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {transfer:transfer.rows[0],outgoing:txOut.rows[0],incoming:txIn.rows[0]};
    });return reply.code(201).send({data:result});
  });


  const orderCollectionSchema=z.object({
    employeeId:z.string().uuid().optional(),
    orderId:z.string().uuid(),
    amount:z.number().positive(),
    transactionDate:z.string().date().optional(),
    description:z.string().trim().min(2).max(500),
    notes:z.string().trim().max(1000).nullable().optional()
  });

  // Customer collection is one atomic business event: company revenue plus cash
  // received into the collecting employee's custody. Internal custody transfers
  // never pass through this endpoint and therefore never create new revenue.
  app.post("/api/cash-custody/order-collections",{
    preHandler:[authenticateRequest,requireAnyPermission(["cash_custody.create","all"],["cash_custody.create_own","own"])]
  },async(request,reply)=>{
    const p=orderCollectionSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات تحصيل الطلبية غير صحيحة",422);
    const row=await withTransaction(async client=>{
      const access=await cashAccess(client,request.user!.userId,p.data.employeeId,"cash_custody.create");
      const employeeId=access.employeeId!;
      const date=p.data.transactionDate??new Date().toISOString().slice(0,10);
      const order=await client.query("SELECT id FROM production_orders WHERE id=$1 FOR SHARE",[p.data.orderId]);
      if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      const duplicate=await client.query("SELECT id FROM order_revenues WHERE order_id=$1 AND collected_by_employee_id=$2 AND amount=$3 AND revenue_date=$4 AND source='CUSTOMER_COLLECTION' LIMIT 1 FOR SHARE",[p.data.orderId,employeeId,p.data.amount,date]);
      if(duplicate.rowCount)throw new AppError("DUPLICATE_ORDER_COLLECTION","يوجد تحصيل بنفس الطلبية والموظف والمبلغ والتاريخ بالفعل؛ راجع الحركات قبل التسجيل مرة أخرى",409);
      const codeResult=await client.query("SELECT 'REV-' || lpad(nextval('revenue_code_seq')::text,8,'0') AS code");
      const revenue=await client.query(
        "INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by,collected_by_employee_id) VALUES($1,$2,$3,$4,'CUSTOMER_COLLECTION',$5,$6,$7) RETURNING *",
        [p.data.orderId,codeResult.rows[0].code,p.data.amount,date,p.data.notes??null,request.user!.userId,employeeId]
      );
      const cash=await client.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'IN',$2,$3,$4,$5,'ORDER_REVENUE',$6,$7) RETURNING *",
        [employeeId,p.data.amount,date,p.data.description,p.data.notes??null,revenue.rows[0].id,request.user!.userId]
      );
      const updated=await client.query("UPDATE order_revenues SET cash_custody_transaction_id=$1 WHERE id=$2 RETURNING *",[cash.rows[0].id,revenue.rows[0].id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"order_revenue_collection",entityId:updated.rows[0].id,afterData:{revenue:updated.rows[0],cashCustody:cash.rows[0]},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {revenue:updated.rows[0],cashCustody:cash.rows[0]};
    });
    return reply.code(201).send({data:row});
  });

  app.post("/api/cash-custody/check-duplicate",{preHandler:[authenticateRequest,requireAnyPermission(["cash_custody.create","all"],["cash_custody.create_own","own"])]},async(request)=>{
    const p=cashSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات حركة العهدة غير صحيحة",422);
    const client=await pool.connect();
    try{
      const access=await cashAccess(client,request.user!.userId,p.data.employeeId,"cash_custody.create");
      const employeeId=access.employeeId!;
      const r=await client.query(`SELECT c.code,c.amount,c.transaction_date,c.description,e.full_name AS employee_name
        FROM cash_custody_transactions c JOIN employees e ON e.id=c.employee_id
        WHERE c.employee_id=$1 AND c.direction=$2 AND c.amount=$3
          AND c.transaction_date=COALESCE($4::date,CURRENT_DATE)
        ORDER BY c.created_at DESC LIMIT 10`,
        [employeeId,p.data.direction,p.data.amount,p.data.transactionDate??null]);
      return {data:{duplicate:Boolean(r.rowCount),matches:r.rows}};
    }finally{client.release();}
  });

  app.post("/api/cash-custody",{preHandler:[authenticateRequest,requireAnyPermission(["cash_custody.create","all"],["cash_custody.create_own","own"])]},async(request,reply)=>{
    const p=cashSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات حركة العهدة غير صحيحة",422);
    const row=await withTransaction(async client=>{
      const access=await cashAccess(client,request.user!.userId,p.data.employeeId,"cash_custody.create");
      const employeeId=access.employeeId!;
      const date=p.data.transactionDate??new Date().toISOString().slice(0,10);
      // Serialize balance and duplicate checks per employee to prevent concurrent overspending.
      const employeeLock=await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[employeeId]);
      if(!employeeLock.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",422);
      if(p.data.direction==="OUT"){
        const balance=await client.query(
          "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1 AND transaction_date<=$2",
          [employeeId,date]
        );
        if(p.data.amount>Number(balance.rows[0]?.balance??0)+1e-9)throw new AppError("INSUFFICIENT_CASH_CUSTODY_BALANCE","المبلغ المطلوب صرفه أكبر من رصيد العهدة المتاح في هذا التاريخ",409);
      }
      const dup=await client.query(`SELECT id,code,description FROM cash_custody_transactions
        WHERE employee_id=$1 AND direction=$2 AND amount=$3 AND transaction_date=$4
        ORDER BY created_at DESC LIMIT 10 FOR SHARE`,
        [employeeId,p.data.direction,p.data.amount,date]);
      if(dup.rowCount && !p.data.confirmDuplicate){
        throw new AppError("DUPLICATE_CASH_CUSTODY","توجد حركة عهدة نقدية مشابهة بالفعل. راجعها ثم أكد تسجيل العملية الجديدة.",409);
      }
      const x=await client.query(`INSERT INTO cash_custody_transactions
        (employee_id,direction,amount,transaction_date,description,notes,source_type,confirmed_duplicate,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [employeeId,p.data.direction,p.data.amount,date,p.data.description,p.data.notes??null,p.data.sourceType,Boolean(dup.rowCount),request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"cash_custody",entityType:"cash_custody_transaction",entityId:x.rows[0].id,afterData:x.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return x.rows[0];
    });
    return reply.code(201).send({data:row});
  });
}
