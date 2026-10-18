export type AttendancePunchEvent = {
  id: string;
  status: string;
  suspicious: boolean;
  review_status: string;
  punch_at: string;
  localDate: string;
  minute: number;
};

export function selectAttendanceDayEvents(ordered: readonly AttendancePunchEvent[]) {
  const normalIns = ordered.filter((p) => p.status === "IN");
  const normalOuts = ordered.filter((p) => p.status === "OUT");
  const overtimeIns = ordered.filter((p) => p.status === "OVERTIME_IN");
  const overtimeOuts = ordered.filter((p) => p.status === "OVERTIME_OUT");

  return {
    // Do not mistake an overtime checkout for the employee's regular shift checkout.
    inPunch: normalIns[0] ?? null,
    outPunch: normalOuts.at(-1) ?? null,
    otIn: overtimeIns[0] ?? null,
    otOut: overtimeOuts.at(-1) ?? null,
    needsReview:
      ordered.some((p) => p.suspicious || p.review_status === "PENDING") ||
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
