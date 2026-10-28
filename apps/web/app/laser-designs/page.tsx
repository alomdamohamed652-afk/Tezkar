"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Machine = { id: string; code: string; name: string; machine_type?: string | null };
const localDateKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
type Design = { id: string; code: string; name: string; thumbnail_url?: string | null; file_reference?: string | null; status: "ACTIVE" | "ARCHIVED"; version_count: number; latest_version_no: number | null };
type DesignVersion = { id: string; design_id: string; version_no: number; material_type: string; material_thickness_mm: string | number | null; width_mm: string | number | null; height_mm: string | number | null; unit_label: string; pieces_per_cycle: number; standard_cycle_seconds: string | number | null; notes?: string | null; status: "ACTIVE" | "ARCHIVED"; design_code: string; design_name: string; design_status?: "ACTIVE" | "ARCHIVED" };
type Compatibility = { id: string; machine_id: string; design_version_id: string; settings_notes?: string | null; pieces_per_cycle_override?: number | null; standard_cycle_seconds_override?: string | number | null; effective_from: string; effective_to?: string | null; is_active: boolean; machine_code: string; machine_name: string; design_id: string; design_code: string; design_name: string; design_status: string; version_no: number; material_type: string; material_thickness_mm: string | number | null; unit_label: string; pieces_per_cycle: number; standard_cycle_seconds: string | number | null; version_status: string };

