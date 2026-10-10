import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const requestSchema = z.object({
  amount: z.number().positive(),
  method: z.string().trim().min(1).max(50),
  transferReference: z.string().trim().min(3).max(120).nullable().optional()
}).superRefine((value, ctx) => {
  if (["VODAFONE_CASH", "INSTAPAY", "BANK"].includes(value.method) && !value.transferReference?.trim()) {
    ctx.addIssue({ code: "custom", path: ["transferReference"], message: "رقم التحويل أو الحساب مطلوب لطريقة القبض المختارة" });
  }
});
const paymentMethodSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,50}$/),
  name: z.string().trim().min(2).max(100),
  sortOrder: z.number().int().min(0).max(9999).default(0)
});

const rejectSchema = z.object({ reason: z.string().trim().min(2).max(500) });

function isUniqueViolation(error: unknown): boolean {
  const code=typeof error==="object"&&error!==null&&"code" in error?(error as {code?:unknown}).code:null;
  return code==="23505";
}

async function isWorker(userId:string) {
  const r=await pool.query(
    `SELECT u.employee_id, EXISTS(
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
       WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE
     ) AS is_worker
     FROM users u WHERE u.id=$1`,[userId]);
  return r.rows[0] ?? null;
}

async function lockEmployee(client: import("pg").PoolClient, employeeId:string) {
  const r=await client.query(
    "SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",
    [employeeId]
  );
  if (!r.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 409);
}

