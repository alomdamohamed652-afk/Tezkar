import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Noto Naskh Arabic (SIL OFL, see assets/fonts/OFL.txt). pdfkit + fontkit shape Arabic letters; run-level RTL ordering is done below.
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts");
const REGULAR = path.join(FONT_DIR, "NotoNaskhArabic-Regular.ttf");
const BOLD = path.join(FONT_DIR, "NotoNaskhArabic-Bold.ttf");
const LATIN = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const LATIN_BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

type Line = { productionId: string; productionCode: string; workDate: string; quantity: number | null; stageSequence: number | null; stageName: string | null; amount: number };
type Order = { orderId: string | null; orderCode: string | null; orderName: string | null; total: number; lines: Line[] };
export type PdfReceipt = {
  payment: { code: string; method: string; paidAt: string | Date; amount: number };
  employee: { code: string; name: string };
  orders: Order[];
  unallocatedAmount: number;
};

const METHOD_LABELS: Record<string, string> = { CASH: "نقدي", VODAFONE_CASH: "فودافون كاش", INSTAPAY: "إنستاباي", BANK: "تحويل بنكي" };
const money = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const day = (v: string | Date) => new Date(v).toISOString().slice(0, 10);

export function receiptFileName(receipt: PdfReceipt): string {
  const name = Array.from(receipt.employee.name.trim()).map(ch => (ch.charCodeAt(0) < 32 || "\\/:*?\"<>|".includes(ch) ? " " : ch)).join("").replace(/\s+/g, "-");
  return `فاتورة-${name}-${receipt.employee.code}-${day(receipt.payment.paidAt)}.pdf`;
}

