import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const createSchema=z.object({
  employeeId:z.string().uuid(),
  custodyType:z.string().trim().min(2).max(80),
  description:z.string().trim().min(2).max(500),
  quantity:z.number().positive(),
  unitValue:z.number().nonnegative().default(0),
  dueDate:z.string().date().nullable().optional(),
  notes:z.string().trim().max(1000).nullable().optional()
});

const settleSchema=z.object({
  returnedQuantity:z.number().positive(),
  damageValue:z.number().nonnegative().default(0),
  shortageValue:z.number().nonnegative().default(0),
  notes:z.string().trim().max(1000).nullable().optional()
});

async function workerInfo(userId:string){
  const r=await pool.query("SELECT u.employee_id,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE) AS is_worker FROM users u WHERE u.id=$1",[userId]);
  return r.rows[0]??null;
}

export async function custodyRoutes(app:FastifyInstance){
  app.get("/api/custodies",{preHandler:[authenticateRequest,requirePermission("custody.view","own")]},async(request)=>{
    const user=await workerInfo(request.user!.userId);
    const params:unknown[]=[];const where:string[]=["c.status <> 'CANCELLED'"];
    if(user?.is_worker){
      if(!user.employee_id)throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
      params.push(user.employee_id);where.push("c.employee_id=$"+params.length);
    }
    const r=await pool.query(
      `SELECT c.*,e.code AS employee_code,e.full_name AS employee_name,
              COALESCE((SELECT SUM(returned_quantity) FROM custody_settlements cs WHERE cs.custody_id=c.id),0) AS returned_quantity,
              GREATEST(c.quantity-COALESCE((SELECT SUM(returned_quantity) FROM custody_settlements cs WHERE cs.custody_id=c.id),0),0) AS remaining_quantity
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

  app.get("/api/custodies/:id/settlements",{preHandler:[authenticateRequest,requirePermission("custody.view")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await pool.query(
      "SELECT cs.*,u.username AS settled_by_username FROM custody_settlements cs JOIN users u ON u.id=cs.settled_by WHERE cs.custody_id=$1 ORDER BY cs.settled_at DESC",
      [id]
    );
    return {data:r.rows};
  });

  app.post("/api/custodies/:id/settlements",{preHandler:[authenticateRequest,requirePermission("custody.settle")]},async(request,reply)=>{
    const id=(request.params as {id:string}).id;const p=settleSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات تسوية العهدة غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const custody=await client.query("SELECT * FROM employee_custodies WHERE id=$1 FOR UPDATE",[id]);
      if(!custody.rowCount)throw new AppError("CUSTODY_NOT_FOUND","العهدة غير موجودة",404);
      if(["RETURNED","CANCELLED","LOST"].includes(custody.rows[0].status))throw new AppError("CUSTODY_CLOSED","العهدة مغلقة بالفعل",409);
      const returned=await client.query("SELECT COALESCE(SUM(returned_quantity),0) AS q FROM custody_settlements WHERE custody_id=$1",[id]);
      const already=Number(returned.rows[0].q||0);const remaining=Number(custody.rows[0].quantity)-already;
      if(p.data.returnedQuantity>remaining+1e-9)throw new AppError("CUSTODY_RETURN_EXCEEDS_BALANCE","الكمية المرتجعة أكبر من المتبقي في العهدة",409);
      const next=remaining-p.data.returnedQuantity;
      const status=next<=1e-9?(p.data.shortageValue>0?"LOST":p.data.damageValue>0?"DAMAGED":"FULL"):"PARTIAL";
      const x=await client.query(
        "INSERT INTO custody_settlements(custody_id,employee_id,returned_quantity,damage_value,shortage_value,status,notes,settled_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [id,custody.rows[0].employee_id,p.data.returnedQuantity,p.data.damageValue,p.data.shortageValue,status,p.data.notes??null,request.user!.userId]
      );
      const custodyStatus=next<=1e-9?(status==="LOST"?"LOST":status==="DAMAGED"?"DAMAGED":"RETURNED"):"PARTIAL_RETURNED";
      const updated=await client.query("UPDATE employee_custodies SET status=$1,returned_at=CASE WHEN $2='RETURNED' OR $2='LOST' OR $2='DAMAGED' THEN now() ELSE returned_at END,updated_at=now() WHERE id=$3 RETURNING *",[custodyStatus,status,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"settle",module:"custody",entityType:"employee_custody",entityId:id,beforeData:custody.rows[0],afterData:updated.rows[0],metadata:{settlement:x.rows[0]},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {custody:updated.rows[0],settlement:x.rows[0],remainingQuantity:next};
    });
    return reply.code(201).send({data:result});
  });
}