export default function LaserDesignsPage() {
  const { has } = usePermissions();
  const [designs, setDesigns] = useState<Design[]>([]);
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [compatibility, setCompatibility] = useState<Compatibility[]>([]);
  const [designName, setDesignName] = useState("");
  const [thumbnailUrl, setThumbnailUrl] = useState("");
  const [fileReference, setFileReference] = useState("");
  const [versionDesignId, setVersionDesignId] = useState("");
  const [versionNo, setVersionNo] = useState("1");
  const [materialType, setMaterialType] = useState("MDF");
  const [thickness, setThickness] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [unitLabel, setUnitLabel] = useState("قطعة");
  const [piecesPerCycle, setPiecesPerCycle] = useState("1");
  const [cycleSeconds, setCycleSeconds] = useState("");
  const [versionNotes, setVersionNotes] = useState("");
  const [compatMachineId, setCompatMachineId] = useState("");
  const [compatVersionId, setCompatVersionId] = useState("");
  const [compatPieces, setCompatPieces] = useState("");
  const [compatSeconds, setCompatSeconds] = useState("");
  const [compatNotes, setCompatNotes] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(localDateKey());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState("");

  async function load() {
    try {
      const [d, v, m, c] = await Promise.all([
        api<{ data: Design[] }>("/api/laser-designs"),
        api<{ data: DesignVersion[] }>("/api/laser-design-versions"),
        api<{ data: Machine[] }>("/api/machines"),
        api<{ data: Compatibility[] }>("/api/laser-machine-design-compatibility")
      ]);
      setDesigns(d.data);
      setVersions(v.data);
      setMachines(m.data);
      setCompatibility(c.data);
      if (!versionDesignId && d.data.find(x => x.status === "ACTIVE")) setVersionDesignId(d.data.find(x => x.status === "ACTIVE")!.id);
      if (!compatMachineId && m.data[0]) setCompatMachineId(m.data[0].id);
      if (!compatVersionId && v.data.find(x => x.status === "ACTIVE" && x.design_status === "ACTIVE")) {
        setCompatVersionId(v.data.find(x => x.status === "ACTIVE" && x.design_status === "ACTIVE")!.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل مكتبة تصميمات الليزر");
    }
  }

  useEffect(() => { void load(); }, []);

  async function submitDesign(e: FormEvent) {
    e.preventDefault();
    setSaving("design"); setError(""); setNotice("");
    try {
      await api("/api/laser-designs", { method: "POST", body: JSON.stringify({
        name: designName.trim(),
        thumbnailUrl: thumbnailUrl.trim() || null,
        fileReference: fileReference.trim() || null
      }) });
      setDesignName(""); setThumbnailUrl(""); setFileReference("");
      setNotice("تم إنشاء التصميم. أضف إصدارًا له لتحديد الخامة وعدد القطع في الدورة.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إنشاء التصميم"); }
    finally { setSaving(""); }
  }

  async function submitVersion(e: FormEvent) {
    e.preventDefault();
    if (!versionDesignId) { setError("اختر التصميم أولًا."); return; }
    setSaving("version"); setError(""); setNotice("");
    try {
      await api("/api/laser-designs/" + versionDesignId + "/versions", { method: "POST", body: JSON.stringify({
        versionNo: Number(versionNo), materialType: materialType.trim(),
        materialThicknessMm: thickness === "" ? null : Number(thickness),
        widthMm: width === "" ? null : Number(width), heightMm: height === "" ? null : Number(height),
        unitLabel: unitLabel.trim(), piecesPerCycle: Number(piecesPerCycle),
        standardCycleSeconds: cycleSeconds === "" ? null : Number(cycleSeconds),
        notes: versionNotes.trim() || null
      }) });
      setVersionNo(String(Number(versionNo) + 1)); setVersionNotes("");
      setNotice("تم حفظ إصدار التصميم.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إنشاء إصدار التصميم"); }
    finally { setSaving(""); }
  }

  async function submitCompatibility(e: FormEvent) {
    e.preventDefault();
    if (!compatMachineId || !compatVersionId) { setError("اختر الماكينة وإصدار التصميم."); return; }
    setSaving("compatibility"); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-design-compatibility", { method: "POST", body: JSON.stringify({
        machineId: compatMachineId, designVersionId: compatVersionId,
        settingsNotes: compatNotes.trim() || null,
        piecesPerCycleOverride: compatPieces === "" ? null : Number(compatPieces),
        standardCycleSecondsOverride: compatSeconds === "" ? null : Number(compatSeconds),
        effectiveFrom: effectiveFrom || undefined
      }) });
      setCompatPieces(""); setCompatSeconds(""); setCompatNotes("");
      setNotice("تم ربط إصدار التصميم بالماكينة.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر ربط التصميم بالماكينة"); }
    finally { setSaving(""); }
  }

  async function archiveDesign(design: Design) {
    if (!window.confirm("أرشفة التصميم " + design.code + " — " + design.name + "؟ لن يُحذف من السجلات.")) return;
    setSaving("archive:" + design.id); setError(""); setNotice("");
    try {
      await api("/api/laser-designs/" + design.id + "/archive", { method: "PATCH" });
      setNotice("تمت أرشفة التصميم مع الاحتفاظ بسجله.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذرت أرشفة التصميم"); }
    finally { setSaving(""); }
  }

  async function deactivateCompatibility(item: Compatibility) {
    if (!window.confirm("إيقاف توافق هذا التصميم مع الماكينة؟ سيظل سجل الربط محفوظًا.")) return;
    setSaving("compat:" + item.id); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-design-compatibility/" + item.id + "/deactivate", { method: "PATCH" });
      setNotice("تم إيقاف التوافق مع الاحتفاظ بالسجل التاريخي.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إيقاف التوافق"); }
    finally { setSaving(""); }
  }

  const visibleDesigns = designs.filter(x => (x.name + " " + x.code).toLowerCase().includes(search.trim().toLowerCase()));
  const activeVersions = versions.filter(x => x.status === "ACTIVE" && x.design_status === "ACTIVE");
  const formatNumber = (value: string | number | null | undefined) => value == null || value === "" ? "—" : String(value);

  return <div className="app-shell">
    <Sidebar active="/laser-designs" />
    <main className="main">
      <header className="topbar"><div><h1 className="page-title">مكتبة تصميمات الليزر</h1><p className="page-subtitle">تعريف التصميمات وإصداراتها وربط كل إصدار بالماكينات المتوافقة معه. هذه المكتبة لا تغيّر الإنتاج أو المخزون الحالي.</p></div></header>
      <section className="content">
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}

        {has("laser_designs.manage") && <form className="card form-card" onSubmit={submitDesign}>
          <div className="card-header"><h2 className="card-title">إضافة تصميم</h2></div>
          <div className="form-grid">
            <label>اسم التصميم<input value={designName} onChange={e => setDesignName(e.target.value)} required minLength={2} maxLength={160} placeholder="مثال: علبة هدايا صغيرة" /></label>
            <label>رابط صورة المعاينة (اختياري)<input type="url" value={thumbnailUrl} onChange={e => setThumbnailUrl(e.target.value)} placeholder="https://..." /></label>
            <label>مرجع ملف التصميم (اختياري)<input value={fileReference} onChange={e => setFileReference(e.target.value)} maxLength={1000} placeholder="مسار أو معرّف تخزين آمن" /></label>
          </div>
          <p className="form-hint">يولّد النظام كودًا فريدًا للتصميم. مرجع الملف لا يرفع الملف نفسه؛ رفع الملفات يُضاف بعد اعتماد آلية التخزين.</p>
          <div className="form-actions"><button className="primary-button" disabled={saving !== ""}>{saving === "design" ? "جارٍ الحفظ..." : "حفظ التصميم"}</button></div>
        </form>}

        {has("laser_designs.manage") && <form className="card form-card" onSubmit={submitVersion}>
          <div className="card-header"><h2 className="card-title">إضافة إصدار ومواصفات الإنتاج</h2></div>
          <div className="form-grid">
            <label>التصميم<select value={versionDesignId} onChange={e => setVersionDesignId(e.target.value)} required><option value="">اختر التصميم</option>{designs.filter(x => x.status === "ACTIVE").map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
            <label>رقم الإصدار<input type="number" min="1" step="1" value={versionNo} onChange={e => setVersionNo(e.target.value)} required /></label>
            <label>نوع الخامة<input value={materialType} onChange={e => setMaterialType(e.target.value)} required placeholder="MDF / أكريليك" /></label>
            <label>سُمك الخامة (مم)<input type="number" min="0" step="0.001" value={thickness} onChange={e => setThickness(e.target.value)} /></label>
            <label>العرض (مم)<input type="number" min="0.001" step="0.001" value={width} onChange={e => setWidth(e.target.value)} /></label>
            <label>الارتفاع (مم)<input type="number" min="0.001" step="0.001" value={height} onChange={e => setHeight(e.target.value)} /></label>
            <label>وحدة الإنتاج<input value={unitLabel} onChange={e => setUnitLabel(e.target.value)} required /></label>
            <label>القطع الناتجة في الدورة<input type="number" min="1" step="1" value={piecesPerCycle} onChange={e => setPiecesPerCycle(e.target.value)} required /></label>
            <label>زمن الدورة القياسي (ثانية)<input type="number" min="0.001" step="0.01" value={cycleSeconds} onChange={e => setCycleSeconds(e.target.value)} /></label>
            <label style={{ gridColumn: "1 / -1" }}>ملاحظات التشغيل<input value={versionNotes} onChange={e => setVersionNotes(e.target.value)} maxLength={2000} /></label>
          </div>
          <p className="form-hint">لا تعدّل مواصفات إصدار قديم لتغيير معنى سجلاته؛ أنشئ رقم إصدار جديد عند تغيّر التصميم أو طريقة الإنتاج.</p>
          <div className="form-actions"><button className="primary-button" disabled={saving !== "" || !versionDesignId}>{saving === "version" ? "جارٍ الحفظ..." : "حفظ الإصدار"}</button></div>
        </form>}

        {has("laser_designs.compatibility.manage") && <form className="card form-card" onSubmit={submitCompatibility}>
          <div className="card-header"><h2 className="card-title">ربط إصدار بماكينة</h2></div>
          <div className="form-grid">
            <label>الماكينة<select value={compatMachineId} onChange={e => setCompatMachineId(e.target.value)} required><option value="">اختر الماكينة</option>{machines.map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
            <label>إصدار التصميم<select value={compatVersionId} onChange={e => setCompatVersionId(e.target.value)} required><option value="">اختر الإصدار</option>{activeVersions.map(x => <option key={x.id} value={x.id}>{x.design_code} — {x.design_name} · V{x.version_no} · {x.material_type}</option>)}</select></label>
            <label>تاريخ بداية التوافق<input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} required /></label>
            <label>القطع في الدورة لهذه الماكينة (اختياري)<input type="number" min="1" step="1" value={compatPieces} onChange={e => setCompatPieces(e.target.value)} /></label>
            <label>زمن الدورة على الماكينة (ثانية، اختياري)<input type="number" min="0.001" step="0.01" value={compatSeconds} onChange={e => setCompatSeconds(e.target.value)} /></label>
            <label style={{ gridColumn: "1 / -1" }}>إعدادات أو ملاحظات خاصة بالماكينة<input value={compatNotes} onChange={e => setCompatNotes(e.target.value)} maxLength={2000} /></label>
          </div>
          <div className="form-actions"><button className="primary-button" disabled={saving !== "" || !compatMachineId || !compatVersionId}>{saving === "compatibility" ? "جارٍ الحفظ..." : "حفظ التوافق"}</button></div>
        </form>}

        <section className="card">
          <div className="card-header"><div><h2 className="card-title">التصميمات المسجلة</h2><p className="form-hint">إجمالي التصميمات: {designs.length} · الإصدارات: {versions.length}</p></div></div>
          <div className="form-grid"><label>بحث بالكود أو الاسم<input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث عن تصميم..." /></label></div>
          <div className="table-wrap"><table><thead><tr><th>الكود</th><th>التصميم</th><th>الإصدارات</th><th>آخر إصدار</th><th>الحالة</th><th>المعاينة</th><th>الإجراء</th></tr></thead><tbody>
            {visibleDesigns.map(x => <tr key={x.id}><td>{x.code}</td><td>{x.name}</td><td>{x.version_count}</td><td>{x.latest_version_no ? "V" + x.latest_version_no : "—"}</td><td>{x.status === "ACTIVE" ? "نشط" : "مؤرشف"}</td><td>{x.thumbnail_url ? <a href={x.thumbnail_url} target="_blank" rel="noreferrer">فتح المعاينة</a> : "—"}</td><td>{x.status === "ACTIVE" && has("laser_designs.manage") ? <button type="button" className="danger-button" disabled={saving !== ""} onClick={() => void archiveDesign(x)}>{saving === "archive:" + x.id ? "جارٍ الأرشفة..." : "أرشفة"}</button> : "—"}</td></tr>)}
            {!visibleDesigns.length && <tr><td colSpan={7}>لا توجد تصميمات مطابقة للبحث.</td></tr>}
          </tbody></table></div>
        </section>

        <section className="card">
          <div className="card-header"><h2 className="card-title">إصدارات التصميمات</h2></div>
          <div className="table-wrap"><table><thead><tr><th>الكود / التصميم</th><th>الإصدار</th><th>الخامة</th><th>السُمك (مم)</th><th>المقاس (مم)</th><th>القطع / دورة</th><th>الوحدة</th><th>الحالة</th></tr></thead><tbody>
            {versions.map(x => <tr key={x.id}><td>{x.design_code} — {x.design_name}</td><td>V{x.version_no}</td><td>{x.material_type}</td><td>{formatNumber(x.material_thickness_mm)}</td><td>{x.width_mm && x.height_mm ? x.width_mm + " × " + x.height_mm : "—"}</td><td>{x.pieces_per_cycle}</td><td>{x.unit_label}</td><td>{x.status === "ACTIVE" ? "نشط" : "مؤرشف"}</td></tr>)}
            {!versions.length && <tr><td colSpan={8}>لم تُضف إصدارات بعد.</td></tr>}
          </tbody></table></div>
        </section>

        <section className="card">
          <div className="card-header"><h2 className="card-title">توافق الماكينات والتصميمات</h2></div>
          <div className="table-wrap"><table><thead><tr><th>الماكينة</th><th>التصميم / الإصدار</th><th>الخامة</th><th>القطع / دورة</th><th>زمن الدورة (ث)</th><th>بداية التوافق</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>
            {compatibility.map(x => <tr key={x.id}><td>{x.machine_name} ({x.machine_code})</td><td>{x.design_code} — {x.design_name} · V{x.version_no}</td><td>{x.material_type}{x.material_thickness_mm == null ? "" : " · " + x.material_thickness_mm + " مم"}</td><td>{x.pieces_per_cycle_override ?? x.pieces_per_cycle}</td><td>{formatNumber(x.standard_cycle_seconds_override ?? x.standard_cycle_seconds)}</td><td>{String(x.effective_from).slice(0,10)}</td><td>{x.is_active ? "نشط" : "متوقف"}</td><td>{x.is_active && has("laser_designs.compatibility.manage") ? <button type="button" className="danger-button" disabled={saving !== ""} onClick={() => void deactivateCompatibility(x)}>{saving === "compat:" + x.id ? "جارٍ الإيقاف..." : "إيقاف التوافق"}</button> : "—"}</td></tr>)}
            {!compatibility.length && <tr><td colSpan={8}>لا توجد روابط توافق حتى الآن.</td></tr>}
          </tbody></table></div>
        </section>
      </section>
    </main>
  </div>;
}
