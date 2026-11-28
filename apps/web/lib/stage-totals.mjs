/**
 * Sums line amounts per stage inside one order, in stage order.
 * Lines without a stage are grouped under one label at the end.
 * @param {Array<{stageSequence: number|null, stageName: string|null, amount: number}>} lines
 * @returns {Array<{key: string, label: string, total: number}>}
 */
export function stageTotals(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = l.stageName ? `${l.stageSequence ?? ""}|${l.stageName}` : "none";
    const label = l.stageName ? `${l.stageSequence ? l.stageSequence + ". " : ""}${l.stageName}` : "بدون مرحلة";
    const cur = map.get(key) ?? { label, seq: l.stageName ? (l.stageSequence ?? 9999) : 99999, total: 0 };
    cur.total += Math.round((Number(l.amount) || 0) * 100);
    map.set(key, cur);
  }
  return [...map.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([key, v]) => ({ key, label: v.label, total: v.total / 100 }));
}
