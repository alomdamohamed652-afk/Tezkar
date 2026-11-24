export interface PayrollAttendanceDay {
  date: string;
  status: string;
  isDayOff?: boolean;
  workedMinutes?: number;
  lateMinutes?: number;
  earlyMinutes?: number;
  overtimeMinutes?: number;
  paidPermissionMinutes?: number;
  unpaidPermissionMinutes?: number;
  needsReview?: boolean;
  /** True when a manager explicitly settled the day in the monthly review (note-audited override). */
  manualOverride?: boolean;
}

export interface PayrollAttendancePolicy {
  workDaysPerMonth: number;
  dailyWorkMinutes: number;
  dayOffPayAmount: number;
  overtimeMultiplier: number;
  /** Shared monthly rest/paid-leave allowance per employee. null/undefined keeps legacy rest-day bonus behavior. */
  allowedLeaveDaysPerMonth?: number | null;
  /** Effective scheduled minutes for employees whose salary is active for only part of the month. */
  scheduledMinutes?: number;
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const minutes = (value: number | undefined) => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) throw new RangeError("Invalid attendance minutes.");
  return Math.trunc(parsed);
};

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
  const scheduledMinutes = policy.scheduledMinutes ?? policy.workDaysPerMonth * policy.dailyWorkMinutes;
  if (!Number.isFinite(scheduledMinutes) || scheduledMinutes <= 0) {
    throw new RangeError("Invalid scheduled payroll minutes.");
  }
  const minuteRate = (baseSalary + existingBonus) / scheduledMinutes;
  const leaveAllowance = policy.allowedLeaveDaysPerMonth ?? null;
  if (leaveAllowance !== null && (!Number.isInteger(leaveAllowance) || leaveAllowance < 0 || leaveAllowance > 31)) {
    throw new RangeError("Invalid payroll attendance policy.");
  }
  let lateMinutes = 0, earlyMinutes = 0, paidPermissionMinutes = 0, unpaidPermissionMinutes = 0;
  let absenceMinutes = 0, unpaidLeaveMinutes = 0, overtimeMinutes = 0, dayOffWorkedMinutes = 0;
  let attendedDays = 0, poolDays = 0;
  for (const day of days) {
    if (day.needsReview) throw new Error("ATTENDANCE_REVIEW_REQUIRED");
    const worked = minutes(day.workedMinutes);
    paidPermissionMinutes += minutes(day.paidPermissionMinutes);
    if (day.isDayOff || day.status === "DAY_OFF" || day.status === "DAY_OFF_WITH_PUNCH") {
      if (leaveAllowance !== null) {
        // Flexible-rest model: an unworked rest/leave day consumes the shared allowance;
        // a worked day counts as attendance instead of a rest-day bonus, so the same day
        // is never paid both as rest-work bonus and as leave-payout/extra-day pay.
        if (worked > 0) attendedDays++; else poolDays++;
        continue;
      }
      dayOffWorkedMinutes += worked;
      continue;
    }
    if (day.status === "MISSING_PUNCH") throw new Error("ATTENDANCE_MISSING_PUNCH");
    if (day.status === "NO_SCHEDULE" || day.status === "NO_SCHEDULE_WITH_PUNCH") throw new Error("ATTENDANCE_SCHEDULE_REQUIRED");
    if (day.status === "ABSENT") {
      // Flexible-rest model: an unworked day becomes paid rest from the allowance, but a workday
      // with no punches is an unconfirmed record (possible device outage). It must neither deduct
      // nor consume the allowance silently; a manager settles it as paid leave or confirmed absence.
      if (leaveAllowance !== null && !day.manualOverride) throw new Error("ATTENDANCE_ABSENCE_UNCONFIRMED");
      const unpaidPermission = minutes(day.unpaidPermissionMinutes);
      unpaidPermissionMinutes += unpaidPermission;
      absenceMinutes += Math.max(0, policy.dailyWorkMinutes - minutes(day.paidPermissionMinutes) - unpaidPermission);
      continue;
    }
    if (day.status === "UNPAID_LEAVE") {
      const unpaidPermission = minutes(day.unpaidPermissionMinutes);
      unpaidPermissionMinutes += unpaidPermission;
      unpaidLeaveMinutes += Math.max(0, policy.dailyWorkMinutes - minutes(day.paidPermissionMinutes) - unpaidPermission);
      continue;
    }
    if (leaveAllowance !== null && (day.status === "PRESENT" || day.status === "MANUAL")) attendedDays++;
    lateMinutes += minutes(day.lateMinutes);
    earlyMinutes += minutes(day.earlyMinutes);
    unpaidPermissionMinutes += minutes(day.unpaidPermissionMinutes);
    overtimeMinutes += minutes(day.overtimeMinutes);
  }
  if (dayOffWorkedMinutes > 0 && policy.dayOffPayAmount <= 0) throw new Error("DAY_OFF_RATE_REQUIRED");
  const deductionMinutes = lateMinutes + earlyMinutes + unpaidPermissionMinutes + absenceMinutes + unpaidLeaveMinutes;
  const deductionAmount = money(deductionMinutes * minuteRate);
  const overtimeBonus = money(overtimeMinutes * minuteRate * policy.overtimeMultiplier);
  const dayOffBonus = money((dayOffWorkedMinutes / policy.dailyWorkMinutes) * policy.dayOffPayAmount);
  // Confirmed model: the unused allowance is paid out once at the configured per-employee day
  // rate. Any extra-day term beyond this is unapproved and deliberately not computed. The payout
  // is blocked for partial salary periods until an explicit proration rule exists.
  const restDaysUsed = leaveAllowance === null ? 0 : Math.min(leaveAllowance, poolDays);
  const leavePayoutDays = leaveAllowance === null ? 0 : leaveAllowance - restDaysUsed;
  const fullPeriod = policy.scheduledMinutes === undefined || policy.scheduledMinutes === policy.workDaysPerMonth * policy.dailyWorkMinutes;
  if (leavePayoutDays > 0 && !fullPeriod) throw new Error("LEAVE_PAYOUT_PERIOD_UNRESOLVED");
  if (leavePayoutDays > 0 && policy.dayOffPayAmount <= 0) throw new Error("DAY_OFF_RATE_REQUIRED");
  const leavePayoutAmount = money(leavePayoutDays * policy.dayOffPayAmount);
  return {
    scheduledMinutes, minuteRate: Math.round((minuteRate + Number.EPSILON) * 10000) / 10000,
    lateMinutes, earlyMinutes, paidPermissionMinutes, unpaidPermissionMinutes, absenceMinutes, unpaidLeaveMinutes,
    deductionMinutes, overtimeMinutes, dayOffWorkedMinutes,
    deductionAmount, overtimeBonus, dayOffBonus,
    attendedDays, restDaysUsed, leavePayoutDays, leavePayoutAmount,
    totalBonus: money(overtimeBonus + dayOffBonus + leavePayoutAmount),
  };
}