type Token = { rtl: boolean; text: string };
/** Logical string -> tokens: each Arabic word alone, consecutive Latin/number words merged into one left-to-right run. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /([\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]+)|([A-Za-z0-9][A-Za-z0-9.,_/+-]*)|(\s+)|(.)/gu;
  let m: RegExpExecArray | null;
  let space = false;
  while ((m = re.exec(text))) {
    if (m[3]) { space = true; continue; }
    const rtl = !!m[1];
    const last = out[out.length - 1];
    if (!rtl && last && !last.rtl && !(m[4] && /[:،؛]/.test(m[4]))) last.text += (space ? " " : "") + m[0];
    else out.push({ rtl, text: m[0] });
    space = false;
  }
  return out;
}
const GAP = 0.3;

export function renderReceiptPdf(receipt: PdfReceipt): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: receiptFileName(receipt).replace(/\.pdf$/, ""), Author: "Tezkar" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("r", REGULAR);
    doc.registerFont("b", BOLD);
    doc.registerFont("lr", LATIN);
    doc.registerFont("lb", LATIN_BOLD);
    const L = 40, R = 555, W = R - L;

    // Draws a (possibly mixed Arabic/Latin/digit) string so that its right edge is at xRight, words placed one by one in visual order.
    const rtl = (text: string, xRight: number, y: number, o: { bold?: boolean; size?: number; color?: string } = {}) => {
      const size = o.size ?? 11;
      doc.fillColor(o.color ?? "#111827").fontSize(size);
      const tokens = tokenize(text).reverse();
      const fontFor = (t: Token) => (t.rtl ? (o.bold ? "b" : "r") : (o.bold ? "lb" : "lr"));
      const widths = tokens.map(t => doc.font(fontFor(t)).widthOfString(t.text));
      const gap = size * GAP;
      let x = xRight - widths.reduce((a, b) => a + b, 0) - gap * Math.max(0, tokens.length - 1);
      tokens.forEach((t, i) => { doc.font(fontFor(t)).text(t.text, x, y, { lineBreak: false }); x += (widths[i] ?? 0) + gap; });
    };
    // Places several independent parts (each its own direction) one after another, leftwards from xRight.
    const parts = (items: string[], xRight: number, y: number, o: { bold?: boolean; size?: number; color?: string } = {}) => {
      let x = xRight;
      for (const item of items) {
        rtl(item, x, y, o);
        const size = o.size ?? 11;
        const w = tokenize(item).reduce((a, t) => a + doc.font(t.rtl ? (o.bold ? "b" : "r") : (o.bold ? "lb" : "lr")).fontSize(size).widthOfString(t.text), 0) + size * GAP * Math.max(0, tokenize(item).length - 1);
        x -= w + size * 0.6;
      }
    };
    const ltrAt = (text: string, x: number, y: number, o: { bold?: boolean; size?: number } = {}) => {
      doc.font(o.bold ? "lb" : "lr").fontSize(o.size ?? 11).fillColor("#111827").text(text, x, y, { lineBreak: false });
    };
    const ensure = (y: number, need: number) => { if (y + need > 790) { doc.addPage(); return 40; } return y; };

    let y = 40;
    rtl("تذكار", R, y, { bold: true, size: 24 });
    rtl("فاتورة تسوية مستحقات عامل", R, y + 34, { size: 12, color: "#475569" });
    parts(["رقم الفاتورة:", receipt.payment.code], L + 200, y + 4, { size: 10, color: "#475569" });
    parts(["تاريخ التسوية:", day(receipt.payment.paidAt)], L + 200, y + 20, { size: 10, color: "#475569" });
    parts(["طريقة الصرف:", METHOD_LABELS[receipt.payment.method] ?? receipt.payment.method], L + 200, y + 36, { size: 10, color: "#475569" });
    y += 70;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor("#111827").stroke();
    y += 12;
    parts(["العامل:", receipt.employee.name, receipt.employee.code], R, y, { bold: true, size: 13 });
    y += 30;

    if (!receipt.orders.length) {
      rtl("لم توزع هذه التسوية على سجلات إنتاج. المبلغ مسجل على حساب العامل العام", R, y);
      y += 24;
    }
    // Columns from the right edge: production code, date, stage, quantity, amount.
    const cols = [{ w: 110, label: "كود الإنتاج" }, { w: 80, label: "التاريخ" }, { w: 150, label: "المرحلة" }, { w: 60, label: "الكمية" }, { w: 115, label: "المبلغ بالجنيه" }];
    const colRight: number[] = [];
    { let x = R; for (const c of cols) { colRight.push(x - 4); x -= c.w; } }
    for (const order of receipt.orders) {
      y = ensure(y, 70);
      parts(order.orderCode ? [order.orderCode, order.orderName ?? ""] : ["إنتاج غير مرتبط بطلبية"], R, y, { bold: true, size: 12 });
      y += 22;
      doc.rect(L, y - 3, W, 20).fill("#f1f5f9");
      cols.forEach((c, i) => rtl(c.label, colRight[i] ?? R, y, { bold: true, size: 10 }));
      y += 22;
      for (const line of order.lines) {
        y = ensure(y, 22);
        const cells = [line.productionCode, line.workDate, line.stageName ?? "-", line.quantity == null ? "-" : String(line.quantity), money(line.amount)];
        cells.forEach((t, i) => rtl(t, colRight[i] ?? R, y, { size: 10 }));
        y += 20;
        doc.moveTo(L, y - 4).lineTo(R, y - 4).lineWidth(0.4).strokeColor("#cbd5e1").stroke();
      }
      y = ensure(y, 26);
      rtl("إجمالي الطلبية", colRight[0] ?? R, y, { bold: true, size: 11 });
      rtl(money(order.total), colRight[4] ?? R, y, { bold: true, size: 11 });
      y += 32;
    }
    if (receipt.unallocatedAmount > 0.009) {
      y = ensure(y, 24);
      parts(["مبلغ غير موزع على إنتاج (حساب عام وفروق):", money(receipt.unallocatedAmount), "جنيه"], R, y);
      y += 26;
    }
    y = ensure(y, 90);
    doc.rect(L, y, W, 32).lineWidth(1.2).strokeColor("#111827").stroke();
    parts(["إجمالي التسوية:", money(receipt.payment.amount), "جنيه"], R - 10, y + 6, { bold: true, size: 15 });
    y += 70;
    parts(["توقيع المستلم:", "____________________"], R, y, { size: 11 });
    parts(["توقيع المحاسب:", "____________________"], L + 230, y, { size: 11 });
    doc.end();
  });
}
