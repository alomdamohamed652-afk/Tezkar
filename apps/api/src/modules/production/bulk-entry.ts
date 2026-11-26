// Pure parser for the pasted daily production message. No database access and no writes:
// it turns text into draft rows that a person reviews and edits before anything is registered.
//
// Message shape:
//   line 1: date (d/m/yyyy or yyyy-mm-dd, Arabic or Latin digits)
//   line 2: shift supervisor (optional label, e.g. "مسؤول الوردية: اسم")
//   next lines: الاسم - المرحلة - العدد - الطلبية

export const WORKER_MATCH_THRESHOLD = 0.8;
export const FUZZY_THRESHOLD = 0.8;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export function westernDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, ch => {
    const a = AR_DIGITS.indexOf(ch);
    return String(a >= 0 ? a : FA_DIGITS.indexOf(ch));
  });
}

// Letters only, spelling variants folded, all spaces and punctuation removed so that
// "سلفنة بين بوكس" and "سلفنة بينبوكس" compare equal.
export function normalizeArabic(input: string): string {
  return westernDigits(input)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// Order labels often carry a prefix word: "طلبية خالد صقر", "أ/ خالد صقر", "اوردر ...".
export function normalizeOrderLabel(input: string): string {
  const s = westernDigits(input).trim()
    .replace(/^[أاإ]\s*[/\\]\s*/u, "")
    .replace(/^(?:طلبي[ةه]|الطلبي[ةه]|[أا]وردر|طلب)\s*[/:-]?\s*/u, "");
  return normalizeArabic(s);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function similarity(a: string, b: string): number {
  const x = normalizeArabic(a);
  const y = normalizeArabic(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function orderSimilarity(a: string, b: string): number {
  const x = normalizeOrderLabel(a);
  const y = normalizeOrderLabel(b);
  if (!x || !y) return 0;
  const direct = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  // one label contains the other ("خالد صقر" inside "طلبية خالد صقر 2")
  const contained = (x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 4 ? 0.9 : 0;
  return Math.max(direct, contained);
}

// A worker typed with fewer names than the full name ("محمد علي" for "محمد علي حسن")
// matches when every typed word fuzzy-matches a distinct word of the full name.
function nameSimilarity(typed: string, full: string): number {
  const base = similarity(typed, full);
  const tw = westernDigits(typed).split(/\s+/).filter(Boolean);
  const fw = westernDigits(full).split(/\s+/).filter(Boolean);
  if (tw.length < 2 || tw.length >= fw.length) return base;
  const used = new Set<number>();
  let total = 0;
  for (const t of tw) {
    let best = 0, bi = -1;
    fw.forEach((f, i) => { if (used.has(i)) return; const s = similarity(t, f); if (s > best) { best = s; bi = i; } });
    if (best < 0.8) return base;
    used.add(bi);
    total += best;
  }
  return Math.max(base, Math.min(0.85, total / tw.length));
}

export type Candidate = { id: string; label: string; score: number };

export type BulkLookup = {
  employees: { id: string; code?: string; full_name: string }[];
  orders: { id: string; code?: string; order_name: string }[];
  orderStages: { id: string; order_id: string; stage_id: string; stage_name: string; output_product_id?: string | null }[];
  shifts: { id: string; name: string }[];
  shiftLeaders: { shift_id: string; employee_id: string; employee_name: string }[];
};

export type DraftRow = {
  line: number;
  raw: string;
  workerText: string; stageText: string; orderText: string;
  quantity: number | null;
  employeeId: string | null; employeeName: string | null; employeeScore: number;
  employeeCandidates: Candidate[];
  orderId: string | null; orderName: string | null; orderScore: number;
  orderCandidates: Candidate[];
  orderStageId: string | null; stageId: string | null; stageName: string | null; stageScore: number;
  stageCandidates: Candidate[];
  outputProductId: string | null;
  problems: string[];
};

export type BulkParseResult = {
  workDate: string | null;
  supervisorText: string | null;
  shiftId: string | null; shiftName: string | null;
  shiftLeaderEmployeeId: string | null; shiftLeaderName: string | null;
  rows: DraftRow[];
  problems: string[];
};

export function parseDate(text: string): string | null {
  const t = westernDigits(text);
  let m = t.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; }
  else {
    m = t.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (!m) return null;
    d = +m[1]!; mo = +m[2]!; y = +m[3]!; if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseQuantity(text: string): number | null {
  const t = westernDigits(text).replace(/[,٬،\s]/g, "").replace(/٫/g, ".");
  const m = t.match(/^\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SUPERVISOR_LABEL = /^\s*(?:مسؤول|مسئول|مشرف|ليدر|مسؤل)\s*(?:ال)?(?:وردي[ةه])?\s*[:：-]?\s*/u;

export function parseBulkMessage(message: string, lookup: BulkLookup): BulkParseResult {
  const lines = message.replace(/\r/g, "").split("\n").map(l => l.trim());
  const result: BulkParseResult = {
    workDate: null, supervisorText: null, shiftId: null, shiftName: null,
    shiftLeaderEmployeeId: null, shiftLeaderName: null, rows: [], problems: []
  };
  let idx = lines.findIndex(l => l.length > 0);
  if (idx < 0) { result.problems.push("الرسالة فاضية"); return result; }
  result.workDate = parseDate(lines[idx] ?? "");
  if (!result.workDate) result.problems.push("مش لاقي التاريخ في أول سطر");
  else idx++;
  // Supervisor line: the next non-empty line, unless it already looks like a worker row (3+ dashes parts).
  const splitRow = (l: string) => l.split(/\s*[-–—]\s*/u).map(s => s.trim()).filter(s => s.length > 0);
  let next = idx;
  while (next < lines.length && !lines[next]) next++;
  if (next < lines.length && splitRow(lines[next] ?? "").length < 3) {
    const text = (lines[next] ?? "").replace(SUPERVISOR_LABEL, "").trim();
    result.supervisorText = text || null;
    idx = next + 1;
    if (text) {
      const scored = lookup.shiftLeaders.map(l => ({ l, s: nameSimilarity(text, l.employee_name) })).sort((x, y) => y.s - x.s);
      const best = scored[0];
      const second = scored.find(x => best && x.l.employee_id !== best.l.employee_id);
      if (best && best.s >= WORKER_MATCH_THRESHOLD && !(second && second.s >= WORKER_MATCH_THRESHOLD && best.s - second.s < 0.04)) {
        result.shiftLeaderEmployeeId = best.l.employee_id;
        result.shiftLeaderName = best.l.employee_name;
        result.shiftId = best.l.shift_id;
        result.shiftName = lookup.shifts.find(s => s.id === best.l.shift_id)?.name ?? null;
      } else {
        result.problems.push("مسؤول الوردية مش مطابق لحد من المسؤولين المسجلين: " + text);
      }
    }
  }
  for (let i = idx; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const parts = splitRow(raw);
    const row: DraftRow = {
      line: i + 1, raw, workerText: parts[0] ?? "", stageText: parts[1] ?? "", orderText: parts.slice(3).join(" - "),
      quantity: parts.length >= 3 ? parseQuantity(parts[2] ?? "") : null,
      employeeId: null, employeeName: null, employeeScore: 0, employeeCandidates: [],
      orderId: null, orderName: null, orderScore: 0, orderCandidates: [],
      orderStageId: null, stageId: null, stageName: null, stageScore: 0, stageCandidates: [],
      outputProductId: null, problems: []
    };
    if (parts.length < 4) row.problems.push("السطر ناقص: لازم الاسم - المرحلة - العدد - الطلبية");
    if (parts.length >= 3 && row.quantity === null) row.problems.push("العدد مش مفهوم");

    // worker
    const emp = lookup.employees.map(e => ({ e, s: nameSimilarity(row.workerText, e.full_name) })).sort((a, b) => b.s - a.s);
    row.employeeCandidates = emp.slice(0, 3).map(x => ({ id: x.e.id, label: x.e.full_name, score: Math.round(x.s * 1000) / 1000 }));
    if (emp[0] && emp[0].s >= WORKER_MATCH_THRESHOLD) {
      if (emp[1] && emp[1].s >= WORKER_MATCH_THRESHOLD && emp[0].s - emp[1].s < 0.04) {
        row.problems.push("أكتر من عامل قريب من الاسم، اختار الصح");
      } else {
        row.employeeId = emp[0].e.id; row.employeeName = emp[0].e.full_name; row.employeeScore = Math.round(emp[0].s * 1000) / 1000;
      }
    } else if (row.workerText) row.problems.push("العامل مش مطابق 80% لأي اسم: " + row.workerText);

    // order
    const ord = lookup.orders.map(o => ({ o, s: orderSimilarity(row.orderText, o.order_name) })).sort((a, b) => b.s - a.s);
    row.orderCandidates = ord.slice(0, 3).map(x => ({ id: x.o.id, label: x.o.order_name, score: Math.round(x.s * 1000) / 1000 }));
    if (ord[0] && ord[0].s >= FUZZY_THRESHOLD) {
      if (ord[1] && ord[1].s >= FUZZY_THRESHOLD && ord[0].s - ord[1].s < 0.04) {
        row.problems.push("أكتر من طلبية قريبة من الاسم، اختار الصح");
      } else {
        row.orderId = ord[0].o.id; row.orderName = ord[0].o.order_name; row.orderScore = Math.round(ord[0].s * 1000) / 1000;
      }
    } else if (row.orderText) row.problems.push("الطلبية مش مطابقة: " + row.orderText);

    // stage inside the matched order
    if (row.orderId) {
      const stages = lookup.orderStages.filter(s => s.order_id === row.orderId);
      const st = stages.map(s => ({ s, sc: similarity(row.stageText, s.stage_name) })).sort((a, b) => b.sc - a.sc);
      row.stageCandidates = st.slice(0, 3).map(x => ({ id: x.s.id, label: x.s.stage_name, score: Math.round(x.sc * 1000) / 1000 }));
      if (st[0] && st[0].sc >= FUZZY_THRESHOLD) {
        if (st[1] && st[1].sc >= FUZZY_THRESHOLD && st[0].sc - st[1].sc < 0.04) {
          row.problems.push("أكتر من مرحلة قريبة في الطلبية، اختار الصح");
        } else {
          row.orderStageId = st[0].s.id; row.stageId = st[0].s.stage_id; row.stageName = st[0].s.stage_name;
          row.stageScore = Math.round(st[0].sc * 1000) / 1000; row.outputProductId = st[0].s.output_product_id ?? null;
        }
      } else if (row.stageText) row.problems.push("المرحلة مش موجودة في الطلبية: " + row.stageText);
    }
    result.rows.push(row);
  }
  if (!result.rows.length) result.problems.push("مفيش سطور عمال");
  return result;
}
