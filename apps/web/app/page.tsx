"use client";

import { useState } from "react";

const nav = [
  ["▦", "لوحة التحكم", true],
  ["👥", "الموظفين"], ["⌁", "الإنتاج والأجور"], ["▣", "المخزن"],
  ["◫", "المشتريات"], ["◈", "الطلبات"], ["▤", "المالية"],
  ["✓", "الحضور والانصراف"], ["⚙", "الإعدادات"]
];

export default function HomePage() {
  const [open, setOpen] = useState(false);
  return <div className="app">
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark">ت</div><div><strong>TEZKAR</strong><span>Factory Management</span></div></div>
      <nav className="nav"><p className="nav-title">الإدارة</p>
        {nav.map(([icon,label,active]) => <button key={label} className={`nav-item ${active ? "active" : ""}`} onClick={()=>setOpen(false)}><span className="icon">{icon}</span><span>{label}</span></button>)}
      </nav>
    </aside>
    {open && <div className="sidebar-backdrop show" onClick={()=>setOpen(false)}/>}
    <div className="main">
      <header className="topbar">
        <div className="top-title"><h1>لوحة التحكم</h1><p>نظرة سريعة على حركة المصنع</p></div>
        <div className="user"><button className="mobile-menu" onClick={()=>setOpen(true)}>☰</button><div><strong>المدير</strong><div style={{color:"#98a2b3",fontSize:11}}>حساب الإدارة</div></div><div className="avatar">م</div></div>
      </header>
      <main className="content">
        <section className="hero"><div><h2>أهلاً بك في TEZKAR</h2><p>كل عمليات المصنع في مكان واحد — إنتاج، مخزن، مالية وموظفين.</p></div><div className="hero-badge">النظام جاهز للإدارة</div></section>
        <section className="grid">
          <Metric label="موظفون نشطون" value="—" sub="سيتم ربط البيانات"/>
          <Metric label="إنتاج اليوم" value="—" sub="بعد تفعيل الإنتاج"/>
          <Metric label="طلبات مفتوحة" value="—" sub="بعد تفعيل الطلبات"/>
          <Metric label="رصيد المخزن" value="—" sub="بعد تفعيل المخزون"/>
        </section>
        <div className="section-grid">
          <section className="card"><div className="section-title"><h3>آخر الحركات</h3><button className="link-btn">عرض الكل</button></div>
            <table className="table"><thead><tr><th>العملية</th><th>المستخدم</th><th>التاريخ</th><th>الحالة</th></tr></thead><tbody>
              <tr><td>تهيئة النظام</td><td>المدير</td><td>—</td><td><span className="status">مكتمل</span></td></tr>
              <tr><td>إعداد قاعدة البيانات</td><td>النظام</td><td>—</td><td><span className="status">مكتمل</span></td></tr>
            </tbody></table>
          </section>
          <section className="card"><div className="section-title"><h3>اختصارات</h3></div><div className="quick">
            <button><span>👤</span><strong>إضافة موظف</strong><small>بيانات الموظفين</small></button>
            <button><span>📦</span><strong>حركة مخزن</strong><small>وارد / صرف</small></button>
            <button><span>💰</span><strong>مالية</strong><small>IN / OUT</small></button>
          </div></section>
        </div>
      </main>
    </div>
  </div>;
}
function Metric({label,value,sub}:{label:string;value:string;sub:string}) {
  return <div className="card"><div className="metric-label">{label}</div><div className="metric">{value}</div><div className="metric-sub">{sub}</div></div>;
}
