import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticate, hashPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

export async function accountRoutes(app: FastifyInstance) {
  app.post("/api/account/change-password", { preHandler: [authenticateRequest, requirePermission("account.change_password")] }, async (request) => {
    const parsed=z.object({
      currentPassword:z.string().min(1).max(200),
      newPassword:z.string().min(12).max(200),
      confirmPassword:z.string().min(12).max(200)
    }).safeParse(request.body);
    if(!parsed.success || parsed.data.newPassword!==parsed.data.confirmPassword)
      throw new AppError("VALIDATION_ERROR","بيانات كلمة المرور الجديدة غير صحيحة",422);

    await withTransaction(async client=>{
      const user=await authenticate(client, request.user!.username, parsed.data.currentPassword);
      if(user.userId!==request.user!.userId) throw new AppError("PASSWORD_INVALID","كلمة المرور الحالية غير صحيحة",401);
      await client.query("UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2",[hashPassword(parsed.data.newPassword),request.user!.userId]);
      await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"change_password",module:"auth",entityType:"user",entityId:request.user!.userId,ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
    });
    return {data:{success:true}};
  });

  app.get("/api/account/profile", { preHandler: [authenticateRequest] }, async (request) => {
    const r=await pool.query(
      `SELECT u.username,u.code,e.full_name,e.code AS employee_code,
              COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),'{}') AS roles
         FROM users u
         LEFT JOIN employees e ON e.id=u.employee_id
         LEFT JOIN user_roles ur ON ur.user_id=u.id
         LEFT JOIN roles r ON r.id=ur.role_id
        WHERE u.id=$1
        GROUP BY u.id,e.full_name,e.code`,[request.user!.userId]);
    return {data:r.rows[0]};
  });
}
