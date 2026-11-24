// node-pg parses DATE columns as local-midnight Date objects. Converting one with
// toISOString() shifts the calendar day in any non-UTC process timezone (Africa/Cairo
// turns 2099-01-01 into 2098-12-31), which made payroll approval resolve the previous
// month on Cairo-time machines. Local getters recover the stored calendar date in any TZ.
export function pgDateKey(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}
