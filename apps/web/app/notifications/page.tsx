"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "../../components/sidebar";
import { api } from "../../lib/api";

type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  read_at: string | null;
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{data: Notification[]; unreadCount: number}>("/api/notifications");
      setItems(result.data);
      setUnreadCount(result.unreadCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل الإشعارات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function markRead(item: Notification) {
    if (item.read_at) return;
    setBusy(true);
    try {
      const result = await api<{data:{id:string;read_at:string}}>("/api/notifications/" + item.id + "/read", {method:"PATCH"});
      setItems(current => current.map(x => x.id === item.id ? {...x, read_at: result.data.read_at} : x));
      setUnreadCount(count => Math.max(0, count - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحديث الإشعار");
    } finally {
      setBusy(false);
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await api("/api/notifications/read-all", {method:"POST"});
      setItems(current => current.map(x => ({...x, read_at: x.read_at || new Date().toISOString()})));
      setUnreadCount(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحديث الإشعارات");
    } finally {
      setBusy(false);
    }
  }

  return <div className="app-shell"><Sidebar active="/notifications"/><main className="main">
    <header className="topbar"><div><h1 className="page-title">الإشعارات</h1><p className="page-subtitle">تنبيهات تخص المهام والتغييرات التي تؤثر على مسؤولياتك.</p></div>
      {unreadCount > 0 && <button className="primary-button" disabled={busy} onClick={markAllRead}>تحديد الكل كمقروء</button>}
    </header>
    {error && <div className="alert alert-error">{error}</div>}
    <section className="card"><div className="card-header"><h2 className="card-title">صندوق الإشعارات</h2><span className="count-badge">{unreadCount} غير مقروء</span></div>
      {loading ? <div className="empty">جارٍ تحميل الإشعارات...</div> : !items.length ? <div className="empty">لا توجد إشعارات حتى الآن.</div> :
        <div className="task-comments">{items.map(item => <article className="task-comment" key={item.id} style={!item.read_at ? {borderInlineStart:"4px solid var(--primary, #2563eb)", paddingInlineStart:12} : undefined}>
          <div><strong>{item.title}</strong><span>{new Date(item.created_at).toLocaleString("ar-EG")}</span></div>
          <p>{item.message}</p>
          <div className="form-actions">
            {!item.read_at && <button className="secondary-btn" disabled={busy} onClick={() => void markRead(item)}>تحديد كمقروء</button>}
            {item.entity_type === "task" && <a className="secondary-btn" href="/tasks">فتح المهام</a>}
            {item.entity_type === "password_reset_request" && <a className="secondary-btn" href="/password-reset-requests">فتح طلبات إعادة تعيين كلمة المرور</a>}
          </div>
        </article>)}</div>}
    </section>
  </main></div>;
}
