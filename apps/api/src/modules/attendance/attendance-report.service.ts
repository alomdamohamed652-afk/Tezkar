import { belongsToAttendanceShift, calculateOvertimeMinutes, calculateWorkedMinutes, findEffectiveAttendanceSchedule, selectAttendanceDayEvents } from "./attendance-calculation.js";
import { suggestBoundaryPunchCorrections } from "./attendance-corrections.js";

type AttendanceReportDb = { query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> };

function cairoDateKey(date:Date):string {
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Cairo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
 const get=(type:string)=>parts.find(p=>p.type===type)?.value??"";
 return get("year")+"-"+get("month")+"-"+get("day");
}
function cairoMinute(date:Date):number {
 const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Cairo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
 return Number(parts.find(p=>p.type==="hour")?.value??0)*60+Number(parts.find(p=>p.type==="minute")?.value??0);
}
function addDateKey(key:string,days:number):string {
 const d=new Date(key+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);
}
function minutesOfTime(value:string|null|undefined):number|null {
 if(!value)return null;const parts=value.slice(0,5).split(":");const h=Number(parts[0]??0),m=Number(parts[1]??0);return h*60+m;
}

/**
 * Build attendance from persisted punches, effective schedules, manual day overrides,
 * and approved permissions. Payroll approval calls this inside its transaction and
 * never trusts attendance minutes supplied by a browser.
 */
