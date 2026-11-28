export type StageTotal = { key: string; label: string; total: number };
export function stageTotals(lines: Array<{ stageSequence: number | null; stageName: string | null; amount: number }>): StageTotal[];
