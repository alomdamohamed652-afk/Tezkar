"use client";
import {useEffect,useState} from "react";
import {api,ApiError} from "../lib/api";
import { Sidebar } from "../components/sidebar";

type Summary={
 production:{quantity:string;entries:number};
 earnings:{balance:string;earned:string;paid:string};
 stock:{lines:number;quantity:string;value:string};
 finance:{revenue:number;expenses:number;net:number};
 warehouse:{receiptsToday:string;deliveriesToday:string};
 pendingProduction:number;
 pendingPayments:number;
 pendingAdvances:number;
 orders:{total:number;active:number;completed:number};
};

export default function HomePage(){
 const [summary,setSummary]=useState<Summary|null>(null),[error,setError]=useState("");
 useEffect(()=>{api<{data:Summary}>("/api/dashboard/summary").then(x=>setSummary(x.data)).catch(e=>{if(e instanceof ApiError&&e.code==="FORBIDDEN"){window.location.replace("/my-production");return}setError(e instanceof Error?e.message:"تعذر تحميل لوحة التحكم")})},[]);
 const n=(v:string|number)=>Number(v||0).toLocaleString("ar-EG",{maximumFractionDigits:2});
 return <div className="app-shell"><Sidebar active="/" />
 <main className="main"><header className="topbar"><div><h1 className="page-title">لوحة التحكم الرئيسية</h1><p className="page-subtitle">صورة تفصيلية عن التشغيل والإنتاج والمخزن والمالية وحالة الطلبات.</p></div><a className="user-chip" href="/settings"><div className="avatar">ت</div><div><div className="user-name">إدارة النظام</div><div className="user-role">الإعدادات والحسابات</div></div></a></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 <div className="stats">
  <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">{summary?n(summary.production.quantity):"—"}</div><div className="stat-note">{summary?summary.production.entries+" سجل معتمد":"جاري التحميل"}</div></article>
  <article className="card stat accent"><div className="stat-label">صافي المستحقات</div><div className="stat-value">{summary?n(summary.earnings.balance):"—"}</div><div className="stat-note">بعد المدفوعات</div></article>
  <article className="card stat warning"><div className="stat-label">قيمة المخزون</div><div className="stat-value">{summary?n(summary.stock.value):"—"}</div><div className="stat-note">{summary?n(summary.stock.lines)+" رصيد نشط":"جاري التحميل"}</div></article>
  <article className="card stat neutral"><div className="stat-label">طلبات التشغيل</div><div className="stat-value">{summary?summary.orders.active:"—"}</div><div className="stat-note">{summary?summary.orders.total+" إجمالي · "+summary.orders.completed+" مكتمل":"جاري التحميل"}</div></article>
 </div>

 <div className="stats">
  <article className="card stat"><div className="stat-label">إجمالي الداخل</div><div className="stat-value">{summary?n(summary.finance.revenue):"—"}</div><div className="stat-note">إيرادات مسجلة</div></article>
  <article className="card stat warning"><div className="stat-label">إجمالي الخارج</div><div className="stat-value">{summary?n(summary.finance.expenses):"—"}</div><div className="stat-note">مصروفات مسجلة</div></article>
  <article className="card stat accent"><div className="stat-label">صافي المالية</div><div className="stat-value">{summary?n(summary.finance.net):"—"}</div><div className="stat-note">الداخل − الخارج</div></article>
  <article className="card stat neutral"><div className="stat-label">إنتاج بانتظار المراجعة</div><div className="stat-value">{summary?summary.pendingProduction:"—"}</div><div className="stat-note">سجلات تحتاج اعتماد</div></article>
 </div>

 <div className="grid">
  <section className="card"><div className="card-header"><h2 className="card-title">حالة التشغيل اليوم</h2></div><div className="card-body">
   <div className="detail-grid dashboard-detail">
    <div><b>استلامات اليوم</b><span>{summary?n(summary.warehouse.receiptsToday):"—"}</span></div>
    <div><b>تسليمات اليوم</b><span>{summary?n(summary.warehouse.deliveriesToday):"—"}</span></div>
    <div><b>طلبات سلف معلقة</b><span>{summary?summary.pendingAdvances:"—"}</span></div>
    <div><b>طلبات قبض معلقة</b><span>{summary?summary.pendingPayments:"—"}</span></div>
    <div><b>كمية المخزون</b><span>{summary?n(summary.stock.quantity):"—"}</span></div>
    <div><b>إجمالي المستحق المعتمد</b><span>{summary?n(summary.earnings.earned):"—"}</span></div>
   </div>
  </div></section>
  <section className="card"><div className="card-header"><h2 className="card-title">الوصول السريع</h2></div><div className="card-body"><div className="quick-grid">
   <a className="quick" href="/orders"><strong>الطلبات</strong><span>إنشاء ومتابعة الطلبات ومراحلها</span></a>
   <a className="quick" href="/production"><strong>الإنتاج</strong><span>تسجيل ومراجعة إنتاج العمال</span></a>
   <a className="quick" href="/warehouse"><strong>المخزن</strong><span>الأرصدة والحركات والتكلفة</span></a>
   <a className="quick" href="/accounting"><strong>المالية</strong><span>الداخل والخارج والربحية</span></a>
   <a className="quick" href="/receipts"><strong>الاستلامات</strong><span>إضافة ومتابعة الداخل للمخزن</span></a>
   <a className="quick" href="/deliveries"><strong>التسليمات</strong><span>خروج الطلبات والمسح قبل الخروج</span></a>
  </div></div></section>
 </div>
 </section></main></div>
}
