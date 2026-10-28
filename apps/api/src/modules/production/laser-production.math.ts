export function calculateExpectedQuantity(cyclesCount: number, piecesPerCycle: number): number {
  if (!Number.isInteger(cyclesCount) || cyclesCount < 1) throw new Error("cyclesCount must be a positive integer");
  if (!Number.isInteger(piecesPerCycle) || piecesPerCycle < 1) throw new Error("piecesPerCycle must be a positive integer");
  return cyclesCount * piecesPerCycle;
}

export function isRunQuantityWithinExpected(expected: number, good: number, scrap: number, tolerance = 0.0001): boolean {
  if (![expected, good, scrap, tolerance].every(Number.isFinite)) return false;
  if (expected < 0 || good < 0 || scrap < 0 || tolerance < 0) return false;
  return good + scrap <= expected + tolerance;
}

export function calculateScrapRatePercent(good: number, scrap: number): number {
  if (![good, scrap].every(Number.isFinite) || good < 0 || scrap < 0) {
    throw new Error("good and scrap quantities must be finite and non-negative");
  }
  const total = good + scrap;
  if (total === 0) return 0;
  return Math.round((scrap / total) * 10000) / 100;
}

export function monthlyTargetBounds(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error("date is not a valid calendar date");
  }
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from: date, to };
}
