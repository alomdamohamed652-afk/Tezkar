import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const auditFilter=z.object({
  from:z.string().date().optional(),
  to:z.string().date().optional(),
  module:z.string().trim().max(80).optional(),
  action:z.string().trim().max(80).optional(),
  actorUserId:z.string().uuid().optional(),
  entityType:z.string().trim().max(100).optional(),
  q:z.string().trim().max(160).optional(),
  limit:z.coerce.number().int().min(1).max(500).default(200)
}).refine(v=>!v.from||!v.to||v.from<=v.to,{message:"تاريخ البداية يجب ألا يتجاوز تاريخ النهاية"});

export async function auditRoutes(app:FastifyInstance){
  app.get("/api/audit-logs",{preHandler:[authenticateRequest,requirePermission("audit.view")]},async(request)=>{
    const parsed=auditFilter.safeParse(request.query);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","فلاتر سجل النظام غير صحيحة",422);
    const q=parsed.data;
    const params:unknown[]=[];const where:string[]=[];
    const add=(clause:string,value:unknown)=>{params.push(value);where.push(clause.replace("?", "$"+params.length));};
    if(q.from)add("a.created_at >= ?::date",q.from);
    if(q.to)add("a.created_at < (?::date + interval '1 day')",q.to);
    if(q.module)add("a.module = ?",q.module);
    if(q.action)add("a.action = ?",q.action);
    if(q.actorUserId)add("a.actor_user_id = ?",q.actorUserId);
    if(q.entityType)add("a.entity_type = ?",q.entityType);
    if(q.q){
      params.push("%"+q.q+"%");const n=params.length;
      where.push(`(COALESCE(u.username,'') ILIKE $${n} OR COALESCE(e.full_name,'') ILIKE $${n} OR a.module ILIKE $${n} OR a.entity_type ILIKE $${n} OR a.action ILIKE $${n} OR COALESCE(a.entity_id::text,'') ILIKE $${n} OR COALESCE(a.request_id,'') ILIKE $${n} OR COALESCE(a.before_data::text,'') ILIKE $${n} OR COALESCE(a.after_data::text,'') ILIKE $${n} OR COALESCE(a.metadata::text,'') ILIKE $${n})`);
    }
    const whereSql=where.length?" WHERE "+where.join(" AND "):"";
    const result=await pool.query(`SELECT a.id,a.actor_user_id,a.actor_employee_id,a.action,a.module,a.entity_type,a.entity_id,a.request_id,a.ip_address,a.user_agent,a.before_data,a.after_data,a.metadata,a.created_at,
      COALESCE(u.username,'حساب غير متاح') AS actor_username,e.full_name AS actor_employee_name
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN employees e ON e.id=a.actor_employee_id
      ${whereSql} ORDER BY a.created_at DESC,a.id DESC LIMIT $${params.length+1}`,[...params,q.limit]);
    const [modules,actions,actors]=await Promise.all([
      pool.query("SELECT DISTINCT module FROM audit_log ORDER BY module"),
      pool.query("SELECT DISTINCT action FROM audit_log ORDER BY action"),
      pool.query("SELECT DISTINCT u.id,u.username FROM audit_log a JOIN users u ON u.id=a.actor_user_id ORDER BY u.username")
    ]);
    return {data:result.rows,filters:{from:q.from??null,to:q.to??null,module:q.module??null,action:q.action??null,actorUserId:q.actorUserId??null,entityType:q.entityType??null,q:q.q??null,limit:q.limit},options:{modules:modules.rows.map(r=>r.module),actions:actions.rows.map(r=>r.action),actors:actors.rows}};
  });
}