async function getBalance(client: import("pg").PoolClient, employeeId:string) {
  const r=await client.query(
    `SELECT COALESCE(SUM(credit_amount - debit_amount),0) AS balance
       FROM employee_earnings_ledger
      WHERE employee_id=$1`,
    [employeeId]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

export async function paymentsRoutes(app:FastifyInstance){
  app.get("/api/payment-methods",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async()=>{
    const r=await pool.query("SELECT code,name,is_active,sort_order FROM payment_methods WHERE is_active=TRUE ORDER BY sort_order,name");
    return {data:r.rows};
  });

  app.post("/api/payment-methods",{
    preHandler:[authenticateRequest,requirePermission("payment_methods.manage")]
  },async(request,reply)=>{
    const parsed=paymentMethodSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات طريقة القبض غير صحيحة",422);
    const r=await pool.query("INSERT INTO payment_methods(code,name,sort_order) VALUES($1,$2,$3) RETURNING *",[parsed.data.code,parsed.data.name,parsed.data.sortOrder]);
    return reply.code(201).send({data:r.rows[0]});
  });
  app.get("/api/payment-requests",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async(request)=>{
    const q=z.object({status:z.enum(["PENDING","APPROVED","REJECTED","CANCELLED","PAID"]).optional()}).safeParse(request.query);
    if(!q.success) throw new AppError("VALIDATION_ERROR","الفلاتر غير صحيحة",422);
    const user=await isWorker(request.user!.userId);
    const params:unknown[]=[]; const where:string[]=[];
    if(user?.is_worker){
      if(!user.employee_id) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
      params.push(user.employee_id); where.push(`pr.employee_id=$${params.length}`);
    }
    if(q.data.status){params.push(q.data.status);where.push(`pr.status=$${params.length}`);}
    const r=await pool.query(
      `SELECT pr.*,e.code employee_code,e.full_name employee_name,
              COALESCE(prefs.preference_value,'{}'::jsonb) AS employee_payout_details
       FROM payment_requests pr JOIN employees e ON e.id=pr.employee_id
       LEFT JOIN LATERAL (
         SELECT up.preference_value
           FROM users pu
           JOIN user_preferences up ON up.user_id=pu.id AND up.preference_key='payout-details'
          WHERE pu.employee_id=e.id AND pu.is_active=TRUE
          ORDER BY up.updated_at DESC
          LIMIT 1
       ) prefs ON TRUE
       ${where.length?"WHERE "+where.join(" AND "):""}
       ORDER BY pr.requested_at DESC LIMIT 200`,params);
    return {data:r.rows};
  });

  app.get("/api/payments/my-balance",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async(request)=>{
    const user=await isWorker(request.user!.userId);
    if(!user?.employee_id) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
    const client=await pool.connect();
    try{return {data:{balance:await getBalance(client,user.employee_id)}}}finally{client.release();}
  });

  app.post("/api/payment-requests",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.create", "own")]
  },async(request,reply)=>{
    const parsed=requestSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات طلب القبض غير صحيحة",422);
    const method=await pool.query("SELECT code FROM payment_methods WHERE code=$1 AND is_active=TRUE",[parsed.data.method]);
    if(!method.rowCount) throw new AppError("PAYMENT_METHOD_NOT_FOUND","طريقة القبض غير متاحة",422);

    const user=await isWorker(request.user!.userId);
    if(!user?.is_worker || !user.employee_id) throw new AppError("WORKER_ONLY","طلب القبض متاح للعامل فقط",403);

    let row;
    try {
      row=await withTransaction(async(client)=>{
      await lockEmployee(client,user.employee_id);
      const balance=await getBalance(client,user.employee_id);
      if(parsed.data.amount>balance) throw new AppError("INSUFFICIENT_BALANCE","المبلغ المطلوب أكبر من المستحق المتاح",409);
      const open=await client.query(
        "SELECT id FROM payment_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED') LIMIT 1 FOR UPDATE",
        [user.employee_id]);
      if(open.rowCount) throw new AppError("OPEN_REQUEST_EXISTS","يوجد طلب قبض مفتوح بالفعل",409);

      const inserted=await client.query(
        `INSERT INTO payment_requests(employee_id,amount,method,transfer_reference,requested_by)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [user.employee_id,parsed.data.amount,parsed.data.method,parsed.data.transferReference?.trim() || null,request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:user.employee_id,action:"create",module:"payments",entityType:"payment_request",entityId:inserted.rows[0].id,afterData:inserted.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return inserted.rows[0];
      });
    } catch(error) {
      if(isUniqueViolation(error)) throw new AppError("OPEN_REQUEST_EXISTS","يوجد طلب قبض مفتوح بالفعل",409);
      throw error;
    }
    return reply.code(201).send({data:row});
  });

  app.post("/api/payment-requests/:id/approve",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.approve")]
  },async(request)=>{
    const id=(request.params as {id:string}).id;
    const row=await withTransaction(async(client)=>{
      const owner=await client.query("SELECT employee_id FROM payment_requests WHERE id=$1",[id]);
      if(!owner.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      await lockEmployee(client,owner.rows[0].employee_id);
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="PENDING") throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالاعتماد",409);
      if(current.rows[0].requested_by===request.user!.userId) throw new AppError("SELF_APPROVAL","لا يمكنك اعتماد طلب قبض أنشأته بنفسك",409);
      const balance=await getBalance(client,current.rows[0].employee_id);
      if(Number(current.rows[0].amount)>balance) throw new AppError("INSUFFICIENT_BALANCE","المستحق المتاح لم يعد يكفي لهذا الطلب",409);

      // Approval means the finance user confirms that the money was actually paid.
      // Record the payment and ledger debit atomically to keep the available balance accurate.
      const payment=await client.query(
        `INSERT INTO worker_payments(employee_id,amount,method,payment_request_id,paid_by,notes,transfer_reference)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [current.rows[0].employee_id,current.rows[0].amount,current.rows[0].method,id,request.user!.userId,current.rows[0].transfer_reference ? "مرجع التحويل: "+current.rows[0].transfer_reference : null,current.rows[0].transfer_reference || null]);
      await client.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,worker_payment_id,created_by,notes)
         VALUES($1,'WORKER_PAYMENT',$2,$3,$4,$5)
         ON CONFLICT (worker_payment_id) WHERE worker_payment_id IS NOT NULL DO NOTHING`,
        [payment.rows[0].employee_id,payment.rows[0].amount,payment.rows[0].id,request.user!.userId,
         current.rows[0].transfer_reference ? "صرف طلب قبض "+current.rows[0].code+" — مرجع التحويل: "+current.rows[0].transfer_reference : "صرف طلب قبض "+current.rows[0].code]);

      let allocationRemaining=Number(payment.rows[0].amount);
      const productions=await client.query(
        `SELECT pe.id,
                GREATEST(0,COALESCE(pe.total_earning_amount,pe.earning_amount)-
                  COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_allocations wpa WHERE wpa.production_entry_id=pe.id),0)) AS remaining
           FROM production_entries pe
          WHERE pe.employee_id=$1 AND pe.status='APPROVED'
          ORDER BY pe.work_date ASC,pe.created_at ASC,pe.id ASC
          FOR UPDATE`,
        [payment.rows[0].employee_id]);
      for(const production of productions.rows){
        if(allocationRemaining<=0.000001) break;
        const take=Math.min(allocationRemaining,Number(production.remaining));
        if(take<=0.000001) continue;
        await client.query(
          `INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount)
           VALUES($1,$2,$3) ON CONFLICT(worker_payment_id,production_entry_id)
           DO UPDATE SET amount=worker_payment_allocations.amount+EXCLUDED.amount`,
          [payment.rows[0].id,production.id,take]);
        allocationRemaining-=take;
      }
      const updated=await client.query(
        `UPDATE payment_requests SET status='PAID',reviewed_by=$1,reviewed_at=now(),paid_payment_id=$2,updated_at=now()
          WHERE id=$3 RETURNING *`,
        [request.user!.userId,payment.rows[0].id,id]);
      await client.query(
        "INSERT INTO user_notifications(recipient_user_id,notification_type,title,body,entity_type,entity_id,created_by) SELECT requested_by,'PAYMENT_PAID','تم صرف طلب القبض',$1,'payment_request',$2,$3 FROM payment_requests WHERE id=$2 AND requested_by<>$3",
        ["تم اعتماد وصرف طلب القبض الخاص بك.", id, request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve_and_pay",module:"payments",entityType:"payment_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{worker_payment_id:payment.rows[0].id,amount:payment.rows[0].amount},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {request:updated.rows[0],payment:payment.rows[0]};
    });
    return {data:row};
  });

  app.post("/api/payment-requests/:id/reject",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.reject")]
  },async(request)=>{
    const id=(request.params as {id:string}).id; const parsed=rejectSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","سبب الرفض مطلوب",422);
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="PENDING") throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالرفض",409);
      if(current.rows[0].requested_by===request.user!.userId) throw new AppError("SELF_REVIEW","لا يمكنك مراجعة طلب أنشأته بنفسك",409);
      const updated=await client.query(
        `UPDATE payment_requests SET status='REJECTED',rejection_reason=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *`,
        [parsed.data.reason,request.user!.userId,id]);
      await client.query(
        "INSERT INTO user_notifications(recipient_user_id,notification_type,title,body,entity_type,entity_id,created_by) SELECT requested_by,'PAYMENT_REJECTED','تم رفض طلب القبض',$1,'payment_request',$2,$3 FROM payment_requests WHERE id=$2 AND requested_by<>$3",
        ["سبب الرفض: " + parsed.data.reason, id, request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject",module:"payments",entityType:"payment_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{reason:parsed.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.post("/api/payment-requests/:id/pay",{
    preHandler:[authenticateRequest,requirePermission("worker_payments.pay")]
  },async(request)=>{
    const id=(request.params as {id:string}).id;
    const row=await withTransaction(async(client)=>{
      const owner=await client.query("SELECT employee_id FROM payment_requests WHERE id=$1",[id]);
      if(!owner.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      // Keep the same employee -> request lock order used by request creation and approval.
      await lockEmployee(client,owner.rows[0].employee_id);
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="APPROVED") throw new AppError("INVALID_STATUS","يجب اعتماد الطلب قبل الدفع",409);
      const balance=await getBalance(client,current.rows[0].employee_id);
      if(Number(current.rows[0].amount)>balance) throw new AppError("INSUFFICIENT_BALANCE","المستحق المتاح لم يعد يكفي لهذا الطلب",409);
      const payment=await client.query(
        `INSERT INTO worker_payments(employee_id,amount,method,payment_request_id,paid_by,notes,transfer_reference)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [current.rows[0].employee_id,current.rows[0].amount,current.rows[0].method,id,request.user!.userId,current.rows[0].transfer_reference ? "مرجع التحويل: "+current.rows[0].transfer_reference : null,current.rows[0].transfer_reference || null]);
      const updated=await client.query(
        `UPDATE payment_requests SET status='PAID',paid_payment_id=$1,updated_at=now() WHERE id=$2 RETURNING *`,
        [payment.rows[0].id,id]);
      await client.query(
        `INSERT INTO employee_earnings_ledger(
           employee_id,entry_type,debit_amount,worker_payment_id,created_by,notes
         )
         VALUES($1,'WORKER_PAYMENT',$2,$3,$4,'Worker payment')
         ON CONFLICT (worker_payment_id) WHERE worker_payment_id IS NOT NULL DO NOTHING`,
        [payment.rows[0].employee_id,payment.rows[0].amount,payment.rows[0].id,request.user!.userId]);

      let allocationRemaining = Number(payment.rows[0].amount);
      const productions = await client.query(
        `SELECT pe.id,
                GREATEST(0,COALESCE(pe.total_earning_amount,pe.earning_amount)-
                  COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_allocations wpa WHERE wpa.production_entry_id=pe.id),0)) AS remaining
           FROM production_entries pe
          WHERE pe.employee_id=$1 AND pe.status='APPROVED'
          ORDER BY pe.work_date ASC,pe.created_at ASC,pe.id ASC
          FOR UPDATE`,
        [payment.rows[0].employee_id]
      );
      for (const production of productions.rows) {
        if (allocationRemaining <= 0.000001) break;
        const take = Math.min(allocationRemaining, Number(production.remaining));
        if (take <= 0.000001) continue;
        await client.query(
          `INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount)
           VALUES($1,$2,$3)
           ON CONFLICT(worker_payment_id,production_entry_id) DO UPDATE SET amount=worker_payment_allocations.amount+EXCLUDED.amount`,
          [payment.rows[0].id,production.id,take]
        );
        allocationRemaining -= take;
      }

      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"pay",module:"payments",entityType:"worker_payment",entityId:payment.rows[0].id,afterData:payment.rows[0],metadata:{payment_request_id:id},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {request:updated.rows[0],payment:payment.rows[0]};
    });
    return {data:row};
  });
}
