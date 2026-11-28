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
  originalStatus: "IN" | "OUT" | "OVERTIME_IN" | "OVERTIME_OUT";
  suggestedStatus: "IN" | "OUT" | "OVERTIME_IN" | "OVERTIME_OUT";
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

export type SwappedPunchCandidate = {
  id: string;
  status: string;
  punch_at: string;
  localDate: string;
  minute: number;
  corrected_status?: string | null;
  correction_decision?: string | null;
};

/**
 * Overnight missing checkout: an IN punched on the following calendar day close
 * to the overnight shift's end is likely the checkout recorded with the wrong
 * direction. Suggestion only; the raw punch is never rewritten here. A next-day
 * punch that is closer to the next day's own shift start (its real clock-in) is
 * never suggested.
 */
export function suggestOvernightCheckoutCorrections(input: {
  assignedPunches: readonly SwappedPunchCandidate[];
  nextDayPunches: readonly SwappedPunchCandidate[];
  startMinute: number;
  endMinute: number;
  nextShiftStartMinute: number | null;
  windowMinutes?: number;
}): SuggestedPunchCorrection[] {
  const { assignedPunches, nextDayPunches, startMinute, endMinute, nextShiftStartMinute } = input;
  const windowMinutes = input.windowMinutes ?? 240;
  const effective = (p: SwappedPunchCandidate) => p.corrected_status ?? p.status;
  const hasIn = assignedPunches.some((p) => effective(p) === "IN");
  const hasOut = assignedPunches.some((p) => effective(p) === "OUT" || effective(p) === "OVERTIME_OUT");
  if (!hasIn || hasOut) return [];
  return nextDayPunches.flatMap<SuggestedPunchCorrection>((p) => {
    if (p.status !== "IN" || p.corrected_status || p.correction_decision) return [];
    const distanceToOvernightEnd = Math.abs(p.minute - endMinute);
    if (distanceToOvernightEnd > windowMinutes) return [];
    if (nextShiftStartMinute !== null && Math.abs(p.minute - nextShiftStartMinute) < distanceToOvernightEnd) return [];
    return [{
      id: p.id,
      punchAt: p.punch_at,
      originalStatus: "IN" as const,
      suggestedStatus: "OUT" as const,
      reason: "بصمة دخول في صباح اليوم التالي قريبة من نهاية الوردية الليلية، ولا توجد بصمة خروج مسجلة للوردية؛ يُحتمل أنها خروج بدل دخول.",
    }];
  });
}

/**
 * Swapped overtime pair: two OVERTIME_IN punches in a row (or two OVERTIME_OUT)
 * cannot both be right, since overtime events must alternate. Suggest flipping
 * the later OVERTIME_IN to OVERTIME_OUT (or the earlier OVERTIME_OUT to
 * OVERTIME_IN). Suggestion only; never applied automatically.
 */
export function suggestOvertimeSequenceCorrections(input: {
  punches: readonly SwappedPunchCandidate[];
}): SuggestedPunchCorrection[] {
  const ordered = [...input.punches]
    .filter((p) => !p.corrected_status && !p.correction_decision)
    .sort((a, b) => new Date(a.punch_at).getTime() - new Date(b.punch_at).getTime());
  const suggestions: SuggestedPunchCorrection[] = [];
  let lastOvertime: SwappedPunchCandidate | null = null;
  for (const p of ordered) {
    if (p.status === "OVERTIME_IN") {
      if (lastOvertime && lastOvertime.status === "OVERTIME_IN") {
        suggestions.push({
          id: p.id,
          punchAt: p.punch_at,
          originalStatus: "OVERTIME_IN" as const,
          suggestedStatus: "OVERTIME_OUT" as const,
          reason: "بصمتا إضافي (دخول) متتاليتان بدون خروج إضافي بينهما؛ يُحتمل أن الثانية خروج إضافي بدل دخول.",
        });
      }
      lastOvertime = p;
    } else if (p.status === "OVERTIME_OUT") {
      if (lastOvertime && lastOvertime.status === "OVERTIME_OUT") {
        suggestions.push({
          id: lastOvertime.id,
          punchAt: lastOvertime.punch_at,
          originalStatus: "OVERTIME_OUT" as const,
          suggestedStatus: "OVERTIME_IN" as const,
          reason: "بصمتا إضافي (خروج) متتاليتان بدون دخول إضافي بينهما؛ يُحتمل أن الأولى دخول إضافي بدل خروج.",
        });
      }
      lastOvertime = p;
    }
  }
  return suggestions;
}
