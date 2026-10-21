import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { belongsToAttendanceShift, selectAttendanceDayEvents } from "./attendance-calculation.js";
import { suggestBoundaryPunchCorrections } from "./attendance-corrections.js";

const rowSchema=z.object({No:z.union([z.string(),z.number()]).transform(String),"Date/Time":z.union([z.string(),z.number()]).transform(String),Status:z.unknown().optional(),Department:z.unknown().optional(),Name:z.unknown().optional(),"Location ID":z.unknown().optional(),"ID Number":z.unknown().optional(),VerifyCode:z.unknown().optional(),CardNo:z.unknown().optional()});
const importSchema=z.object({sourceName:z.string().trim().min(1).max(255).default("attendance-import"),rows:z.array(z.record(z.string(),z.unknown())).min(1).max(5000)});
const settingSchema=z.object({deviceCode:z.string().trim().max(80).nullable(),lateGraceMinutes:z.number().int().min(0).max(240).default(10),earlyGraceMinutes:z.number().int().min(0).max(240).default(5)});
const timePattern=/^([01]\d|2[0-3]):[0-5]\d$/;
const scheduleSchema=z.object({effectiveFrom:z.string().date(),days:z.array(z.object({weekday:z.number().int().min(0).max(6),startsAt:z.string().regex(timePattern).nullable(),endsAt:z.string().regex(timePattern).nullable(),isDayOff:z.boolean()})).max(7)});
const str=(v:unknown)=>v==null?"":String(v).trim();
function methodFrom(raw:string):"FINGERPRINT"|"PASSWORD"|"CARD"|"UNKNOWN"{const s=raw.toLowerCase();if(s.includes("finger")||s.includes("بصمة"))return "FINGERPRINT";if(s.includes("password")||s.includes("كلمة"))return "PASSWORD";if(s.includes("card")||s.includes("كارت")||s.includes("badge"))return "CARD";return "UNKNOWN";}
function cairoWallTimeToUtc(wall:Date):Date{const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Cairo",timeZoneName:"shortOffset"}).formatToParts(wall);const zone=parts.find(p=>p.type==="timeZoneName")?.value??"GMT+2";const m=zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);const sign=m?.[1]==="-"?-1:1;const minutes=sign*((Number(m?.[2]??2)*60)+Number(m?.[3]??0));return new Date(wall.getTime()-minutes*60000);}
function parseTimestamp(raw:string):Date|null{if(!raw)return null;if(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)){const absolute=new Date(raw);return Number.isNaN(absolute.getTime())?null:absolute;}let wall:Date;if(/^\d+(?:\.\d+)?$/.test(raw)){const n=Number(raw);if(n<=20000||n>=80000)return null;wall=new Date(Date.UTC(1899,11,30)+n*86400000);}else if(/^\d{4}-\d{2}-\d{2}(?:[ T]+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(raw)){const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);if(!m)return null;const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);wall=new Date(Date.UTC(year,month-1,day,Number(m[4]??0),Number(m[5]??0),Number(m[6]??0)));if(wall.getUTCFullYear()!==year||wall.getUTCMonth()!==month-1||wall.getUTCDate()!==day)return null;}else{const m=raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(AM|PM))?$/i);if(m){const a=Number(m[1]),b=Number(m[2]);let month:number,day:number;if(a>12){day=a;month=b;}else if(b>12){month=a;day=b;}else{day=a;month=b;}let hour=Number(m[4]??0);const ampm=(m[7]??"").toUpperCase();if(ampm==="PM"&&hour<12)hour+=12;if(ampm==="AM"&&hour===12)hour=0;wall=new Date(Date.UTC(Number(m[3]),month-1,day,hour,Number(m[5]??0),Number(m[6]??0)));if(wall.getUTCFullYear()!==Number(m[3])||wall.getUTCMonth()!==month-1||wall.getUTCDate()!==day)return null;}else{const parsed=new Date(raw);if(Number.isNaN(parsed.getTime()))return null;wall=new Date(Date.UTC(parsed.getFullYear(),parsed.getMonth(),parsed.getDate(),parsed.getHours(),parsed.getMinutes(),parsed.getSeconds(),parsed.getMilliseconds()));}}return cairoWallTimeToUtc(wall);}
function statusFrom(raw:string):string{const s=raw.toLowerCase().replace(/[_-]+/g," ").replace(/\s+/g," ").trim();if(s==="c/in"||s==="in"||s==="check in"||s.includes("check in "))return "IN";if(s==="c/out"||s==="out"||s==="check out"||s.includes("check out "))return "OUT";if(s.includes("overtime in"))return "OVERTIME_IN";if(s.includes("overtime out"))return "OVERTIME_OUT";return "UNKNOWN";}

