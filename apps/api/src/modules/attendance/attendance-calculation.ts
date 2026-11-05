export type AttendancePunchEvent = {
  id: string;
  status: string;
  suspicious: boolean;
  review_status: string;
  punch_at: string;
  localDate: string;
  minute: number;
};

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Assign punches to a scheduled shift using Cairo-local calendar dates.
 * For an overnight shift, only an OUT punch (regular or overtime) from the
 * following day may be attached to the prior shift. A next-day IN must remain
 * on its own day so it cannot be mistaken for the previous shift's checkout.
 */
export function belongsToAttendanceShift(input: {
  punchLocalDate: string;
  punchMinute: number;
  punchStatus: string;
  shiftDate: string;
  overnight: boolean;
  scheduledEndMinute: number | null;
}): boolean {
  if (input.punchLocalDate === input.shiftDate) return true;
  const nextDay = new Date(input.shiftDate + "T00:00:00Z");
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDate = nextDay.toISOString().slice(0, 10);
  const isCheckout = input.punchStatus === "OUT" || input.punchStatus === "OVERTIME_OUT";
  return input.overnight
    && input.punchLocalDate === nextDate
    && isCheckout
    && input.scheduledEndMinute !== null
    && input.punchMinute <= input.scheduledEndMinute + 120;
}

/**
 * Collapse repeated same-type punches within two minutes for attendance
 * calculations, while keeping their raw records untouched in the database.
 * The duplicate remains visible for audit/review and marks the day for review.
 */
function collapseNearDuplicateEvents(events: readonly AttendancePunchEvent[]) {
  const accepted: AttendancePunchEvent[] = [];
  const duplicateIds: string[] = [];
  const lastByStatus = new Map<string, AttendancePunchEvent>();

  for (const event of [...events].sort((a, b) =>
    new Date(a.punch_at).getTime() - new Date(b.punch_at).getTime()
  )) {
    const previous = lastByStatus.get(event.status);
    const delta = previous
      ? new Date(event.punch_at).getTime() - new Date(previous.punch_at).getTime()
      : Number.POSITIVE_INFINITY;

    if (previous && delta >= 0 && delta <= DUPLICATE_WINDOW_MS) {
      duplicateIds.push(event.id);
      continue;
    }

    accepted.push(event);
    lastByStatus.set(event.status, event);
  }

  return { accepted, duplicateIds };
}

function findUnpairedPunchIds(events:readonly AttendancePunchEvent[],inStatus:string,outStatus:string):string[] {
  const relevant=[...events].filter(event=>event.status===inStatus||event.status===outStatus)
    .sort((a,b)=>new Date(a.punch_at).getTime()-new Date(b.punch_at).getTime());
  const unpaired=new Set<string>();let open:AttendancePunchEvent|null=null;
  for(const event of relevant){
    if(event.status===inStatus){
      if(open){unpaired.add(open.id);unpaired.add(event.id);}
      else open=event;
    }else if(!open){unpaired.add(event.id);}
    else open=null;
  }
  if(open)unpaired.add(open.id);
  return [...unpaired];
}