export async function buildAttendanceReport(db:AttendanceReportDb,from:string,to:string,includeInactive=true) {
 const first=new Date(from+"T00:00:00Z"),last=new Date(to+"T00:00:00Z");
 const daysCount=Math.round((last.getTime()-first.getTime())/86400000)+1;
 if(!Number.isFinite(daysCount)||daysCount<1||daysCount>62)throw new Error("ATTENDANCE_REPORT_RANGE_INVALID");
   const employees=(await db.query(`SELECT e.id,e.code,e.full_name,s.device_code,COALESCE(s.late_grace_minutes,10)::int late_grace_minutes,COALESCE(s.early_grace_minutes,5)::int early_grace_minutes,COALESCE(s.overnight_checkout_grace_minutes,120)::int overnight_checkout_grace_minutes FROM employees e LEFT JOIN attendance_employee_settings s ON s.employee_id=e.id WHERE ($1::boolean=TRUE OR e.is_active=TRUE) ORDER BY e.code`,[includeInactive])).rows;
   const schedules=(await db.query("SELECT employee_id,weekday,starts_at::text,ends_at::text,is_day_off,effective_from::text,effective_to::text FROM attendance_weekly_schedule_versions WHERE effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$1::date) ORDER BY employee_id,weekday,effective_from",[from,to])).rows;
   const exceptions=(await db.query("SELECT id,employee_id,start_date::text,end_date::text,starts_at::text,ends_at::text,is_day_off,note FROM attendance_schedule_exceptions WHERE start_date<=$2::date AND end_date>=$1::date ORDER BY (end_date-start_date) ASC,created_at DESC",[from,to])).rows;
   // The report inputs are Cairo calendar dates. Compare local calendar dates explicitly instead of relying on the database session timezone.
   const raw=(await db.query(`SELECT id,employee_id,device_code,punch_at,corrected_punch_at,status,corrected_status,correction_decision,correction_note,correction_reviewed_by,correction_reviewed_at,verify_method,suspicious,review_status FROM attendance_punches WHERE (
     ((punch_at AT TIME ZONE 'Africa/Cairo')::date >= ($1::date - 1) AND (punch_at AT TIME ZONE 'Africa/Cairo')::date < ($2::date + 2))
     OR (corrected_punch_at IS NOT NULL AND (corrected_punch_at AT TIME ZONE 'Africa/Cairo')::date >= ($1::date - 1) AND (corrected_punch_at AT TIME ZONE 'Africa/Cairo')::date < ($2::date + 2))
   ) AND review_status <> 'REJECTED' ORDER BY COALESCE(corrected_punch_at,punch_at)`,[from,to])).rows;
   const punches=raw.map(p=>{const effectiveAt=p.corrected_punch_at??p.punch_at;return {...p,effectivePunchAt:effectiveAt,localDate:cairoDateKey(new Date(effectiveAt)),minute:cairoMinute(new Date(effectiveAt))};});
   // Index report inputs once. Punches are grouped by employee and Cairo-local date,
   // so each employee/day scans only that day's punches (plus the next day for an
   // overnight checkout), rather than rescanning the employee's full report range.
   const punchesByEmployeeAndDate=new Map<string,Map<string,typeof punches>>();
   for(const punch of punches){
    if(!punch.employee_id)continue;
    const employeeDates=punchesByEmployeeAndDate.get(punch.employee_id)??new Map<string,typeof punches>();
    const dateRows=employeeDates.get(punch.localDate)??[];
    dateRows.push(punch);
    employeeDates.set(punch.localDate,dateRows);
    punchesByEmployeeAndDate.set(punch.employee_id,employeeDates);
   }
   const schedulesByEmployee=new Map<string,typeof schedules>();
   for(const schedule of schedules){
    const rows=schedulesByEmployee.get(schedule.employee_id)??[];
    rows.push(schedule);
    schedulesByEmployee.set(schedule.employee_id,rows);
   }
   const exceptionsByEmployee=new Map<string,typeof exceptions>();
   for(const exception of exceptions){
    const rows=exceptionsByEmployee.get(exception.employee_id)??[];
    rows.push(exception);
    exceptionsByEmployee.set(exception.employee_id,rows);
   }
   const today=cairoDateKey(new Date());const used=new Set<string>();const report:Record<string,unknown>[]=[];
   for(let dayIndex=0;dayIndex<daysCount;dayIndex++){
    const date=addDateKey(from,dayIndex);const weekday=new Date(date+"T00:00:00Z").getUTCDay();
    for(const employee of employees){
     const employeePunchDates=punchesByEmployeeAndDate.get(employee.id);
     const employeeSchedules=schedulesByEmployee.get(employee.id)??[];
     const employeeExceptions=exceptionsByEmployee.get(employee.id)??[];
     const exception=employeeExceptions.find(e=>e.start_date<=date&&e.end_date>=date);
     const schedule=exception?{starts_at:exception.starts_at,ends_at:exception.ends_at,is_day_off:exception.is_day_off}:findEffectiveAttendanceSchedule(employeeSchedules,employee.id,weekday,date);
     const noSchedule=!schedule;const dayOff=Boolean(schedule?.is_day_off);const start=minutesOfTime(schedule?.starts_at);const end=minutesOfTime(schedule?.ends_at);const overnight=!dayOff&&start!==null&&end!==null&&end<=start;
     // Only this day's punches can belong to a normal shift. An overnight shift
     // may additionally consume an OUT punch from the following Cairo-local day.
     const employeePunches=[
       ...(employeePunchDates?.get(date)??[]),
       ...(overnight?employeePunchDates?.get(addDateKey(date,1))??[]:[])
     ];
     const assigned=employeePunches.filter(p=>{
      if(p.employee_id!==employee.id||used.has(p.id))return false;
      if(belongsToAttendanceShift({punchLocalDate:p.localDate,punchMinute:p.minute,punchStatus:p.corrected_status??p.status,shiftDate:date,overnight,scheduledEndMinute:end,checkoutGraceMinutes:employee.overnight_checkout_grace_minutes}))return true;
     });
     assigned.forEach(p=>used.add(p.id));
     const correctionSuggestions=(!dayOff&&start!==null&&end!==null)?suggestBoundaryPunchCorrections({punches:assigned,shiftDate:date,startMinute:start,endMinute:end,overnight}):[];
     const ordered=[...assigned].sort((a,b)=>new Date(a.effectivePunchAt).getTime()-new Date(b.effectivePunchAt).getTime()).map(p=>({...p,punch_at:p.effectivePunchAt,status:p.corrected_status??p.status}));
     const selectedEvents=selectAttendanceDayEvents(ordered);
     const inPunch=selectedEvents.inPunch;const outPunch=selectedEvents.outPunch;
     const inMinute=inPunch?.minute??null;let outMinute=outPunch?.minute??null;if(overnight&&outMinute!==null&&outPunch?.localDate===addDateKey(date,1))outMinute+=1440;
     const lateMinutes=inMinute!==null&&start!==null?Math.max(0,inMinute-start-employee.late_grace_minutes):0;
     const expectedEnd=end===null?null:(overnight?end+1440:end);
     const earlyMinutes=outMinute!==null&&expectedEnd!==null?Math.max(0,expectedEnd-outMinute-employee.early_grace_minutes):0;
     const workedMinutes=calculateWorkedMinutes(selectedEvents.countedEvents.map(p=>({status:p.status,punch_at:new Date(p.punch_at).toISOString()})));
     const earlyArrivalMinutes=inMinute!==null&&start!==null?Math.max(0,start-inMinute):0;const lateDepartureMinutes=outMinute!==null&&expectedEnd!==null?Math.max(0,outMinute-expectedEnd):0;
     const overtimeBoundaryIntervals:Array<{start:string;end:string}>=[];
     if(earlyArrivalMinutes>0&&inPunch){
       const punchAt=new Date(inPunch.punch_at);
       overtimeBoundaryIntervals.push({start:punchAt.toISOString(),end:new Date(punchAt.getTime()+earlyArrivalMinutes*60000).toISOString()});
     }
     if(lateDepartureMinutes>0&&outPunch){
       const punchAt=new Date(outPunch.punch_at);
       overtimeBoundaryIntervals.push({start:new Date(punchAt.getTime()-lateDepartureMinutes*60000).toISOString(),end:punchAt.toISOString()});
     }
     const overtimeMinutes=calculateOvertimeMinutes(selectedEvents.countedEvents.map(p=>({status:p.status,punch_at:new Date(p.punch_at).toISOString()})),overtimeBoundaryIntervals);
     const needsReview=selectedEvents.needsReview||correctionSuggestions.length>0;
     let status:string;if(noSchedule)status=ordered.length?"NO_SCHEDULE_WITH_PUNCH":"NO_SCHEDULE";else if(dayOff)status=ordered.length?"DAY_OFF_WITH_PUNCH":"DAY_OFF";else if(!ordered.length)status=date<today?"ABSENT":"NOT_STARTED";else if(!inPunch||!outPunch)status="MISSING_PUNCH";else status="PRESENT";
     const correctionHistory=assigned.filter(p=>p.correction_decision).map(p=>({id:p.id,punchAt:p.punch_at,originalStatus:p.status,effectiveStatus:p.corrected_status??p.status,decision:p.correction_decision}));
     report.push({date,employeeId:employee.id,employeeCode:employee.code,employeeName:employee.full_name,deviceCode:employee.device_code,scheduledStart:schedule?.starts_at??null,scheduledEnd:schedule?.ends_at??null,scheduledStartMinute:start,scheduledEndMinute:expectedEnd,firstInMinute:inMinute,lastOutMinute:outMinute,lateGraceMinutes:employee.late_grace_minutes,earlyGraceMinutes:employee.early_grace_minutes,isDayOff:dayOff,firstIn:inPunch?.punch_at??null,lastOut:outPunch?.punch_at??null,workedMinutes,workedHours:Math.round((workedMinutes/60)*100)/100,correctionSuggestions,correctionHistory,lateMinutes,earlyMinutes,earlyArrivalMinutes,lateDepartureMinutes,overtimeMinutes,overtimePending:overtimeMinutes>0,status,needsReview,reviewPunchIds:selectedEvents.reviewPunchIds,reviewPunches:selectedEvents.reviewPunches,suspiciousCount:ordered.filter(p=>p.suspicious).length,duplicatePunchCount:selectedEvents.duplicatePunchCount,punchCount:ordered.length,punchTimeline:assigned.map(p=>({id:p.id,punchAt:p.effectivePunchAt,originalPunchAt:p.punch_at,originalStatus:p.status,effectiveStatus:p.corrected_status??p.status,verifyMethod:p.verify_method,suspicious:p.suspicious,reviewStatus:p.review_status,correctionDecision:p.correction_decision??null,correctionNote:p.correction_note??null,isNearDuplicate:selectedEvents.duplicateIds.includes(p.id)})).sort((a,b)=>new Date(a.punchAt).getTime()-new Date(b.punchAt).getTime())});
    }
   }
   const overrides=(await db.query(`SELECT employee_id,attendance_date::text,status,first_in::text,last_out::text,worked_minutes,late_minutes,early_minutes,note,updated_at,updated_by FROM attendance_day_overrides WHERE attendance_date BETWEEN $1::date AND $2::date`,[from,to])).rows;
   const approvedPermissions=(await db.query(`SELECT employee_id,permission_date::text,permission_type,duration_minutes,starts_at::text,ends_at::text
     FROM attendance_permission_requests WHERE status='APPROVED' AND permission_date BETWEEN $1::date AND $2::date`,[from,to])).rows;
   const permissionMap=new Map<string,{paid:number;unpaid:number;items:Array<{type:string;minutes:number;startsAt:string;endsAt:string}>}>();
   for(const permission of approvedPermissions){
     const key=permission.employee_id+"|"+String(permission.permission_date).slice(0,10);
     const current=permissionMap.get(key)??{paid:0,unpaid:0,items:[]};
     const minutes=Number(permission.duration_minutes);
     if(permission.permission_type==="PAID")current.paid+=minutes;else current.unpaid+=minutes;
     current.items.push({type:permission.permission_type,minutes,startsAt:String(permission.starts_at).slice(0,5),endsAt:String(permission.ends_at).slice(0,5)});
     permissionMap.set(key,current);
   }
   const overrideMap=new Map(overrides.map(o=>[o.employee_id+"|"+String(o.attendance_date).slice(0,10),o]));
   for(let index=0;index<report.length;index++){
     const row=report[index] as Record<string,unknown>;
     const override=overrideMap.get(String(row.employeeId)+"|"+String(row.date));
     if(!override)continue;
     const firstIn=override.first_in?String(row.date)+"T"+String(override.first_in).slice(0,8):null;
     const lastOut=override.last_out?String(row.date)+"T"+String(override.last_out).slice(0,8):null;
     const overrideStartMinute=minutesOfTime(override.first_in);let overrideEndMinute=minutesOfTime(override.last_out);if(overrideEndMinute!==null&&typeof row.scheduledEndMinute==="number"&&row.scheduledEndMinute>=1440&&overrideEndMinute<Number(row.scheduledStartMinute??0))overrideEndMinute+=1440;report[index]={...row,firstIn,lastOut,firstInMinute:overrideStartMinute,lastOutMinute:overrideEndMinute,workedMinutes:Number(override.worked_minutes),workedHours:Math.round(Number(override.worked_minutes)/60*100)/100,lateMinutes:Number(override.late_minutes),earlyMinutes:Number(override.early_minutes),status:String(override.status),needsReview:false,manualOverride:true,manualNote:override.note,manualUpdatedAt:override.updated_at};
   }
   for(let index=0;index<report.length;index++){
     const row=report[index] as Record<string,unknown>;
     const permissions=permissionMap.get(String(row.employeeId)+"|"+String(row.date))??{paid:0,unpaid:0,items:[]};
     const worked=Number(row.workedMinutes??0);
     const overlap=(a:number,b:number,c:number,d:number)=>Math.max(0,Math.min(b,d)-Math.max(a,c));
     let latePermissionOverlapMinutes=0,earlyPermissionOverlapMinutes=0,paidMinutes=0,unpaidMinutes=0;
     const scheduledStartMinute=typeof row.scheduledStartMinute==="number"?row.scheduledStartMinute:null;
     const scheduledEndMinute=typeof row.scheduledEndMinute==="number"?row.scheduledEndMinute:null;
     const firstInMinute=typeof row.firstInMinute==="number"?row.firstInMinute:null;
     const lastOutMinute=typeof row.lastOutMinute==="number"?row.lastOutMinute:null;
     const lateStart=scheduledStartMinute===null?null:scheduledStartMinute+Number(row.lateGraceMinutes??0);
     const earlyEnd=scheduledEndMinute===null?null:scheduledEndMinute-Number(row.earlyGraceMinutes??0);
     const effectivePermissionItems:Array<{type:string;minutes:number;startsAt:string;endsAt:string}>=[];
     for(const permission of permissions.items){
       const permissionStart=minutesOfTime(permission.startsAt),permissionEnd=minutesOfTime(permission.endsAt);
       if(permissionStart===null||permissionEnd===null||scheduledStartMinute===null||scheduledEndMinute===null||Boolean(row.isDayOff))continue;
       const coveredMinutes=overlap(scheduledStartMinute,scheduledEndMinute,permissionStart,permissionEnd);
       if(coveredMinutes<=0)continue;
       if(permission.type==="PAID")paidMinutes+=coveredMinutes;else unpaidMinutes+=coveredMinutes;
       effectivePermissionItems.push({...permission,minutes:coveredMinutes});
       if(lateStart!==null&&firstInMinute!==null)latePermissionOverlapMinutes+=overlap(lateStart,firstInMinute,permissionStart,permissionEnd);
       if(lastOutMinute!==null&&earlyEnd!==null)earlyPermissionOverlapMinutes+=overlap(lastOutMinute,earlyEnd,permissionStart,permissionEnd);
     }
     const adjustedLate=Math.max(0,Number(row.lateMinutes??0)-latePermissionOverlapMinutes);
     const adjustedEarly=Math.max(0,Number(row.earlyMinutes??0)-earlyPermissionOverlapMinutes);
     report[index]={...row,lateMinutes:adjustedLate,earlyMinutes:adjustedEarly,latePermissionOverlapMinutes,earlyPermissionOverlapMinutes,permissionMinutes:paidMinutes+unpaidMinutes,paidPermissionMinutes:paidMinutes,unpaidPermissionMinutes:unpaidMinutes,permissionDetails:effectivePermissionItems,payableWorkedMinutes:worked+paidMinutes};
   }
   const totals={rows:report.length,totalPaidPermissionMinutes:report.reduce((n,r)=>n+Number(r.paidPermissionMinutes??0),0),totalUnpaidPermissionMinutes:report.reduce((n,r)=>n+Number(r.unpaidPermissionMinutes??0),0),totalWorkedMinutes:report.reduce((n,r)=>n+Number(r.workedMinutes??0),0),totalWorkedHours:Math.round(report.reduce((n,r)=>n+Number(r.workedMinutes??0),0)/60*100)/100,correctionsPending:report.reduce((n,r)=>n+(Array.isArray(r.correctionSuggestions)?r.correctionSuggestions.length:0),0),absent:report.filter(r=>r.status==="ABSENT").length,late:report.filter(r=>Number(r.lateMinutes)>0).length,early:report.filter(r=>Number(r.earlyMinutes)>0).length,missingPunch:report.filter(r=>r.status==="MISSING_PUNCH").length,needsReview:report.filter(r=>r.needsReview===true).length,overtimePending:report.filter(r=>r.overtimePending===true).length};
   return {data:report,summary:totals};
}
