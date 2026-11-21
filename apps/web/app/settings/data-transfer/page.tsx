"use client";

import { useState } from "react";
import { api } from "../../../lib/api";
import { Sidebar } from "../../../components/sidebar";

type Inspection = {
  source: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  target: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  comparison: Array<{ table: string; status: string; sourceEstimate: number; targetEstimate: number; differences: string[] }>;
  blockers: Array<{ table: string; status: string; differences: string[] }>;
  note: string;
};
const labels: Record<string,string> = {compatible:"متوافق مبدئيًا",schema_mismatch:"اختلاف في البنية",source_only:"غير موجود في الوجهة",target_only:"موجود في الوجهة فقط"};

export default function DataTransferPage() {
  const [report,setReport]=useState<Inspection|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  async function inspect(){setLoading(true);setError("");try{setReport(await api<Inspection>("/api/admin/data-transfer/inspection"));}catch(e){setError(e instanceof Error?e.message:"تعذر فحص القاعدتين");}finally{setLoading(false);}}
  return <div dir="rtl" className="min-h-screen bg-slate-50 text-slate-900"><Sidebar active="/settings/data-transfer"/><main className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
    <header><p className="text-sm text-slate-500">إدارة النظام</p><h1 className="mt-1 text-2xl font-bold">نقل بيانات النظام القديم</h1><p className="mt-2 text-sm text-slate-600">فحص القاعدتين ومقارنة البنية قبل اعتماد أي نقل.</p></header>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">فحص للقراءة فقط. لن يتم تعديل القاعدة القديمة أو إدخال بيانات في القاعدة الجديدة.</div>
    <section className="rounded-xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">فحص الاتصال ومقارنة المخطط</h2><p className="mt-1 text-sm text-slate-500">الجداول والأعمدة والمفاتيح والعلاقات.</p></div><button onClick={inspect} disabled={loading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading?"جارٍ الفحص...":"ابدأ الفحص"}</button></div>{error&&<p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}</section>
    {report&&<><section className="grid gap-3 sm:grid-cols-2">{[["القاعدة القديمة",report.source],["القاعدة الجديدة",report.target]].map(([name,value])=>{const v=value as Inspection["source"];return <div key={name as string} className="rounded-xl border bg-white p-5"><p className="text-sm text-slate-500">{name as string}</p><p className="mt-2 text-2xl font-bold">{v.tableCount.toLocaleString("ar-EG")} جدول</p><p className="mt-1 text-sm">تقدير السجلات: {v.estimatedRows.toLocaleString("ar-EG")}</p><p className="text-sm">العلاقات: {v.foreignKeyCount.toLocaleString("ar-EG")}</p></div>})}</section>
    <section className="rounded-xl border bg-white p-5"><div className="flex justify-between gap-2"><h2 className="font-semibold">نتيجة مقارنة الجداول</h2><span className="text-sm text-slate-500">{report.comparison.length.toLocaleString("ar-EG")} جدول</span></div>{report.blockers.length>0&&<p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">توجد {report.blockers.length.toLocaleString("ar-EG")} حالة تحتاج مراجعة قبل تصميم خطة النقل.</p>}<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-right text-sm"><thead className="bg-slate-50"><tr><th className="p-3">الجدول</th><th className="p-3">الحالة</th><th className="p-3">المصدر (تقديري)</th><th className="p-3">الوجهة (تقديري)</th><th className="p-3">الملاحظات</th></tr></thead><tbody>{report.comparison.map(x=><tr key={x.table} className="border-t align-top"><td className="p-3 font-medium">{x.table}</td><td className="p-3">{labels[x.status]??x.status}</td><td className="p-3">{x.sourceEstimate.toLocaleString("ar-EG")}</td><td className="p-3">{x.targetEstimate.toLocaleString("ar-EG")}</td><td className="p-3">{x.differences.join("، ")||"لا توجد فروق بنيوية مكتشفة"}</td></tr>)}</tbody></table></div><p className="mt-4 text-xs text-slate-500">{report.note}</p></section></>}
  </main></div>;
}
