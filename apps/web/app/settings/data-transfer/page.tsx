"use client";

import { useState } from "react";
import { api } from "../../../lib/api";
import { Sidebar } from "../../../components/sidebar";

type Inspection = {
  source: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  target: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  comparison: Array<{ table: string; status: string; sourceEstimate: number; targetEstimate: number; differences: string[] }>;
  blockers: Array<{ table: string | null; status: string; differences: string[] }>;
  indexWarnings?: Array<{ table: string; message: string }>;
  transferPlan?: { orderedTables: string[]; blockedTables: string[]; blockers: string[] };
  sourceFeatures?: { views: number; materializedViews: number; foreignTables: number; rules: number; triggers: number; extensions: number; sequences: number; largeObjects: number; customTypes: number; routines: number };
  targetFeatures?: { views: number; materializedViews: number; foreignTables: number; rules: number; triggers: number; extensions: number; sequences: number; largeObjects: number; customTypes: number; routines: number };
  globalBlockers?: string[];
  note: string;
};

const statusLabels: Record<string, string> = {
  compatible: "متوافق مبدئيًا",
  schema_mismatch: "اختلاف في البنية",
  source_only: "غير موجود في الوجهة",
  target_only: "موجود في الوجهة فقط"
};

export default function DataTransferPage() {
  const [report, setReport] = useState<Inspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    setLoading(true);
    setError("");
    try {
      const result = await api<Inspection>("/api/admin/data-transfer/inspection");
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر فحص القاعدتين");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-900">
      <Sidebar active="/settings/data-transfer" />
      <main className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
        <header>
          <p className="text-sm font-medium text-slate-500">إدارة النظام</p>
          <h1 className="mt-1 text-2xl font-bold">نقل بيانات النظام القديم</h1>
          <p className="mt-2 text-sm text-slate-600">فحص ومقارنة قاعدة المصدر والقاعدة الجديدة قبل اعتماد أي عملية نقل.</p>
        </header>

        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          هذه المرحلة للقراءة فقط. لن يتم تعديل القاعدة القديمة أو إدخال بيانات في القاعدة الجديدة من هذه الشاشة.
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">فحص الاتصال ومقارنة المخطط</h2>
              <p className="mt-1 text-sm text-slate-500">يعرض الجداول والأعمدة والمفاتيح والعلاقات وتقديرات عدد السجلات.</p>
            </div>
            <button onClick={inspect} disabled={loading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {loading ? "جارٍ الفحص..." : "ابدأ الفحص"}
            </button>
          </div>
          {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </section>

        {report && <>
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border bg-white p-5">
              <p className="text-sm text-slate-500">قاعدة البيانات القديمة</p>
              <p className="mt-2 text-2xl font-bold">{report.source.tableCount.toLocaleString("ar-EG")} جدول</p>
              <p className="mt-1 text-sm text-slate-600">تقدير السجلات: {report.source.estimatedRows.toLocaleString("ar-EG")}</p>
              <p className="text-sm text-slate-600">العلاقات: {report.source.foreignKeyCount.toLocaleString("ar-EG")}</p>
            </div>
            <div className="rounded-xl border bg-white p-5">
              <p className="text-sm text-slate-500">قاعدة البيانات الجديدة</p>
              <p className="mt-2 text-2xl font-bold">{report.target.tableCount.toLocaleString("ar-EG")} جدول</p>
              <p className="mt-1 text-sm text-slate-600">تقدير السجلات: {report.target.estimatedRows.toLocaleString("ar-EG")}</p>
              <p className="text-sm text-slate-600">العلاقات: {report.target.foreignKeyCount.toLocaleString("ar-EG")}</p>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-semibold">نتيجة مقارنة الجداول</h2>
              <span className="text-sm text-slate-500">{report.comparison.length.toLocaleString("ar-EG")} جدول</span>
            </div>
            {report.blockers.length > 0 && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              توجد {report.blockers.length.toLocaleString("ar-EG")} حالة تمنع اعتماد النقل الآلي حاليًا. لن يتم تجاوز أي منها تلقائيًا.
              <ul className="mt-2 list-disc space-y-1 pr-5">
                {report.blockers.map((blocker, index) => <li key={`${blocker.table ?? "global"}-${index}`}>
                  {blocker.table ? <strong>{blocker.table}: </strong> : <strong>عائق عام: </strong>}
                  {blocker.differences.join("، ")}
                </li>)}
              </ul>
            </div>}
            {report.indexWarnings && report.indexWarnings.length > 0 && <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <strong>ملاحظات أداء الفهارس ({report.indexWarnings.length.toLocaleString("ar-EG")})</strong>
              <p className="mt-1 text-xs text-slate-500">هذه اختلافات في فهارس غير فريدة، ولا توقف خطة النقل تلقائيًا. يجب مراجعتها لتجنب تراجع أداء الاستعلامات بعد النقل.</p>
              <ul className="mt-2 list-disc space-y-1 pr-5">
                {report.indexWarnings.map((warning, index) => <li key={warning.table + "-" + index}><strong>{warning.table}: </strong>{warning.message}</li>)}
              </ul>
            </div>}
            {report.transferPlan && <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
              <h3 className="font-semibold">خطة ترتيب الجداول (للمراجعة فقط)</h3>
              <p className="mt-1 text-xs text-slate-500">الترتيب المقترح يحترم علاقات الأب والابن. لا ينفّذ أي نقل.</p>
              <p className="mt-2">الجداول القابلة للترتيب: {report.transferPlan.orderedTables.length.toLocaleString("ar-EG")}</p>
              {report.transferPlan.orderedTables.length > 0 && <p className="mt-1 break-words text-xs text-slate-600">{report.transferPlan.orderedTables.join(" ← ")}</p>}
              {report.transferPlan.blockedTables.length > 0 && <p className="mt-2 text-xs text-amber-800">جداول متوقفة: {report.transferPlan.blockedTables.join("، ")}</p>}
            </div>}
            {report.sourceFeatures && report.targetFeatures && <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
              <p>كائنات إضافية بالمصدر: Views {report.sourceFeatures.views}، Materialized Views {report.sourceFeatures.materializedViews}، Foreign Tables {report.sourceFeatures.foreignTables}، Rules {report.sourceFeatures.rules}، Triggers {report.sourceFeatures.triggers}، Functions {report.sourceFeatures.routines}، Sequences {report.sourceFeatures.sequences}، Large Objects {report.sourceFeatures.largeObjects}، Types {report.sourceFeatures.customTypes}</p>
              <p>كائنات إضافية بالوجهة: Views {report.targetFeatures.views}، Materialized Views {report.targetFeatures.materializedViews}، Foreign Tables {report.targetFeatures.foreignTables}، Rules {report.targetFeatures.rules}، Triggers {report.targetFeatures.triggers}، Functions {report.targetFeatures.routines}، Sequences {report.targetFeatures.sequences}، Large Objects {report.targetFeatures.largeObjects}، Types {report.targetFeatures.customTypes}</p>
            </div>}
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[680px] text-right text-sm">
                <thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">الجدول</th><th className="p-3">الحالة</th><th className="p-3">سجلات المصدر (تقديري)</th><th className="p-3">سجلات الوجهة (تقديري)</th><th className="p-3">ملاحظات</th></tr></thead>
                <tbody>{report.comparison.map(item => <tr key={item.table} className="border-t align-top">
                  <td className="p-3 font-medium">{item.table}</td>
                  <td className="p-3">{statusLabels[item.status] ?? item.status}</td>
                  <td className="p-3 tabular-nums">{item.sourceEstimate.toLocaleString("ar-EG")}</td>
                  <td className="p-3 tabular-nums">{item.targetEstimate.toLocaleString("ar-EG")}</td>
                  <td className="p-3">{item.differences.length ? item.differences.join("، ") : "لا توجد فروق بنيوية مكتشفة"}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-slate-500">{report.note}</p>
          </section>
        </>}
      </main>
    </div>
  );
}
