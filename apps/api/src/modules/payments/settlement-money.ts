/** Numeric(18,4) accounting amounts. Round only at an account boundary. */
export function amountUnits(value: string | number): bigint {
  const text=String(value).trim();
  const match=/^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if(!match)throw new Error("Invalid four-decimal accounting amount");
  const magnitude=BigInt(match[2]!)*10000n+BigInt((match[3]??"").padEnd(4,"0"));
  return match[1]? -magnitude : magnitude;
}

/** PostgreSQL numeric round: halfway values round away from zero. */
export function centsFromUnits(units: bigint): bigint {
  return units<0n ? -((-units+50n)/100n) : (units+50n)/100n;
}

export function roundedAmount(units: bigint): number {
  const cents=centsFromUnits(units);
  if(cents>BigInt(Number.MAX_SAFE_INTEGER)||cents<BigInt(Number.MIN_SAFE_INTEGER)){
    throw new Error("Accounting amount exceeds safe output range");
  }
  return Number(cents)/100;
}

/** Never sum per-production clamps: overallocations offset positive dues. */
export function signedAccountBalance(rows: ReadonlyArray<{earned:string|number;paid:string|number}>): number {
  return roundedAmount(rows.reduce((sum,row)=>sum+amountUnits(row.earned)-amountUnits(row.paid),0n));
}

/** Only one allocation lineage is authoritative for a payment. */
export function allocationResidual(input: {
  gross:string|number;
  reversed:string|number;
  canonical:ReadonlyArray<string|number>;
  order:ReadonlyArray<string|number>;
  legacy:ReadonlyArray<string|number>;
}): number {
  const allocations=input.canonical.length?input.canonical:input.order.length?input.order:input.legacy;
  const remainder=amountUnits(input.gross)-amountUnits(input.reversed)
    -allocations.reduce<bigint>((sum,value)=>sum+amountUnits(value),0n);
  return roundedAmount(remainder>0n?remainder:0n);
}
