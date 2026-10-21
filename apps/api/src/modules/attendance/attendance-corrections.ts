export type PunchCorrectionCandidate = {
  id: string;
  status: string;
  punch_at: string;
  localDate: string;
  minute: number;
  corrected_status?: string | null;
  correction_decision?: string | null;
};

export type SuggestedPunchCorrection = {
  id: string;
  punchAt: string;
  originalStatus: "IN" | "OUT";
  suggestedStatus: "IN" | "OUT";
  reason: string;
};

/**
 * Suggest (never silently apply) an IN/OUT correction only when a punch is
 * close to one shift boundary and a second punch confirms the opposite boundary.
 * The four-hour window is deliberately a review window, not an auto-approval.
 */
export function suggestBoundaryPunchCorrections(input: {
  punches: readonly PunchCorrectionCandidate[];
  shiftDate: string;
  startMinute: number | null;
  endMinute: number | null;
  overnight: boolean;
  windowMinutes?: number;
}): SuggestedPunchCorrection[] {
  const { punches, shiftDate, startMinute, endMinute, overnight } = input;
  if (startMinute === null || endMinute === null || !punches.length) return [];
  const windowMinutes = input.windowMinutes ?? 240;
  const shiftEnd = overnight ? endMinute + 1440 : endMinute;
  const nextDate = new Date(shiftDate + "T00:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDay = nextDate.toISOString().slice(0, 10);
  const relativeMinute = (p: PunchCorrectionCandidate) =>
    overnight && p.localDate === nextDay ? p.minute + 1440 : p.minute;
  const eligible = punches.filter((p) =>
    (p.status === "IN" || p.status === "OUT") &&
    !p.corrected_status &&
    !p.correction_decision
  );
  const distanceToStart = (p: PunchCorrectionCandidate) => Math.abs(relativeMinute(p) - startMinute);
  const distanceToEnd = (p: PunchCorrectionCandidate) => Math.abs(relativeMinute(p) - shiftEnd);
  const nearStart = (p: PunchCorrectionCandidate) => distanceToStart(p) <= windowMinutes && distanceToStart(p) < distanceToEnd(p);
  const nearEnd = (p: PunchCorrectionCandidate) => distanceToEnd(p) <= windowMinutes && distanceToEnd(p) < distanceToStart(p);
  const hasBoundaryPair = eligible.some((p) => nearStart(p) && eligible.some((other) => other.id !== p.id && nearEnd(other)));
  if (!hasBoundaryPair) return [];

  return eligible.flatMap<SuggestedPunchCorrection>((p) => {
    if (p.status === "OUT" && nearStart(p)) {
      return [{
        id: p.id, punchAt: p.punch_at, originalStatus: "OUT" as const,
        suggestedStatus: "IN" as const,
        reason: "البصمة قريبة من بداية الوردية، وتوجد بصمة أخرى قرب نهايتها؛ يُحتمل أنها دخول بدل خروج."
      }];
    }
    if (p.status === "IN" && nearEnd(p)) {
      return [{
        id: p.id, punchAt: p.punch_at, originalStatus: "IN" as const,
        suggestedStatus: "OUT" as const,
        reason: "البصمة قريبة من نهاية الوردية، وتوجد بصمة أخرى قرب بدايتها؛ يُحتمل أنها خروج بدل دخول."
      }];
    }
    return [];
  });
}
