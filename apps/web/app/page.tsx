const cards = [
  { label: "الإنتاج اليوم", value: "—", tone: "primary" },
  { label: "المستحقات", value: "—", tone: "accent" },
  { label: "حركات المخزن", value: "—", tone: "neutral" }
];

export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", padding: 24 }}>
      <section style={{
        maxWidth: 1180, margin: "0 auto", background: "var(--surface)",
        border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-md)", overflow: "hidden"
      }}>
        <header style={{
          padding: "20px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16
        }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--brand-primary)" }}>تيزكار</div>
            <div style={{ color: "var(--brand-muted)", marginTop: 4 }}>منصة إدارة المصنع</div>
          </div>
          <div aria-hidden style={{
            width: 12, height: 12, borderRadius: "50%", background: "var(--brand-accent)",
            boxShadow: "0 0 0 5px rgb(33 217 156 / 12%)"
          }} />
        </header>
        <div style={{
          padding: 24, display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16
        }}>
          {cards.map((card) => (
            <article key={card.label} style={{
              padding: 20, border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
              background: card.tone === "primary" ? "rgb(46 91 255 / 6%)"
                : card.tone === "accent" ? "rgb(33 217 156 / 7%)" : "var(--surface)",
              boxShadow: "var(--shadow-sm)"
            }}>
              <div style={{ color: "var(--brand-muted)", fontSize: 14 }}>{card.label}</div>
              <div style={{ fontSize: 30, fontWeight: 700, marginTop: 8 }}>{card.value}</div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
