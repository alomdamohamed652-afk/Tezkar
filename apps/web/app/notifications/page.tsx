"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "../../components/sidebar";
import { api } from "../../lib/api";

type Notification = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
};
const typeLabels: Record<string,string> = {
  TASK_ASSIGNED: "مهمة", PRODUCTION_APPROVED: "إنتاج", PAYMENT_REQUEST_APPROVED: "طلب قبض",
  PAYMENT_REQUEST_REJECTED: "طلب قبض", PAYMENT_PAID: "صرف", SYSTEM: "النظام"
};
export default function NotificationsPage() {
  const [items,setItems] = useState<Notification[]>([]);
  const [unread,setUnread] = useState(0);
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  async function load() {
    setLoading(true);setError("");
    try { const result = await api<{data:Notification[];unreadCount:number}>("/api/notifications?limit=100");setItems(result.data);setUnread(result.unreadCount); }
    catch(e) { setError(e instanceof Error?e.message:"تعذر تحميل الإشعارات"); }
    finally { setLoading(false); }
  }
  useEffect(()=>{void load()},[]);
  async function openItem(item:Notification) {
    try {
      if(!item.read_at) await api("/api/notifications/"+item.id+"/read",{method:"POST"});
      if(item.href && item.href.startsWith("/") && !item.href.startsWith("//")) window.location.href=item.href;
      else await load();
    } catch(e) { setError(e instanceof Error?e.message:"تعذر فتح الإشعار"); }
  }
  async function readAll() {
    setBusy(true);setError("");
    try { await api("/api/notifications/read-all",{method:"POST"});await load(); }
    catch(e) { setError(e instanceof Error?e.message:"تعذر تحديث الإشعارات"); }
    finally { setBusy(false); }
  }
  return <div className="app-shell"><Sidebar active="/notifications"/><main className="main">
    <header className="topbar"><div><h1 className="page-title">الإشعارات</h1><p className="page-subtitle">المهام الجديدة واعتمادات الإنتاج ونتائج طلبات القبض.</p></div><button className="secondary-btn" disabled={!unread||busy} onClick={()=>void readAll()}>{busy?"جارٍ التحديث...":"تحديد الكل كمقروء"}</button></header>
    <section className="content">{error&&<div className="alert error">{error}</div>}
      <div className="stats"><article className="card stat accent"><div className="stat-label">غير مقروء</div><div className="stat-value">{unread.toLocaleString("ar-EG")}</div></article><article className="card stat"><div className="stat-label">كل الإشعارات المعروضة</div><div className="stat-value">{items.length.toLocaleString("ar-EG")}</div></article></div>
      <section className="card"><div className="card-header"><h2 className="card-title">آخر الإشعارات</h2></div>
        {loading?<div className="empty">جارٍ تحميل الإشعارات...</div>:!items.length?<div className="empty">مفيش إشعارات لحد دلوقتي.</div>:<div className="notification-list">{items.map(item=><button key={item.id} className={"notification-item"+(!item.read_at?" unread":"")} onClick={()=>void openItem(item)}><span className="notification-mark">{!item.read_at?"●":"○"}</span><span className="notification-copy"><span className="notification-heading">{item.title}<span className="status muted">{typeLabels[item.notification_type]||"إشعار"}</span></span>{item.body&&<span className="notification-body">{item.body}</span>}<span className="notification-date">{new Date(item.created_at).toLocaleString("ar-EG")}</span></span>{item.href&&<span className="notification-open">عرض ←</span>}</button>)}</div>}
      </section>
    </section>
  </main></div>;
}
