import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";

const createSchema = z.object({
  title: z.string().trim().min(3).max(240),
  description: z.string().trim().max(4000).nullable().optional(),
  priority: z.enum(["LOW","NORMAL","HIGH","URGENT"]).default("NORMAL"),
  dueDate: z.string().date().nullable().optional(),
  assigneeEmployeeIds: z.array(z.string().uuid()).max(50).default([])
});
const updateSchema = z.object({
  title: z.string().trim().min(3).max(240).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  status: z.enum(["OPEN","IN_PROGRESS","BLOCKED","COMPLETED","CANCELLED"]).optional(),
  priority: z.enum(["LOW","NORMAL","HIGH","URGENT"]).optional(),
  dueDate: z.string().date().nullable().optional(),
  assigneeEmployeeIds: z.array(z.string().uuid()).max(50).optional()
});

export async function taskRoutes(app: FastifyInstance) {
  app.get("/api/tasks", { preHandler: [authenticateRequest, requireAnyPermission(["tasks.view","all"],["tasks.view_own","own"])] }, async (request) => {
    const client = await pool.connect();
    try {
      const all = await hasPermission(client, request.user!.userId, "tasks.view", "all");
      const employeeId = request.user!.employeeId;
      const params: unknown[] = [];
      const where: string[] = [];
      const q = request.query as { status?: string; search?: string };
      if (q.status && ["OPEN","IN_PROGRESS","BLOCKED","COMPLETED","CANCELLED"].includes(q.status)) {
        params.push(q.status); where.push("t.status=$" + params.length);
      }
      if (q.search?.trim()) {
        params.push("%" + q.search.trim() + "%");
        where.push("(t.code ILIKE $" + params.length + " OR t.title ILIKE $" + params.length + " OR COALESCE(t.description,'') ILIKE $" + params.length + ")");
      }
      if (!all) {
        if (!employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED", "الحساب غير مرتبط بموظف", 403);
        params.push(employeeId);
        where.push("EXISTS(SELECT 1 FROM task_assignees own WHERE own.task_id=t.id AND own.employee_id=$" + params.length + ")");
      }
      const result = await client.query(
        `SELECT t.*, creator.username AS creator_username,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('employee_id',e.id,'employee_code',e.code,'employee_name',e.full_name) ORDER BY e.full_name)
            FROM task_assignees ta JOIN employees e ON e.id=ta.employee_id WHERE ta.task_id=t.id),'[]'::jsonb) AS assignees,
          (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id=t.id)::int AS comment_count
         FROM tasks t JOIN users creator ON creator.id=t.created_by
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 WHEN 'BLOCKED' THEN 2 ELSE 3 END,
                  CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                  t.due_date NULLS LAST,t.created_at DESC LIMIT 500`, params);
      return { data: result.rows };
    } finally { client.release(); }
  });

  app.post("/api/tasks", { preHandler: [authenticateRequest, requirePermission("tasks.create")] }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات المهمة غير صحيحة", 422);
    const result = await withTransaction(async client => {
      if (parsed.data.assigneeEmployeeIds.length) {
        const valid = await client.query("SELECT id FROM employees WHERE id=ANY($1::uuid[]) AND is_active=TRUE", [parsed.data.assigneeEmployeeIds]);
        if (valid.rowCount !== new Set(parsed.data.assigneeEmployeeIds).size) throw new AppError("ASSIGNEE_NOT_FOUND", "يوجد موظف غير موجود أو غير نشط ضمن المكلفين", 422);
      }
      const inserted = await client.query(
        "INSERT INTO tasks(title,description,priority,due_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [parsed.data.title, parsed.data.description ?? null, parsed.data.priority, parsed.data.dueDate ?? null, request.user!.userId]);
      const task = inserted.rows[0];
      for (const employeeId of [...new Set(parsed.data.assigneeEmployeeIds)]) {
        await client.query("INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)", [task.id, employeeId, request.user!.userId]);
        await client.query(
          `INSERT INTO user_notifications(recipient_user_id,notification_type,title,body,entity_type,entity_id,created_by)
           SELECT u.id,'TASK_ASSIGNED','مهمة جديدة',$2,'task',$3,$4
             FROM users u WHERE u.employee_id=$1 AND u.is_active=TRUE AND u.id<>$4`,
          [employeeId, task.title, task.id, request.user!.userId]);
      }
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "create", module: "tasks", entityType: "task", entityId: task.id, afterData: task, ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null });
      return task;
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/tasks/:id", { preHandler: [authenticateRequest, requireAnyPermission(["tasks.edit","all"],["tasks.update_own","own"])] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات تعديل المهمة غير صحيحة", 422);
    return withTransaction(async client => {
      const before = await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id]);
      if (!before.rowCount) throw new AppError("TASK_NOT_FOUND", "المهمة غير موجودة", 404);
      const canEdit = await hasPermission(client, request.user!.userId, "tasks.edit", "all");
      if (!canEdit) {
        const assigned = await client.query("SELECT 1 FROM task_assignees WHERE task_id=$1 AND employee_id=$2", [id, request.user!.employeeId]);
        if (!assigned.rowCount) throw new AppError("TASK_FORBIDDEN", "يمكنك تحديث المهام المسندة إليك فقط", 403);
        if (parsed.data.title !== undefined || parsed.data.description !== undefined || parsed.data.priority !== undefined || parsed.data.dueDate !== undefined || parsed.data.assigneeEmployeeIds !== undefined) {
          throw new AppError("TASK_EDIT_FORBIDDEN", "لا يمكنك تعديل بيانات المهمة الأساسية", 403);
        }
      }
      const p = parsed.data;
      const fields: string[] = []; const values: unknown[] = [];
      const add = (col: string, value: unknown) => { values.push(value); fields.push(col + "=$" + values.length); };
      if (p.title !== undefined) add("title", p.title);
      if (p.description !== undefined) add("description", p.description);
      if (p.status !== undefined) { add("status", p.status); if (p.status === "COMPLETED") add("completed_at", new Date().toISOString()); else add("completed_at", null); }
      if (p.priority !== undefined) add("priority", p.priority);
      if (p.dueDate !== undefined) add("due_date", p.dueDate);
      values.push(id);
      const updated = fields.length
        ? await client.query("UPDATE tasks SET " + fields.join(",") + ",updated_at=now() WHERE id=$" + values.length + " RETURNING *", values)
        : before;
      if (p.assigneeEmployeeIds !== undefined) {
        const ids = [...new Set(p.assigneeEmployeeIds)];
        if (ids.length) {
          const valid = await client.query("SELECT id FROM employees WHERE id=ANY($1::uuid[]) AND is_active=TRUE", [ids]);
          if (valid.rowCount !== ids.length) throw new AppError("ASSIGNEE_NOT_FOUND", "يوجد موظف غير موجود أو غير نشط ضمن المكلفين", 422);
        }
        await client.query("DELETE FROM task_assignees WHERE task_id=$1", [id]);
        for (const employeeId of ids) await client.query("INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)", [id,employeeId,request.user!.userId]);
      }
      if (p.status !== undefined && p.status !== before.rows[0].status) {
        await client.query(
          `INSERT INTO user_notifications(recipient_user_id,notification_type,title,body,entity_type,entity_id,created_by)
           SELECT DISTINCT recipients.user_id,'TASK_STATUS','تحديث حالة مهمة',$2,'task',$3,$4
             FROM (
               SELECT t.created_by AS user_id FROM tasks t WHERE t.id=$3
               UNION
               SELECT u.id AS user_id FROM task_assignees ta JOIN users u ON u.employee_id=ta.employee_id AND u.is_active=TRUE WHERE ta.task_id=$3
             ) recipients
            WHERE recipients.user_id IS NOT NULL AND recipients.user_id<>$4`,
          [null, `تم تغيير حالة المهمة «${updated.rows[0].title}» إلى ${p.status}`, id, request.user!.userId]);
      }
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "update", module: "tasks", entityType: "task", entityId: id, beforeData: before.rows[0], afterData: updated.rows[0], ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null });
      return { data: updated.rows[0] };
    });
  });

  app.get("/api/tasks/:id/comments", { preHandler: [authenticateRequest, requireAnyPermission(["tasks.view","all"],["tasks.view_own","own"])] }, async request => {
    const id = (request.params as { id: string }).id;
    const client = await pool.connect();
    try {
      const all = await hasPermission(client, request.user!.userId, "tasks.view", "all");
      const params: unknown[] = [id]; let ownClause = "";
      if (!all) {
        if (!request.user!.employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED", "الحساب غير مرتبط بموظف", 403);
        params.push(request.user!.employeeId);
        ownClause = " AND EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.employee_id=$2)";
      }
      const task = await client.query("SELECT t.id FROM tasks t WHERE t.id=$1" + ownClause, params);
      if (!task.rowCount) throw new AppError("TASK_NOT_FOUND", "المهمة غير موجودة أو غير متاحة لك", 404);
      const comments = await client.query("SELECT c.*,u.username AS author_username FROM task_comments c JOIN users u ON u.id=c.author_user_id WHERE c.task_id=$1 ORDER BY c.created_at", [id]);
      return { data: comments.rows };
    } finally { client.release(); }
  });

  app.post("/api/tasks/:id/comments", { preHandler: [authenticateRequest, requirePermission("tasks.comment","own")] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب تعليقًا صحيحًا", 422);
    const result = await withTransaction(async client => {
      const task = await client.query("SELECT id FROM tasks WHERE id=$1 AND status<>'CANCELLED'", [id]);
      if (!task.rowCount) throw new AppError("TASK_NOT_FOUND", "المهمة غير موجودة", 404);
      const canSeeAll = await hasPermission(client, request.user!.userId, "tasks.view", "all");
      if (!canSeeAll) {
        const assigned = await client.query("SELECT 1 FROM task_assignees WHERE task_id=$1 AND employee_id=$2", [id,request.user!.employeeId]);
        if (!assigned.rowCount) throw new AppError("TASK_FORBIDDEN", "التعليق متاح للمكلفين بالمهمة فقط", 403);
      }
      const comment = await client.query("INSERT INTO task_comments(task_id,author_user_id,body) VALUES($1,$2,$3) RETURNING *", [id,request.user!.userId,parsed.data.body]);
      return comment.rows[0];
    });
    return reply.code(201).send({ data: result });
  });
}
