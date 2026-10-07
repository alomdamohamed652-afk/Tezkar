const nav = [
  ["⌂", "الرئيسية", "/"],
  ["▣", "الموظفون", "/employees"],
  ["▤", "الإنتاج", "/production"],
  ["▥", "المخزن", "/warehouse"],
  ["◫", "المشتريات"],
  ["◇", "الطلبات"],
  ["₤", "المالية", "/payments"],
  ["▦", "التقارير", "#"]
];

const quick = [
  ["إضافة موظف", "إنشاء ملف موظف جديد"],
  ["تسجيل إنتاج", "إدخال إنتاج وردية"],
  ["حركة مخزن", "إضافة وارد أو صرف"],
  ["حركة مالية", "تسجيل قبض أو مصروف"]
];

export default function HomePage() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-copy">
            <div className="brand-name">تيزكار</div>
            <div className="brand-sub">إدارة المصنع</div>
          </div>
        </div>
        <div className="nav-title">النظام</div>
        <nav className="nav" aria-label="التنقل الرئيسي">
          {nav.map(([icon, label, href], index) => (
            <a className={`nav-item${index === 0 ? " active" : ""}`} href={href} key={label}>
              <span className="nav-icon">{icon}</span>
              <span>{label}</span>
            </a>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">لوحة التحكم</h1>
            <p className="page-subtitle">نظرة سريعة على حركة المصنع اليوم</p>
          </div>
          <div className="user-chip">
            <div className="avatar">م</div>
            <div>
              <div className="user-name">المستخدم الحالي</div>
              <div className="user-role">مدير النظام</div>
            </div>
          </div>
        </header>

        <section className="content">
          <div className="stats">
            <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">—</div><div className="stat-note">بانتظار ربط بيانات الإنتاج</div></article>
            <article className="card stat accent"><div className="stat-label">مستحقات العاملين</div><div className="stat-value">—</div><div className="stat-note">الأجر المعتمد غير المدفوع</div></article>
            <article className="card stat warning"><div className="stat-label">حركات المخزن</div><div className="stat-value">—</div><div className="stat-note">الوارد والصرف والتسويات</div></article>
            <article className="card stat neutral"><div className="stat-label">طلبات الدفع</div><div className="stat-value">—</div><div className="stat-note">طلبات تحتاج مراجعة</div></article>
          </div>

          <div className="grid">
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">النشاط الأخير</h2>
                <a className="link-button" href="#">عرض الكل</a>
              </div>
              <div className="empty">لا توجد حركة مسجلة بعد.<br />سيظهر هنا آخر نشاط بمجرد تشغيل الوحدات التشغيلية.</div>
            </section>

            <section className="card">
              <div className="card-header"><h2 className="card-title">اختصارات سريعة</h2></div>
              <div className="card-body">
                <div className="quick-grid">
                  {quick.map(([title, desc]) => (
                    <a className="quick" href="#" key={title}>
                      <strong>{title}</strong><span>{desc}</span>
                    </a>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
