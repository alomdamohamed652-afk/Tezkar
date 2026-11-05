export interface PayrollAttendanceDay {
  date: string;
  status: string;
  isDayOff?: boolean;
  workedMinutes?: number;
  lateMinutes?: number;
  earlyMinutes?: number;
  overtimeMinutes?: number;
  unpaidPermissionMinutes?: number;
  needsReview?: boolean;
}

export interface PayrollAttendancePolicy {
  workDaysPerMonth: number;
  dailyWorkMinutes: number;
  dayOffPayAmount: number;
  overtimeMultiplier: number;
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Spread monthly salary over the configured monthly working minutes. */
export function calculatePayrollAttendance(input: {
  baseSalary: number;
  existingBonus: number;
  policy: PayrollAttendancePolicy;
  days: readonly PayrollAttendanceDay[];
}) {
  const { baseSalary, existingBonus, policy, days } = input;
  if (!Number.isFinite(baseSalary) || baseSalary < 0 || !Number.isFinite(existingBonus) || existingBonus < 0) {
    throw new RangeError("Invalid salary amount.");
  }
  if (!Number.isInteger(policy.workDaysPerMonth) || policy.workDaysPerMonth < 1 || policy.workDaysPerMonth > 31
    || !Number.isInteger(policy.dailyWorkMinutes) || policy.dailyWorkMinutes < 1 || policy.dailyWorkMinutes > 1440
    || !Number.isFinite(policy.dayOffPayAmount) || policy.dayOffPayAmount < 0
    || !Number.isFinite(policy.overtimeMultiplier) || policy.overtimeMultiplier < 0 || policy.overtimeMultiplier > 5) {
    throw new RangeError("Invalid payroll attendance policy.");
  }
  const scheduledMinutes = policy.workDaysPerMonth * policy.dailyWorkMinutes;
  const minuteRate = (baseSalary + existingBonus) / scheduledMinutes;
  let lateMinutes = 0, earlyMinutes = 0, unpaidPermissionMinutes = 0;
  let absenceMinutes = 0, overtimeMinutes = 0, dayOffWorkedMinutes = 0;
  for (const day of days) {
    if (day.needsReview) throw new Error("ATTENDANCE_REVIEW_REQUIRED");
    const worked = Math.max(0, Math.trunc(Number(day.workedMinutes ?? 0)));
    if (day.isDayOff) {
      dayOffWorkedMinutes += worked;
      continue;
    }
    if (day.status === "MISSING_PUNCH") throw new Error("ATTENDANCE_MISSING_PUNCH");
    if (day.status === "ABSENT") {
      absenceMinutes += policy.dailyWorkMinutes;
      continue;
    }
    lateMinutes += Math.max(0, Math.trunc(Number(day.lateMinutes ?? 0)));
    earlyMinutes += Math.max(0, Math.trunc(Number(day.earlyMinutes ?? 0)));
    unpaidPermissionMinutes += Math.max(0, Math.trunc(Number(day.unpaidPermissionMinutes ?? 0)));
    overtimeMinutes += Math.max(0, Math.trunc(Number(day.overtimeMinutes ?? 0)));
  }
  const deductionMinutes = lateMinutes + earlyMinutes + unpaidPermissionMinutes + absenceMinutes;
  const deductionAmount = money(deductionMinutes * minuteRate);
  const overtimeBonus = money(overtimeMinutes * minuteRate * policy.overtimeMultiplier);
  const dayOffBonus = money((dayOffWorkedMinutes / policy.dailyWorkMinutes) * policy.dayOffPayAmount);
  return {
    scheduledMinutes, minuteRate: money(minuteRate),
    lateMinutes, earlyMinutes, unpaidPermissionMinutes, absenceMinutes,
    deductionMinutes, overtimeMinutes, dayOffWorkedMinutes,
    deductionAmount, overtimeBonus, dayOffBonus,
    totalBonus: money(overtimeBonus + dayOffBonus),
  };
}