function cairoDateKey(date:Date):string{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Cairo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);const get=(type:string)=>parts.find(p=>p.type===type)?.value??"";return get("year")+"-"+get("month")+"-"+get("day");}
function cairoMinute(date:Date):number{const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Cairo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);return Number(parts.find(p=>p.type==="hour")?.value??0)*60+Number(parts.find(p=>p.type==="minute")?.value??0);}
function addDateKey(key:string,days:number):string{const d=new Date(key+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function minutesOfTime(value:string|null|undefined):number|null{if(!value)return null;const parts=value.slice(0,5).split(":");const h=Number(parts[0]??0),m=Number(parts[1]??0);return h*60+m;}

export async function attendanceRoutes(app:FastifyInstance){
 app.get("/api/attendance",{preHandler:[authenticateRequest,requirePermission("attendance.view")]},async request=>{
  const q=request.query as {from?:string;to?:string;review?:string};const args:unknown[]=[];const where:string[]=[];
  if(q.from){args.push(q.from);where.push(`(p.punch_at AT TIME ZONE 'Africa/Cairo')::date >= ${args.length}::date`);}
  if(q.to){args.push(q.to);where.push(`(p.punch_at AT TIME ZONE 'Africa/Cairo')::date <= ${args.length}::date`);}
  if(q.review&&["PENDING","AUTO_ACCEPTED","APPROVED","REJECTED"].includes(q.review)){args.push(q.review);where.push(`p.review_status=$${args.length}`);}
  const rows=await pool.query(`SELECT p.id,p.device_code,p.punch_at,p.status,p.verify_method,p.suspicious,p.duplicate_of,p.review_status,p.corrected_status,p.correction_decision,p.correction_reviewed_at,p.location_id,p.card_no,p.id_number,e.id employee_id,e.full_name employee_name,e.code employee_code,b.source_name FROM attendance_punches p LEFT JOIN employees e ON e.id=p.employee_id LEFT JOIN attendance_import_batches b ON b.id=p.batch_id ${where.length?"WHERE "+where.join(" AND"):""} ORDER BY p.punch_at DESC LIMIT 1000`,args);
  const summary=await pool.query("SELECT count(*)::int total,count(*) FILTER(WHERE review_status='PENDING')::int pending,count(*) FILTER(WHERE suspicious)::int suspicious,count(*) FILTER(WHERE employee_id IS NULL)::int unknown FROM attendance_punches");
  const batches=await pool.query("SELECT id,source_name,total_rows,inserted_rows,duplicate_rows,suspicious_rows,unknown_rows,created_at FROM attendance_import_batches ORDER BY created_at DESC LIMIT 20");
  return {data:rows.rows,summary:summary.rows[0],batches:batches.rows};
 });
 app.get("/api/attendance/settings",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async()=>{
  const employees=await pool.query(`SELECT e.id,e.code,e.full_name,e.is_active,s.device_code,COALESCE(s.late_grace_minutes,10)::int late_grace_minutes,COALESCE(s.early_grace_minutes,5)::int early_grace_minutes FROM employees e LEFT JOIN attendance_employee_settings s ON s.employee_id=e.id ORDER BY e.code`);
  const schedules=await pool.query("SELECT employee_id,weekday,starts_at::text,ends_at::text,is_day_off,effective_from::text,effective_to::text FROM attendance_weekly_schedule_versions ORDER BY employee_id,weekday,effective_from");
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
   if(d.deviceCode)await client.query("UPDATE attendance_punches SET employee_id=$1 WHERE employee_id IS NULL AND device_code=$2",[id,d.deviceCode]);await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update",module:"attendance",entityType:"attendance_settings",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});return r.rows[0];
  });return {data:saved};
 });
 app.put("/api/attendance/schedule/:employeeId",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const id=(request.params as {employeeId:string}).employeeId;const p=scheduleSchema.safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!p.success||(p.success&&(p.data.days.length!==7||new Set(p.data.days.map(d=>d.weekday)).size!==7||p.data.days.some(d=>!d.isDayOff&&(!d.startsAt||!d.endsAt)))))throw new AppError("VALIDATION_ERROR","لازم تحدد تاريخ سريان، وتحدد الأيام السبعة كلها، وبداية ونهاية كل وردية أو تعلّم اليوم إجازة",422);
  const result=await withTransaction(async client=>{
   if(!(await client.query("SELECT id FROM employees WHERE id=$1",[id])).rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
   const effectiveFrom=p.data.effectiveFrom;
   const prior=(await client.query("SELECT max(effective_from)::text effective_from FROM attendance_weekly_schedule_versions WHERE employee_id=$1 AND effective_from<$2::date",[id,effectiveFrom])).rows[0]?.effective_from as string|null;
   const next=(await client.query("SELECT min(effective_from)::text effective_from FROM attendance_weekly_schedule_versions WHERE employee_id=$1 AND effective_from>$2::date",[id,effectiveFrom])).rows[0]?.effective_from as string|null;
   if(prior)await client.query("UPDATE attendance_weekly_schedule_versions SET effective_to=($2::date-1) WHERE employee_id=$1 AND effective_from=$3::date",[id,effectiveFrom,prior]);
   await client.query("DELETE FROM attendance_weekly_schedule_versions WHERE employee_id=$1 AND effective_from=$2::date",[id,effectiveFrom]);
   const effectiveTo=next?addDateKey(next,-1):null;
   for(const d of p.data.days)await client.query("INSERT INTO attendance_weekly_schedule_versions(employee_id,weekday,starts_at,ends_at,is_day_off,effective_from,effective_to,created_by) VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8)",[id,d.weekday,d.isDayOff?null:d.startsAt,d.isDayOff?null:d.endsAt,d.isDayOff,effectiveFrom,effectiveTo,request.user!.userId]);
   const saved=(await client.query("SELECT weekday,starts_at::text,ends_at::text,is_day_off,effective_from::text,effective_to::text FROM attendance_weekly_schedule_versions WHERE employee_id=$1 AND effective_from=$2::date ORDER BY weekday",[id,effectiveFrom])).rows;
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update",module:"attendance",entityType:"attendance_weekly_schedule_version",entityId:id,afterData:{effectiveFrom,effectiveTo,days:saved},metadata:{effectiveFrom,effectiveTo},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return saved;
  });return {data:result};
 });
 app.post("/api/attendance/exceptions",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const p=z.object({employeeId:z.string().uuid(),startDate:z.string().date(),endDate:z.string().date(),startsAt:z.string().regex(timePattern).nullable().optional(),endsAt:z.string().regex(timePattern).nullable().optional(),isDayOff:z.boolean().default(false),note:z.string().trim().max(500).nullable().optional()}).safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","استثناء الجدول غير صحيح",422);
  const d=p.data;if(d.endDate<d.startDate||(!d.isDayOff&&(!d.startsAt||!d.endsAt)))throw new AppError("VALIDATION_ERROR","استثناء الجدول غير صحيح",422);
  const saved=await withTransaction(async client=>{
   if(!(await client.query("SELECT id FROM employees WHERE id=$1",[d.employeeId])).rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
   const r=await client.query("INSERT INTO attendance_schedule_exceptions(employee_id,start_date,end_date,starts_at,ends_at,is_day_off,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[d.employeeId,d.startDate,d.endDate,d.isDayOff?null:d.startsAt,d.isDayOff?null:d.endsAt,d.isDayOff,d.note??null,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"attendance",entityType:"attendance_schedule_exception",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });return {data:saved};
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
    const near=await client.query("SELECT id FROM attendance_punches WHERE device_code=$1 AND status=$3 AND punch_at BETWEEN $2::timestamptz-interval '2 minutes' AND $2::timestamptz+interval '2 minutes' ORDER BY abs(extract(epoch from(punch_at-$2::timestamptz))) LIMIT 1",[r.code,r.at.toISOString(),r.state]);
    // A second same-type punch on the same Cairo calendar date is ambiguous even when hours apart
    // (for example IN at 15:00 and IN at 23:00 on a 15:00–23:00 shift). Preserve both and require review.
    const repeatedSameDay = ["IN","OUT","OVERTIME_IN","OVERTIME_OUT"].includes(r.state)
      ? await client.query("SELECT id FROM attendance_punches WHERE device_code=$1 AND status=$3 AND (punch_at AT TIME ZONE 'Africa/Cairo')::date = ($2::timestamptz AT TIME ZONE 'Africa/Cairo')::date",[r.code,r.at.toISOString(),r.state])
      : { rows: [], rowCount: 0 };
    if(repeatedSameDay.rowCount){
      await client.query("UPDATE attendance_punches SET suspicious=TRUE,review_status='PENDING' WHERE id = ANY($1::uuid[]) AND review_status <> 'REJECTED'",[repeatedSameDay.rows.map((row:{id:string})=>row.id)]);
    }
    const needsReview = Boolean(near.rowCount || repeatedSameDay.rowCount || employeeId === null || r.state === "UNKNOWN");
    const saved=await client.query(`INSERT INTO attendance_punches(batch_id,employee_id,device_code,punch_at,status,verify_method,location_id,id_number,card_no,suspicious,review_status,duplicate_of,raw_record,external_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10 THEN 'PENDING' ELSE 'AUTO_ACCEPTED' END,$11,$12::jsonb,$13) ON CONFLICT(external_key) DO NOTHING RETURNING id`,[batch.id,employeeId,r.code,r.at.toISOString(),r.state,r.method,r.location||null,r.idNumber||null,r.card||null,needsReview,near.rows[0]?.id??null,JSON.stringify(r.raw),r.key]);
    if(!saved.rowCount){duplicates++;continue;}inserted++;if(needsReview)suspicious++;if(!employeeId)unknown++;
   }
   await client.query("UPDATE attendance_import_batches SET inserted_rows=$2,duplicate_rows=$3,suspicious_rows=$4,unknown_rows=$5 WHERE id=$1",[batch.id,inserted,duplicates,suspicious,unknown]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"import",module:"attendance",entityType:"attendance_import_batch",entityId:batch.id,afterData:{sourceName:p.data.sourceName,totalRows:rows.length,inserted,duplicates,suspicious,unknown},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {batchId:batch.id,totalRows:rows.length,inserted,duplicates,suspicious,unknown};
  });return reply.code(201).send({data:result});
 });
 app.delete("/api/attendance/imported-data",{preHandler:[authenticateRequest,requirePermission("attendance.manage")]},async request=>{
  const result=await withTransaction(async client=>{
   const counts=(await client.query("SELECT (SELECT count(*)::int FROM attendance_punches) punches,(SELECT count(*)::int FROM attendance_import_batches) batches")).rows[0] as {punches:number;batches:number};
   // Keep schedule/device mappings and the audit trail; remove only imported punches and their batch history.
   await client.query("DELETE FROM attendance_punches");
   await client.query("DELETE FROM attendance_import_batches");
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"clear_imported_data",module:"attendance",entityType:"attendance_import_batch",metadata:{deletedPunches:counts.punches,deletedBatches:counts.batches,scope:"attendance imports only"},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return counts;
  });
  return {data:{deletedPunches:result.punches,deletedBatches:result.batches}};
 });
 app.post("/api/attendance/punches/:id/review",{preHandler:[authenticateRequest,requirePermission("attendance.review")]},async request=>{
  const id=(request.params as {id:string}).id;const p=z.object({decision:z.enum(["APPROVED","REJECTED"])}).safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!p.success)throw new AppError("VALIDATION_ERROR","قرار المراجعة غير صحيح",422);
  const reviewed=await withTransaction(async client=>{const before=await client.query("SELECT id,employee_id,device_code,punch_at,status,suspicious,review_status FROM attendance_punches WHERE id=$1 FOR UPDATE",[id]);if(!before.rowCount)throw new AppError("ATTENDANCE_PUNCH_NOT_FOUND","الحركة غير موجودة",404);const r=await client.query("UPDATE attendance_punches SET review_status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1 RETURNING id,review_status,reviewed_at",[id,p.data.decision,request.user!.userId]);await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"review",module:"attendance",entityType:"attendance_punch",entityId:id,beforeData:before.rows[0],afterData:r.rows[0],metadata:{decision:p.data.decision},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});return r.rows[0];});return {data:reviewed};
 }); 

 app.post("/api/attendance/punches/:id/correction",{preHandler:[authenticateRequest,requirePermission("attendance.review")]},async request=>{
  const id=(request.params as {id:string}).id;
  const parsed=z.object({decision:z.enum(["APPLY_SUGGESTION","KEEP_ORIGINAL"]),suggestedStatus:z.enum(["IN","OUT"])}).safeParse(request.body);
  if(!z.string().uuid().safeParse(id).success||!parsed.success)throw new AppError("VALIDATION_ERROR","قرار تصحيح البصمة غير صحيح",422);
  const result=await withTransaction(async client=>{
   const before=await client.query("SELECT id,employee_id,device_code,punch_at,status,corrected_status,correction_decision FROM attendance_punches WHERE id=$1 FOR UPDATE",[id]);
   if(!before.rowCount)throw new AppError("ATTENDANCE_PUNCH_NOT_FOUND","حركة البصمة غير موجودة",404);
   const old=before.rows[0];
   if(old.correction_decision)throw new AppError("ATTENDANCE_CORRECTION_ALREADY_REVIEWED","تم حسم تصحيح هذه البصمة بالفعل. راجع سجل التدقيق قبل أي تعديل جديد.",409);
   if(!["IN","OUT"].includes(old.status)||parsed.data.suggestedStatus===old.status)throw new AppError("INVALID_ATTENDANCE_CORRECTION","التصحيح المقترح يجب أن يعكس دخولًا إلى خروج أو العكس.",422);
   const corrected=parsed.data.decision==="APPLY_SUGGESTION"?parsed.data.suggestedStatus:null;
   const updated=await client.query(
    "UPDATE attendance_punches SET corrected_status=$2,correction_decision=$3,correction_reviewed_by=$4,correction_reviewed_at=now() WHERE id=$1 RETURNING id,status,corrected_status,correction_decision,correction_reviewed_by,correction_reviewed_at",
    [id,corrected,parsed.data.decision==="APPLY_SUGGESTION"?"APPLIED":"KEPT_ORIGINAL",request.user!.userId]
   );
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:parsed.data.decision==="APPLY_SUGGESTION"?"apply_attendance_correction":"keep_original_attendance_punch",module:"attendance",entityType:"attendance_punch",entityId:id,beforeData:old,afterData:updated.rows[0],metadata:{decision:parsed.data.decision,suggestedStatus:parsed.data.suggestedStatus,originalStatus:old.status},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:result};
 });

 app.get("/api/attendance/report",{preHandler:[authenticateRequest,requirePermission("attendance.view")]},async request=>{
  const q=request.query as {from?:string;to?:string};const dates=z.object({from:z.string().date(),to:z.string().date()}).safeParse(q);
  if(!dates.success||dates.data.to<dates.data.from)throw new AppError("VALIDATION_ERROR","حدد فترة صحيحة للتقرير",422);
  const first=new Date(dates.data.from+"T00:00:00Z"),last=new Date(dates.data.to+"T00:00:00Z");const daysCount=Math.round((last.getTime()-first.getTime())/86400000)+1;
  if(daysCount>62)throw new AppError("DATE_RANGE_TOO_LARGE","الفترة القصوى للتقرير 62 يومًا",422);
  const employees=(await pool.query(`SELECT e.id,e.code,e.full_name,s.device_code,COALESCE(s.late_grace_minutes,10)::int late_grace_minutes,COALESCE(s.early_grace_minutes,5)::int early_grace_minutes FROM employees e LEFT JOIN attendance_employee_settings s ON s.employee_id=e.id WHERE e.is_active=TRUE ORDER BY e.code`)).rows;
  const schedules=(await pool.query("SELECT employee_id,weekday,starts_at::text,ends_at::text,is_day_off,effective_from::text,effective_to::text FROM attendance_weekly_schedule_versions WHERE effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$1::date) ORDER BY employee_id,weekday,effective_from",[dates.data.from,dates.data.to])).rows;
  const exceptions=(await pool.query("SELECT id,employee_id,start_date::text,end_date::text,starts_at::text,ends_at::text,is_day_off,note FROM attendance_schedule_exceptions WHERE start_date<=$2::date AND end_date>=$1::date ORDER BY (end_date-start_date) ASC,created_at DESC",[dates.data.from,dates.data.to])).rows;
  // The report inputs are Cairo calendar dates. Compare local calendar dates explicitly instead of relying on the database session timezone.
  const raw=(await pool.query("SELECT id,employee_id,device_code,punch_at,status,corrected_status,correction_decision,correction_reviewed_by,correction_reviewed_at,verify_method,suspicious,review_status FROM attendance_punches WHERE (punch_at AT TIME ZONE 'Africa/Cairo')::date >= ($1::date - 1) AND (punch_at AT TIME ZONE 'Africa/Cairo')::date < ($2::date + 2) AND review_status <> 'REJECTED' ORDER BY punch_at",[dates.data.from,dates.data.to])).rows;
  const punches=raw.map(p=>({...p,localDate:cairoDateKey(new Date(p.punch_at)),minute:cairoMinute(new Date(p.punch_at))}));
  const today=cairoDateKey(new Date());const used=new Set<string>();const report:Record<string,unknown>[]=[];
  for(let dayIndex=0;dayIndex<daysCount;dayIndex++){
   const date=addDateKey(dates.data.from,dayIndex);const weekday=new Date(date+"T00:00:00Z").getUTCDay();
   for(const employee of employees){
    const exception=exceptions.find(e=>e.employee_id===employee.id&&e.start_date<=date&&e.end_date>=date);
    const schedule=exception?{starts_at:exception.starts_at,ends_at:exception.ends_at,is_day_off:exception.is_day_off}:schedules.find(s=>s.employee_id===employee.id&&s.weekday===weekday&&s.effective_from<=date&&(!s.effective_to||s.effective_to>=date));
    const noSchedule=!schedule;const dayOff=Boolean(schedule?.is_day_off);const start=minutesOfTime(schedule?.starts_at);const end=minutesOfTime(schedule?.ends_at);const overnight=!dayOff&&start!==null&&end!==null&&end<=start;
    const assigned=punches.filter(p=>{
     if(p.employee_id!==employee.id||used.has(p.id))return false;
     if(belongsToAttendanceShift({punchLocalDate:p.localDate,punchMinute:p.minute,punchStatus:p.corrected_status??p.status,shiftDate:date,overnight,scheduledEndMinute:end}))return true;
     // A next-day IN near an overnight shift's end is considered only when the same shift
     // also has a punch near its start; this avoids stealing unrelated next-day check-ins.
     return overnight&&p.localDate===addDateKey(date,1)&&(p.corrected_status??p.status)==="IN"&&end!==null&&start!==null&&Math.abs(p.minute-end)<=240&&punches.some(other=>other.employee_id===employee.id&&other.localDate===date&&Math.abs(other.minute-start)<=240&&other.id!==p.id);
    });
    assigned.forEach(p=>used.add(p.id));
    const correctionSuggestions=(!dayOff&&start!==null&&end!==null)?suggestBoundaryPunchCorrections({punches:assigned,shiftDate:date,startMinute:start,endMinute:end,overnight}):[];
    const ordered=[...assigned].sort((a,b)=>new Date(a.punch_at).getTime()-new Date(b.punch_at).getTime()).map(p=>({...p,status:p.corrected_status??p.status}));
    const selectedEvents=selectAttendanceDayEvents(ordered);
    const inPunch=selectedEvents.inPunch;const outPunch=selectedEvents.outPunch;
    const otIn=selectedEvents.otIn;const otOut=selectedEvents.otOut;
    let inMinute=inPunch?.minute??null;let outMinute=outPunch?.minute??null;if(overnight&&outMinute!==null&&outPunch?.localDate===addDateKey(date,1))outMinute+=1440;
    const lateMinutes=inMinute!==null&&start!==null?Math.max(0,inMinute-start-employee.late_grace_minutes):0;
    const expectedEnd=end===null?null:(overnight?end+1440:end);
    const earlyMinutes=outMinute!==null&&expectedEnd!==null?Math.max(0,expectedEnd-outMinute-employee.early_grace_minutes):0;
    const workedMinutes=inMinute!==null&&outMinute!==null?Math.max(0,outMinute-inMinute):0;
    let overtimeMinutes=0;if(otIn&&otOut){let om=otOut.minute;if(overnight&&otOut.localDate===addDateKey(date,1))om+=1440;let im=otIn.minute;if(overnight&&otIn.localDate===addDateKey(date,1))im+=1440;overtimeMinutes=Math.max(0,om-im);}
    const needsReview=selectedEvents.needsReview||correctionSuggestions.length>0;
    let status:string;if(noSchedule)status=ordered.length?"NO_SCHEDULE_WITH_PUNCH":"NO_SCHEDULE";else if(dayOff)status=ordered.length?"DAY_OFF_WITH_PUNCH":"DAY_OFF";else if(!ordered.length)status=date<today?"ABSENT":"NOT_STARTED";else if(!inPunch||!outPunch)status="MISSING_PUNCH";else status="PRESENT";
    const correctionHistory=assigned.filter(p=>p.correction_decision).map(p=>({id:p.id,punchAt:p.punch_at,originalStatus:p.status,effectiveStatus:p.corrected_status??p.status,decision:p.correction_decision}));
    report.push({date,employeeId:employee.id,employeeCode:employee.code,employeeName:employee.full_name,deviceCode:employee.device_code,scheduledStart:schedule?.starts_at??null,scheduledEnd:schedule?.ends_at??null,isDayOff:dayOff,firstIn:inPunch?.punch_at??null,lastOut:outPunch?.punch_at??null,workedMinutes,workedHours:Math.round((workedMinutes/60)*100)/100,correctionSuggestions,correctionHistory,lateMinutes,earlyMinutes,overtimeMinutes,overtimePending:overtimeMinutes>0,status,needsReview,reviewPunchIds:selectedEvents.reviewPunchIds,reviewPunches:selectedEvents.reviewPunches,suspiciousCount:ordered.filter(p=>p.suspicious).length,duplicatePunchCount:selectedEvents.duplicatePunchCount,punchCount:ordered.length});
   }
  }
  const totals={rows:report.length,totalWorkedMinutes:report.reduce((n,r)=>n+Number(r.workedMinutes??0),0),totalWorkedHours:Math.round(report.reduce((n,r)=>n+Number(r.workedMinutes??0),0)/60*100)/100,correctionsPending:report.reduce((n,r)=>n+(Array.isArray(r.correctionSuggestions)?r.correctionSuggestions.length:0),0),absent:report.filter(r=>r.status==="ABSENT").length,late:report.filter(r=>Number(r.lateMinutes)>0).length,early:report.filter(r=>Number(r.earlyMinutes)>0).length,missingPunch:report.filter(r=>r.status==="MISSING_PUNCH").length,needsReview:report.filter(r=>r.needsReview===true).length,overtimePending:report.filter(r=>r.overtimePending===true).length};
  return {data:report,summary:totals};
 });

}