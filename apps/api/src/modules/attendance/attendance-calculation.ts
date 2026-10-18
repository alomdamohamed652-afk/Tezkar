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

export function selectAttendanceDayEvents(ordered: readonly AttendancePunchEvent[]) {
  const collapsed = collapseNearDuplicateEvents(ordered);
  const usable = collapsed.accepted;
  const normalIns = usable.filter((p) => p.status === "IN");
  const normalOuts = usable.filter((p) => p.status === "OUT");
  const overtimeIns = usable.filter((p) => p.status === "OVERTIME_IN");
  const overtimeOuts = usable.filter((p) => p.status === "OVERTIME_OUT");

  return {
    // Do not mistake an overtime checkout for the employee's regular shift checkout.
    inPunch: normalIns[0] ?? null,
    outPunch: normalOuts.at(-1) ?? null,
    otIn: overtimeIns[0] ?? null,
    otOut: overtimeOuts.at(-1) ?? null,
    duplicateIds: collapsed.duplicateIds,
    duplicatePunchCount: collapsed.duplicateIds.length,
    needsReview:
      collapsed.duplicateIds.length > 0 ||
      usable.some((p) => p.suspicious || p.review_status === "PENDING") ||
      normalIns.length > 1 ||
      normalOuts.length > 1 ||
      overtimeIns.length > 1 ||
      overtimeOuts.length > 1,
    multipleNormalIns: normalIns.length > 1,
    multipleNormalOuts: normalOuts.length > 1,
    multipleOvertimeIns: overtimeIns.length > 1,
    multipleOvertimeOuts: overtimeOuts.length > 1,
  };
}
