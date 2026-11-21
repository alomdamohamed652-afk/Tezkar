export type ReverseCodeScanResult = "FOUND" | "UNKNOWN" | "DUPLICATE" | "VOIDED";

export function splitReverseCodeQuantities(totalQuantity: number, piecesPerCode: number): number[] {
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) throw new RangeError("Total quantity must be a positive safe integer");
  if (!Number.isSafeInteger(piecesPerCode) || piecesPerCode <= 0) throw new RangeError("Pieces per code must be a positive safe integer");
  const quantities: number[] = [];
  let remaining = totalQuantity;
  while (remaining > 0) {
    const quantity = Math.min(piecesPerCode, remaining);
    quantities.push(quantity);
    remaining -= quantity;
  }
  return quantities;
}

export function classifyReverseCodeScan(input: {
  duplicateInRequest: boolean;
  alreadyScannedInSession: boolean;
  codeStatus: "ACTIVE" | "VOIDED" | null;
}): ReverseCodeScanResult {
  if (input.duplicateInRequest || input.alreadyScannedInSession) return "DUPLICATE";
  if (input.codeStatus === "VOIDED") return "VOIDED";
  if (input.codeStatus === "ACTIVE") return "FOUND";
  return "UNKNOWN";
}
