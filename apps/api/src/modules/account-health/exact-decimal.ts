/**
 * Exact comparison of plain decimal strings (as PostgreSQL returns NUMERIC).
 * JS Number() has about 15-16 significant digits, so two NUMERIC(18,4) balances
 * that differ by 0.0001 can compare equal once converted. Never convert money to Number to compare.
 */
export function normalizeDecimal(value: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || ((match[2] ?? "") === "" && (match[3] ?? "") === "")) throw new Error("INVALID_DECIMAL");
  const integer = (match[2] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const isZero = integer === "0" && fraction === "";
  return (match[1] === "-" && !isZero ? "-" : "") + integer + (fraction ? "." + fraction : "");
}

export function decimalEquals(a: string, b: string): boolean {
  return normalizeDecimal(a) === normalizeDecimal(b);
}

export function decimalIsZero(value: string): boolean {
  return normalizeDecimal(value) === "0";
}
