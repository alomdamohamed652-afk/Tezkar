export type PayrollDeductionMode = "FIXED" | "PERCENTAGE";
export type PayrollDeductionBasis = "BASE_SALARY" | "BASE_PLUS_BONUS";

export interface PayrollDeductionInput {
  baseSalary: number;
  bonusAmount: number;
  mode: PayrollDeductionMode;
  basis: PayrollDeductionBasis;
  percentage: number | null;
  fixedAmount: number;
}

/**
 * Calculate the deduction in one place so the API and tests share the same
 * rounding and basis rules. The caller remains responsible for validating
 * request fields and ensuring the resulting net salary is non-negative.
 */
export function calculatePayrollDeduction(input: PayrollDeductionInput): { basisAmount: number; amount: number } {
  if (input.mode === "FIXED") {
    const amount = Math.round((input.fixedAmount + Number.EPSILON) * 100) / 100;
    return { basisAmount: amount, amount };
  }

  if (input.percentage === null || !Number.isFinite(input.percentage) || input.percentage <= 0 || input.percentage > 100) {
    throw new RangeError("A percentage deduction requires a percentage greater than 0 and at most 100.");
  }

  const basisAmount = input.basis === "BASE_PLUS_BONUS"
    ? input.baseSalary + input.bonusAmount
    : input.baseSalary;
  const amount = Math.round((basisAmount * input.percentage / 100 + Number.EPSILON) * 100) / 100;
  return { basisAmount, amount };
}

export type PayrollAttendanceDay = {
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  isDayOff?: boolean;
  salaryActive?: boolean;
  status?: string;
  needsReview?: boolean;
  workedMinutes?: number;
  overtimeMinutes?: number;
  lateMinutes?: number;
  earlyMinutes?: number;
};

export type AttendancePayrollResult = {
  scheduledMinutes: number;
  workedMinutes: number;
  missingMinutes: number;
  overtimeMinutes: number;
  hourlyRate: number;
  timeDeduction: number;
  overtimeBonus: number;
  reviewDays: number;
};

/**
 * Convert the reviewed attendance snapshot into payroll adjustments.
 * Incomplete or suspicious days are excluded from automatic deductions.
 * Grace periods are already applied by the attendance report's late/early values.
 */
export function calculateAttendancePayroll(input: {
  baseSalary: number;
  days: readonly PayrollAttendanceDay[];
  overtimeMultiplier: number;
}): AttendancePayrollResult {
  if (!Number.isFinite(input.baseSalary) || input.baseSalary < 0) {
    throw new RangeError("Base salary must be a non-negative finite number.");
  }
  if (!Number.isFinite(input.overtimeMultiplier) || input.overtimeMultiplier < 1 || input.overtimeMultiplier > 5) {
    throw new RangeError("Overtime multiplier must be between 1 and 5.");
  }

  const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const minutesForShift = (start?: string | null, end?: string | null) => {
    if (!start || !end) return 0;
    const parse = (value: string) => {
      const match = value.match(/^(\d{1,2}):(\d{2})/);
      return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
    };
    const startMinute = parse(start);
    const endMinute = parse(end);
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return 0;
    const duration = (endMinute - startMinute + 1440) % 1440;
    return duration > 0 ? duration : 0;
  };

  let scheduledMinutes = 0;
  let missingMinutes = 0;
  let overtimeMinutes = 0;
  let workedMinutes = 0;
  let reviewDays = 0;

  for (const day of input.days) {
    const scheduled = day.isDayOff || day.salaryActive === false ? 0 : minutesForShift(day.scheduledStart, day.scheduledEnd);
    scheduledMinutes += scheduled;

    const overtime = Math.max(0, Math.floor(Number(day.overtimeMinutes ?? 0)));
    if (day.salaryActive !== false && !day.needsReview && day.status !== "MISSING_PUNCH" && day.status !== "NO_SCHEDULE_WITH_PUNCH") {
      overtimeMinutes += overtime;
    }

    if (day.needsReview || day.status === "MISSING_PUNCH" || day.status === "NO_SCHEDULE_WITH_PUNCH") {
      reviewDays += 1;
      continue;
    }

    if (day.status === "ABSENT" && scheduled > 0) {
      missingMinutes += scheduled;
      continue;
    }

    if (day.status === "PRESENT" && scheduled > 0) {
      const late = Math.max(0, Math.floor(Number(day.lateMinutes ?? 0)));
      const early = Math.max(0, Math.floor(Number(day.earlyMinutes ?? 0)));
      const missed = Math.min(scheduled, late + early);
      missingMinutes += missed;
      workedMinutes += Math.min(scheduled, Math.max(0, Math.floor(Number(day.workedMinutes ?? (scheduled - missed))) - Math.floor(Number(day.overtimeMinutes ?? 0))));
    }
  }

  const hourlyRate = scheduledMinutes > 0 ? input.baseSalary * 60 / scheduledMinutes : 0;
  const timeDeduction = scheduledMinutes > 0
    ? roundMoney(input.baseSalary * missingMinutes / scheduledMinutes)
    : 0;
  const overtimeBonus = scheduledMinutes > 0
    ? roundMoney(input.baseSalary * overtimeMinutes / scheduledMinutes * input.overtimeMultiplier)
    : 0;

  return { scheduledMinutes, workedMinutes, missingMinutes, overtimeMinutes,
    hourlyRate: roundMoney(hourlyRate), timeDeduction, overtimeBonus, reviewDays };
}
