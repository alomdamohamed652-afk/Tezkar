"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { SearchableSelect } from "../../components/searchable-select";

type Item={id:string;code:string;name:string;status?:string};
type Order=Item&{order_name:string;status?:string};
type Stage={id:string;order_id:string;order_code:string;order_name:string;stage_name:string;stage_id:string;sequence_no:number;output_product_name:string|null;status?:string};
type Machine=Item&{machine_type?:string|null;is_active?:boolean};
type Version={id:string;design_id:string;version_no:number;design_code:string;design_name:string;material_type:string;material_thickness_mm:number|string|null;unit_label:string;pieces_per_cycle:number;status:string;design_status:string};
type Assignment={id:string;order_stage_id:string;machine_id:string;design_version_id:string;planned_quantity:number|string|null;notes:string|null;is_active:boolean;order_id:string;order_code:string;order_name:string;stage_name:string;sequence_no:number;machine_code:string;machine_name:string;design_code:string;design_name:string;version_no:number;material_type:string;material_thickness_mm:number|string|null;unit_label:string;pieces_per_cycle:number};

export default function OrderDesignPlanPage(){
 const {has}=usePermissions();
 const [orders,setOrders]=useState<Order[]>([]);
 const [stages,setStages]=useState<Stage[]>([]);
 const [machines,setMachines]=useState<Machine[]>([]);
 const [versions,setVersions]=useState<Version[]>([]);
 const [assignments,setAssignments]=useState<Assignment[]>([]);
 const [orderId,setOrderId]=useState("");
 const [stageId,setStageId]=useState("");
 const [machineId,setMachineId]=useState("");
 const [versionId,setVersionId]=useState("");
 const [plannedQuantity,setPlannedQuantity]=useState("");
 const [notes,setNotes]=useState("");
 const [loading,setLoading]=useState(true);
 const [saving,setSaving]=useState(false);
 const [busyId,setBusyId]=useState("");
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const canManage=has("laser_designs.order_plan.manage");
 const orderOptions=useMemo(()=>orders.filter(x=>!["CANCELLED","COMPLETED"].includes((x.status||"").toUpperCase())).map(x=>({value:x.id,label:x.order_name||x.name,meta:x.code})),[orders]);
 const stageOptions=useMemo(()=>stages.filter(x=>x.order_id===orderId&&x.status!=="CANCELLED").sort((a,b)=>a.sequence_no-b.sequence_no).map(x=>({value:x.id,label:x.stage_name,meta:x.output_product_name||"لا يوجد منتج ناتج مربوط"})),[stages,orderId]);
 const machineOptions=useMemo(()=>machines.filter(x=>x.is_active!==false).map(x=>({value:x.id,label:x.name,meta:x.code})),[machines]);
 const versionOptions=useMemo(()=>versions.filter(x=>x.status==="ACTIVE"&&x.design_status==="ACTIVE").map(x=>({value:x.id,label:x.design_code+" — "+x.design_name+" · V"+x.version_no,meta:x.material_type+(x.material_thickness_mm==null?"":" · "+x.material_thickness_mm+" مم")+" · "+x.pieces_per_cycle+" قطعة/دورة"})),[versions]);
 const visibleAssignments=useMemo(()=>assignments.filter(x=>!orderId||x.order_id===orderId),[assignments,orderId]);

 async function load(){
  setLoading(true);setError("");
  try{
   const [o,s,m,v,a]=await Promise.all([
    api<{data:Order[]}>("/api/orders"),
    api<{data:Stage[]}>("/api/order-stages"),
    api<{data:Machine[]}>("/api/machines"),
    api<{data:Version[]}>("/api/laser-design-versions"),
    api<{data:Assignment[]}>("/api/laser-order-stage-designs")
   ]);
   setOrders(o.data);setStages(s.data);setMachines(m.data);setVersions(v.data);setAssignments(a.data);
   if(!orderId){const first=o.data.find(x=>!["CANCELLED","COMPLETED"].includes((x.status||"").toUpperCase()));if(first)setOrderId(first.id)}
   if(!machineId&&m.data[0])setMachineId(m.data[0].id);
   if(!versionId){const first=v.data.find(x=>x.status==="ACTIVE"&&x.design_status==="ACTIVE");if(first)setVersionId(first.id)}
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل خطة تصميمات الطلبيات")}
  finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[]);

 async function create(e:FormEvent){
  e.preventDefault();setError("");setNotice("");
  if(!stageId||!machineId||!versionId){setError("اختار المرحلة والماكينة وإصدار التصميم.");return}
  setSaving(true);
  try{
   await api("/api/laser-order-stage-designs",{method:"POST",body:JSON.stringify({orderStageId:stageId,machineId,designVersionId:versionId,plannedQuantity:plannedQuantity.trim()?Number(plannedQuantity):null,notes:notes.trim()||null})});
   setPlannedQuantity("");setNotes("");setNotice("تم ربط التصميم بالمرحلة والماكينة.");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ ربط التصميم")}
  finally{setSaving(false)}
 }
 async function deactivate(item:Assignment){
  if(!canManage||!item.is_active)return;
  setBusyId(item.id);setError("");setNotice("");
  try{await api("/api/laser-order-stage-designs/"+item.id+"/deactivate",{method:"PATCH"});setNotice("تم إيقاف الربط. سجل الإنتاج القديم لم يتغير.");await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر إيقاف الربط")}
  finally{setBusyId("")}
 }

 return <div className="app-shell"><Sidebar active="/order-design-plan"/><main className="main-content">
  <header className="page-header"><div><p className="eyebrow">تذكار · تخطيط الإنتاج</p><h1>خطة تصميمات الطلبيات</h1><p className="page-description">حدد كل تصميم مطلوب لكل مرحلة، وعلى أي ماكينة سيتم تشغيله. الخطة توجه شاشة إنتاج الماكينات بدل البحث اليدوي كل مرة.</p></div><button className="secondary-btn" type="button" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></header>
  {error&&<div className="alert alert-error" role="alert">{error}</div>}{notice&&<div className="alert alert-success" role="status">{notice}</div>}
  <section className="card"><div className="card-header"><div><h2 className="card-title">إضافة تصميم لخطة مرحلة</h2><p className="form-hint">لازم يكون التصميم مربوطًا بالماكينة من مكتبة تصميمات الليزر أولًا.</p></div></div>
   {canManage?<form onSubmit={create}><div className="form-grid">
    <label>الطلبية<SearchableSelect value={orderId} onChange={v=>{setOrderId(v);setStageId("")}} options={orderOptions} placeholder="اختار الطلبية"/></label>
    <label>المرحلة<SearchableSelect value={stageId} onChange={setStageId} options={stageOptions} placeholder={orderId?"اختار مرحلة الطلبية":"اختار الطلبية أولًا"}/></label>
    <label>الماكينة<SearchableSelect value={machineId} onChange={setMachineId} options={machineOptions} placeholder="اختار الماكينة"/></label>
    <label>التصميم والإصدار<SearchableSelect value={versionId} onChange={setVersionId} options={versionOptions} placeholder="اختار التصميم والإصدار"/></label>
    <label>الكمية المخططة (اختياري)<input type="number" min="0.001" step="0.001" value={plannedQuantity} onChange={e=>setPlannedQuantity(e.target.value)} placeholder="مثال: 500"/></label>
    <label>ملاحظات التشغيل<input value={notes} onChange={e=>setNotes(e.target.value)} maxLength={2000} placeholder="الخامة، إعدادات، ترتيب تشغيل..." /></label>
   </div><div className="form-actions"><button className="primary-button" disabled={saving||loading}>{saving?"جارٍ الحفظ...":"إضافة للخطة"}</button></div></form>:<p className="form-hint">حسابك لديه صلاحية عرض الخطة فقط. اطلب صلاحية إدارة خطة تصميمات الطلبيات لإضافة أو إيقاف ربط.</p>}
  </section>
  <section className="card"><div className="card-header"><div><h2 className="card-title">التصميمات المرتبطة بالطلبية</h2><p className="form-hint">تقدر تربط أكثر من تصميم بنفس المرحلة، وتحدد ماكينة وكمية لكل تصميم.</p></div><span className="status-pill">{visibleAssignments.filter(x=>x.is_active).length} ربط نشط</span></div>
   {loading?<p className="empty-state">جارٍ تحميل الخطة...</p>:visibleAssignments.length===0?<p className="empty-state">لا توجد تصميمات مرتبطة بهذه الطلبية حتى الآن. أضف أول ربط من النموذج بالأعلى.</p>:
   <div className="table-wrap"><table><thead><tr><th>الطلبية</th><th>المرحلة</th><th>الماكينة</th><th>التصميم</th><th>الخامة</th><th>الكمية المخططة</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
    {visibleAssignments.map(x=><tr key={x.id}><td>{x.order_name}<small className="table-subtitle">{x.order_code}</small></td><td>{x.stage_name}</td><td>{x.machine_name}<small className="table-subtitle">{x.machine_code}</small></td><td>{x.design_name} <small className="table-subtitle">{x.design_code} · V{x.version_no}</small></td><td>{x.material_type}{x.material_thickness_mm==null?"":" · "+x.material_thickness_mm+" مم"}</td><td>{x.planned_quantity==null?"—":Number(x.planned_quantity).toLocaleString("en-US")}</td><td><span className={"status-pill "+(x.is_active?"status-success":"status-muted")}>{x.is_active?"نشط":"متوقف"}</span></td><td>{x.is_active&&canManage?<button type="button" className="danger-button" disabled={busyId===x.id} onClick={()=>void deactivate(x)}>{busyId===x.id?"جارٍ الإيقاف...":"إيقاف الربط"}</button>: "—"}</td></tr>)}
   </tbody></table></div>}
  </section>
 </main></div>
}
