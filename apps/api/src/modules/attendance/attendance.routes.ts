import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const rowSchema=z.object({No:z.union([z.string(),z.number()]).transform(String),"Date/Time":z.union([z.string(),z.number()]).transform(String),Status:z.unknown().optional(),Department:z.unknown().optional(),Name:z.unknown().optional(),"Location ID":z.unknown().optional(),"ID Number":z.unknown().optional(),VerifyCode:z.unknown().optional(),CardNo:z.unknown().optional()});
const importSchema=z.object({sourceName:z.string().trim().min(1).max(255).default("attendance-import"),rows:z.array(z.record(z.string(),z.unknown())).min(1).max(5000)});
const settingSchema=z.object({deviceCode:z.string().trim().max(80).nullable(),lateGraceMinutes:z.number().int().min(0).max(240).default(10),earlyGraceMinutes:z.number().int().min(0).max(240).default(5)});
const timePattern=/^([01]\d|2[0-3]):[0-5]\d$/;
const scheduleSchema=z.object({days:z.array(z.object({weekday:z.number().int().min(0).max(6),startsAt:z.string().regex(timePattern).nullable(),endsAt:z.string().regex(timePattern).nullable(),isDayOff:z.boolean()})).max(7)});
const str=(v:unknown)=>v==null?"":String(v).trim();
function methodFrom(raw:string):"FINGERPRINT"|"PASSWORD"|"CARD"|"UNKNOWN"{const s=raw.toLowerCase();if(s.includes("finger")||s.includes("بصمة"))return "FINGERPRINT";if(s.includes("password")||s.includes("كلمة"))return "PASSWORD";if(s.includes("card")||s.includes("كارت")||s.includes("badge"))return "CARD";return "UNKNOWN";}
function cairoWallTimeToUtc(wall:Date):Date{const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Cairo",timeZoneName:"shortOffset"}).formatToParts(wall);const zone=parts.find(p=>p.type==="timeZoneName")?.value??"GMT+2";const m=zone.match(/GMT([+-])(\\d{1,2})(?::(\\d{2}))?/);const sign=m?.[1]==="-"?-1:1;const minutes=sign*((Number(m?.[2]??2)*60)+Number(m?.[3]??0));return new Date(wall.getTime()-minutes*60000);}
function parseTimestamp(raw:string):Date|null{if(!raw)return null;if(/(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(raw)){const absolute=new Date(raw);return Number.isNaN(absolute.getTime())?null:absolute;}let wall:Date;if(/^\\d+(\\.\\d+)?$/.test(raw)){const n=Number(raw);if(n<=20000||n>=80000)return null;wall=new Date(Date.UTC(1899,11,30)+n*86400000);}else{const parsed=new Date(raw);if(Number.isNaN(parsed.getTime()))return null;wall=new Date(Date.UTC(parsed.getFullYear(),parsed.getMonth(),parsed.getDate(),parsed.getHours(),parsed.getMinutes(),parsed.getSeconds(),parsed.getMilliseconds()));}return cairoWallTimeToUtc(wall);}
function statusFrom(raw:string):string{const s=raw.toLowerCase();if(s==="c/in"||s==="in"||s.includes("check in"))return "IN";if(s==="c/out"||s==="out"||s.includes("check out"))return "OUT";if(s.includes("overtime in"))return "OVERTIME_IN";if(s.includes("overtime out"))return "OVERTIME_OUT";return "UNKNOWN";}

export async function attendanceRoutes(app:FastifyInstance){
 app.get("/api/attendance",{preHandler:[authenticateRequest,requirePermission("attendance.view")]},async request=>{
  const q=request.query as {from?:string;to?:string;review?:string};const args:unknown[]=[];const where:string[]=[];
  if(q.from){args.push(q.from);where.push(`p.punch_at >= $${args.length}::date`);}
  if(q.to){args.push(q.to);where.push(`p.punch_at < ($${args.length}::date + interval '1 day')`);}
  if(q.review&&["PENDING","APPROVED","REJECTED"].includes(q.review)){args.push(q.review);where.push(`p.review_status=$${args.length}`);}
  const rows=await pool.query(`SELECT p.id,p.device_code,p.punch_at,p.status,p.verify_method,p.suspicious,p.duplicate_of,p.review_status,p.location_id,p.card_no,p.id_number,e.id employee_id,e.full_name employee_name,e.code employee_code,b.source_name FROM attendance_punches p LEFT JOIN employees e ON e.id=p.employee_id LEFT JOIN attendance_import_batches b ON b.id=p.batch_id ${where.length?"WHERE "+where.join(" AND"):""} ORDER BY p.punch_at DESC LIMIT 1000`,args);
  const summary=await pool.query("SELECT count(*)::int total,count(*) FILTER(WHERE review_status='PENDING')::int pending,count(*) FILTER(WHERE suspicious)::int suspicious,count(*) FILTER(WHERE employee_id IS NULL)::int unknown FROM attendance_punches");
  const batches=await pool.query("SELECT id,source_name,total_rows,inserted_rows,duplicate_rows,suspicious_rows,unknown_rows,created_at FROM attendance_import_batches ORDER BY created_at DESC LIMIT 20");
  return {data:rows.rows,summary:summary.rows[0],batches:batches.rows};
 });
 app.get("/api/attendance/settings",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async()=>{
  const employees=await pool.query(`SELECT e.id,e.code,e.full_name,e.is_active,s.device_code,COALESCE(s.late_grace_minutes,10)::int late_grace_minutes,COALESCE(s.early_grace_minutes,5)::int early_grace_minutes FROM employees e LEFT JOIN attendance_employee_settings s ON s.employee_id=e.id ORDER BY e.code`);
  const schedules=await pool.query("SELECT employee_id,weekday,starts_at::text,ends_at::text,is_day_off FROM attendance_weekly_schedule ORDER BY employee_id,weekday");
  const exceptions=await pool.query("SELECT id,employee_id,start_date,end_date,starts_at::text,ends_at::text,is_day_off,note FROM attendance_schedule_exceptions WHERE end_date>=CURRENT_DATE-30 ORDER BY start_date DESC LIMIT 200");
  return {employees:employees.rows,schedules:schedules.rows,exceptions:exceptions.rows};
 });
 app.put("/api/attendance/settings/:employeeId",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const id=(request.params as {employeeId:string}).employeeId;const parsed=settingSchema.safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!parsed.success)throw new AppError("VALIDATION_ERROR","إعدادات البصمة غير صحيحة",422);
  const d=parsed.data;const saved=await withTransaction(async client=>{
   if(!(await client.query("SELECT id FROM employees WHERE id=$1",[id])).rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
   if(d.deviceCode&&(await client.query("SELECT employee_id FROM attendance_employee_settings WHERE device_code=$1 AND employee_id<>$2",[d.deviceCode,id])).rowCount)throw new AppError("DEVICE_CODE_IN_USE","كود الجهاز مربوط بموظف آخر",409);
   const r=await client.query(`INSERT INTO attendance_employee_settings(employee_id,device_code,late_grace_minutes,early_grace_minutes) VALUES($1,$2,$3,$4) ON CONFLICT(employee_id) DO UPDATE SET device_code=EXCLUDED.device_code,late_grace_minutes=EXCLUDED.late_grace_minutes,early_grace_minutes=EXCLUDED.early_grace_minutes,updated_at=now() RETURNING employee_id,device_code,late_grace_minutes,early_grace_minutes`,[id,d.deviceCode||null,d.lateGraceMinutes,d.earlyGraceMinutes]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update",module:"attendance",entityType:"attendance_settings",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});return r.rows[0];
  });return {data:saved};
 });
 app.put("/api/attendance/schedule/:employeeId",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const id=(request.params as {employeeId:string}).employeeId;const p=scheduleSchema.safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!p.success||(p.success&&new Set(p.data.days.map(d=>d.weekday)).size!==p.data.days.length))throw new AppError("VALIDATION_ERROR","جدول الوردية غير صحيح أو به يوم مكرر",422);
  const result=await withTransaction(async client=>{
   if(!(await client.query("SELECT id FROM employees WHERE id=$1",[id])).rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
   for(const d of p.data.days)await client.query(`INSERT INTO attendance_weekly_schedule(employee_id,weekday,starts_at,ends_at,is_day_off) VALUES($1,$2,$3,$4,$5) ON CONFLICT(employee_id,weekday) DO UPDATE SET starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,is_day_off=EXCLUDED.is_day_off,updated_at=now()`,[id,d.weekday,d.isDayOff?null:d.startsAt,d.isDayOff?null:d.endsAt,d.isDayOff]);
   return (await client.query("SELECT weekday,starts_at::text,ends_at::text,is_day_off FROM attendance_weekly_schedule WHERE employee_id=$1 ORDER BY weekday",[id])).rows;
  });return {data:result};
 });
 app.post("/api/attendance/exceptions",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const p=z.object({employeeId:z.string().uuid(),startDate:z.string().date(),endDate:z.string().date(),startsAt:z.string().regex(timePattern).nullable().optional(),endsAt:z.string().regex(timePattern).nullable().optional(),isDayOff:z.boolean().default(false),note:z.string().trim().max(500).nullable().optional()}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","استثناء الجدول غير صحيح",422);
  const d=p.data;if(d.endDate<d.startDate||(!d.isDayOff&&(!d.startsAt||!d.endsAt)))throw new AppError("VALIDATION_ERROR","استثناء الجدول غير صحيح",422);
  const r=await pool.query("INSERT INTO attendance_schedule_exceptions(employee_id,start_date,end_date,starts_at,ends_at,is_day_off,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[d.employeeId,d.startDate,d.endDate,d.isDayOff?null:d.startsAt,d.isDayOff?null:d.endsAt,d.isDayOff,d.note??null,request.user!.userId]);return {data:r.rows[0]};
 });
 app.post("/api/attendance/import",{preHandler:[authenticateRequest,requirePermission("attendance.import")]},async(request,reply)=>{
  const p=importSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","ملف الاستيراد غير صحيح أو يتجاوز 5000 حركة",422);
  const rows=p.data.rows.map((raw,index)=>{
   const parsed=rowSchema.safeParse(raw);if(!parsed.success)throw new AppError("INVALID_IMPORT_ROW",`بيانات الحركة رقم ${index+1} ناقصة؛ تأكد من عمودي No و Date/Time`,422);
   const r=parsed.data,at=parseTimestamp(str(r["Date/Time"])),code=str(r.No);if(!at||!code)throw new AppError("INVALID_IMPORT_ROW",`كود الجهاز أو تاريخ الحركة رقم ${index+1} غير صالح`,422);
   const state=str(r.Status),verify=str(r.VerifyCode),location=str(r["Location ID"]),idNumber=str(r["ID Number"]),card=str(r.CardNo);
   const key=createHash("sha256").update(JSON.stringify({code,at:at.toISOString(),state,verify,location,idNumber,card})).digest("hex");
   return {code,at,state:statusFrom(state),method:methodFrom(verify),location,idNumber,card,key,raw};
  });
  const result=await withTransaction(async client=>{
   const batch=(await client.query("INSERT INTO attendance_import_batches(source_name,imported_by,total_rows) VALUES($1,$2,$3) RETURNING id",[p.data.sourceName,request.user!.userId,rows.length])).rows[0];let inserted=0,duplicates=0,suspicious=0,unknown=0;
   for(const r of rows){
    if((await client.query("SELECT id FROM attendance_punches WHERE external_key=$1",[r.key])).rowCount){duplicates++;continue;}
    const mapping=await client.query("SELECT employee_id FROM attendance_employee_settings WHERE device_code=$1",[r.code]);const employeeId=mapping.rows[0]?.employee_id??null;
    const near=await client.query("SELECT id FROM attendance_punches WHERE device_code=$1 AND punch_at BETWEEN $2::timestamptz-interval '2 minutes' AND $2::timestamptz+interval '2 minutes' ORDER BY abs(extract(epoch from(punch_at-$2::timestamptz))) LIMIT 1",[r.code,r.at.toISOString()]);
    const saved=await client.query(`INSERT INTO attendance_punches(batch_id,employee_id,device_code,punch_at,status,verify_method,location_id,id_number,card_no,suspicious,duplicate_of,raw_record,external_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) ON CONFLICT(external_key) DO NOTHING RETURNING id`,[batch.id,employeeId,r.code,r.at.toISOString(),r.state,r.method,r.location||null,r.idNumber||null,r.card||null,Boolean(near.rowCount),near.rows[0]?.id??null,JSON.stringify(r.raw),r.key]);
    if(!saved.rowCount){duplicates++;continue;}inserted++;if(near.rowCount)suspicious++;if(!employeeId)unknown++;
   }
   await client.query("UPDATE attendance_import_batches SET inserted_rows=$2,duplicate_rows=$3,suspicious_rows=$4,unknown_rows=$5 WHERE id=$1",[batch.id,inserted,duplicates,suspicious,unknown]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"import",module:"attendance",entityType:"attendance_import_batch",entityId:batch.id,afterData:{sourceName:p.data.sourceName,totalRows:rows.length,inserted,duplicates,suspicious,unknown},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {batchId:batch.id,totalRows:rows.length,inserted,duplicates,suspicious,unknown};
  });return reply.code(201).send({data:result});
 });
 app.post("/api/attendance/punches/:id/review",{preHandler:[authenticateRequest,requirePermission("attendance.review")]},async request=>{
  const id=(request.params as {id:string}).id;const p=z.object({decision:z.enum(["APPROVED","REJECTED"])}).safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!p.success)throw new AppError("VALIDATION_ERROR","قرار المراجعة غير صحيح",422);
  const r=await pool.query("UPDATE attendance_punches SET review_status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1 RETURNING id,review_status,reviewed_at",[id,p.data.decision,request.user!.userId]);if(!r.rowCount)throw new AppError("ATTENDANCE_PUNCH_NOT_FOUND","الحركة غير موجودة",404);return {data:r.rows[0]};
 });
}