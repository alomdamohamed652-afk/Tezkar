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
    return { basisAmount: input.fixedAmount, amount: Math.round((input.fixedAmount + Number.EPSILON) * 100) / 100 };
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
