export function formatQuantity(value: unknown, maximumFractionDigits = 3): string {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("ar-EG", { maximumFractionDigits, useGrouping: true }).format(number);
}

export function formatMoney(value: unknown, maximumFractionDigits = 2): string {
  return formatQuantity(value, maximumFractionDigits);
}

export function formatInteger(value: unknown): string {
  return formatQuantity(value, 0);
}