export function selectAttendanceDayEvents(ordered: readonly AttendancePunchEvent[]) {
  // Pending, rejected and suspicious-unreviewed punches remain in the raw
  // attendance history, but cannot contribute to payable worked time.
  const eligible = ordered.filter((event) =>
    event.review_status === "APPROVED"
    || (event.review_status === "AUTO_ACCEPTED" && !event.suspicious)
  );
  const collapsed = collapseNearDuplicateEvents(eligible);
  const usable = collapsed.accepted;
  const normalIns = usable.filter((p) => p.status === "IN");
  const normalOuts = usable.filter((p) => p.status === "OUT");
  const overtimeIns = usable.filter((p) => p.status === "OVERTIME_IN");
  const overtimeOuts = usable.filter((p) => p.status === "OVERTIME_OUT");

  const extraSameType = [
    ...normalIns.slice(1),
    ...normalOuts.slice(0, -1),
    ...overtimeIns.slice(1),
    ...overtimeOuts.slice(0, -1),
  ];
  const unresolvedRepeatedEvents = extraSameType.filter((event) => event.review_status !== "APPROVED");
  // A repeated same-type event can make a missing checkout look like a long
  // continuous shift. Freeze the day's payable minutes until a reviewer approves
  // the extra punches or corrects their event types.
  // Regular multi-shift punches retain the established reviewer workflow. Overtime
  // is a separate optional interval, so an incomplete overtime pair must be explicitly
  // resolved instead of silently disappearing from payroll.
  const unpairedPunchIds=findUnpairedPunchIds(usable,"OVERTIME_IN","OVERTIME_OUT");
  const countedEvents = unresolvedRepeatedEvents.length || unpairedPunchIds.length ? [] : usable;
  const candidateIds = new Set([
    ...collapsed.duplicateIds,
    ...extraSameType.map((event) => event.id),
    ...unpairedPunchIds,
    ...ordered.filter((event) => event.suspicious || event.review_status === "PENDING").map((event) => event.id),
  ]);
  // A second same-type punch is a review candidate, not automatically an error:
  // employees may legitimately have multiple shifts. Once a manager reviews it,
  // the report must stop asking for the same review again.
  const reviewPunches = [...candidateIds]
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((event): event is AttendancePunchEvent =>
      event !== undefined && (
        (event.review_status !== "APPROVED" && event.review_status !== "REJECTED")
        || unpairedPunchIds.includes(event.id)
      )
    )
    .map((event) => ({ id: event.id, status: event.status, punch_at: event.punch_at }));
  const reviewPunchIds = reviewPunches.map((event) => event.id);

  return {
    // Do not mistake an overtime checkout for the employee's regular shift checkout.
    inPunch: normalIns[0] ?? null,
    outPunch: normalOuts.at(-1) ?? null,
    otIn: overtimeIns[0] ?? null,
    otOut: overtimeOuts.at(-1) ?? null,
    countedEvents,
    duplicateIds: collapsed.duplicateIds,
    duplicatePunchCount: collapsed.duplicateIds.length,
    reviewPunchIds,
    reviewPunches,
    needsReview: reviewPunchIds.length > 0 || unpairedPunchIds.length > 0,
    unpairedPunchIds,
    multipleNormalIns: normalIns.length > 1,
    multipleNormalOuts: normalOuts.length > 1,
    multipleOvertimeIns: overtimeIns.length > 1,
    multipleOvertimeOuts: overtimeOuts.length > 1,
  };
}


/**
 * Calculate actual worked time from complete punch pairs, including separately
 * recorded overtime. This supports employees who work multiple shifts in one
 * Cairo workday; the report's first-in/last-out fields remain display summaries.
 */
export function calculateWorkedMinutes(events: readonly { status: string; punch_at: string }[]): number {
  const sorted = [...events].sort((a, b) => new Date(a.punch_at).getTime() - new Date(b.punch_at).getTime());
  const intervals: Array<{start:number;end:number}> = [];
  for (const [inStatus, outStatus] of [["IN", "OUT"], ["OVERTIME_IN", "OVERTIME_OUT"]] as const) {
    let openAt: number | null = null;
    for (const event of sorted) {
      const at = new Date(event.punch_at).getTime();
      if (event.status === inStatus) {
        if (openAt === null) openAt = at;
      } else if (event.status === outStatus && openAt !== null && at >= openAt) {
        intervals.push({start:openAt,end:at});
        openAt = null;
      }
    }
  }

  // Regular and overtime punches are separate event types, but overlapping
  // intervals still represent the same real-world minutes. Merge them before
  // summing so an overtime punch cannot inflate payable worked hours twice.
  intervals.sort((a,b)=>a.start-b.start);
  const merged: Array<{start:number;end:number}> = [];
  for(const interval of intervals){
    const previous=merged.at(-1);
    if(previous&&interval.start<=previous.end)previous.end=Math.max(previous.end,interval.end);
    else merged.push({...interval});
  }
  return merged.reduce((total,interval)=>total+Math.floor((interval.end-interval.start)/60000),0);
}


export type EffectiveAttendanceSchedule = {
  employee_id: string;
  weekday: number | string;
  effective_from: string;
  effective_to: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_day_off: boolean;
};

/** Resolve the single weekly schedule version that applies on a Cairo calendar date. */
export function findEffectiveAttendanceSchedule(
  schedules: readonly EffectiveAttendanceSchedule[],
  employeeId: string,
  weekday: number,
  date: string,
): EffectiveAttendanceSchedule | null {
  return schedules.find((schedule) =>
    schedule.employee_id === employeeId
    && Number(schedule.weekday) === weekday
    && schedule.effective_from <= date
    && (schedule.effective_to === null || schedule.effective_to >= date)
  ) ?? null;
}
