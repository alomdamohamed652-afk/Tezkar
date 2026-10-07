"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { Code128Barcode } from "../../components/code128-barcode";

type Packaging={id:string;code:string;name:string;default_width_mm:number;default_height_mm:number};
type Template={id:string;name:string;packaging_type_id:string|null;width_mm:number;height_mm:number;orientation:string};
type Item={id:string;code:string;name:string};
type Unit={id:string;code:string;barcode:string;packaging_type_id:string;template_id:string|null;packaging_type_name:string;product_id:string;product_name:string;product_code:string;production_order_id:string|null;batch_code:string|null;quantity:number;unit_id:string|null;weight:number|null;production_owner_employee_id:string|null;production_owner_name:string|null;packed_by_employee_id:string|null;packed_by_name:string|null;received_by_employee_id:string|null;received_by_name:string|null;packed_at:string|null;coded_at:string;warehouse_name:string|null;location_name:string|null;status:string};
const statusLabels:Record<string,string>={CODED:"مُكوّدة",IN_STOCK:"بالمخزن",RESERVED:"محجوزة",READY_FOR_DELIVERY:"جاهزة للتسليم",DELIVERED:"تم التسليم",OUT:"خارجة",CANCELLED:"ملغاة"};

export default function CodingPage(){
 const {has}=usePermissions();
 const [types,setTypes]=useState<Packaging[]>([]),[templates,setTemplates]=useState<Template[]>([]),[employees,setEmployees]=useState<Item[]>([]),[products,setProducts]=useState<Item[]>([]),[units,setUnits]=useState<Unit[]>([]);
 const [typeId,setTypeId]=useState(""),[templateId,setTemplateId]=useState(""),[productId,setProductId]=useState(""),[batch,setBatch]=useState(""),[quantity,setQuantity]=useState(""),[weight,setWeight]=useState("");
 const [productionOwner,setProductionOwner]=useState(""),[packedBy,setPackedBy]=useState(""),[receivedBy,setReceivedBy]=useState(""),[packedAt,setPackedAt]=useState("");
 const [search,setSearch]=useState(""),[selected,setSelected]=useState<Unit|null>(null),[error,setError]=useState(""),[saving,setSaving]=useState(false),[printUnit,setPrintUnit]=useState<Unit|null>(null);

 async function load(){
  try{
   const [t,tm,e,p,u]=await Promise.all([api<{data:Packaging[]}>("/api/coding/packaging-types"),api<{data:Template[]}>("/api/coding/templates"),api<{data:Item[]}>("/api/coding/employees"),api<{data:Item[]}>("/api/products"),api<{data:Unit[]}>("/api/coding/units")]);
   setTypes(t.data);setTemplates(tm.data);setEmployees(e.data);setProducts(p.data);setUnits(u.data);
   if(!typeId&&t.data[0])setTypeId(t.data[0].id);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل نظام التكويد")}
 }
 useEffect(()=>{void load()},[]);

 const selectedType=types.find(x=>x.id===typeId);
 const availableTemplates=templates.filter(x=>x.packaging_type_id===typeId||!x.packaging_type_id);
 const filtered=useMemo(()=>units.filter(x=>[x.code,x.product_name,x.product_code,x.batch_code||"",x.packaging_type_name].join(" ").toLowerCase().includes(search.trim().toLowerCase())),[units,search]);
 useEffect(()=>{const t=availableTemplates.find(x=>x.packaging_type_id===typeId)||availableTemplates[0];setTemplateId(t?.id??"")},[typeId,templates.length]);

 async function create(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   const result=await api<{data:Unit}>("/api/coding/units",{method:"POST",body:JSON.stringify({packagingTypeId:typeId,templateId:templateId||null,productId,productionOrderId:null,batchCode:batch.trim()||null,quantity:Number(quantity),unitId:null,weight:weight?Number(weight):null,productionOwnerEmployeeId:productionOwner||null,packedByEmployeeId:packedBy||null,receivedByEmployeeId:receivedBy||null,packedAt:packedAt?new Date(packedAt).toISOString():null})});
   setPrintUnit(result.data);setUnits(prev=>[result.data,...prev]);setQuantity("");setWeight("");setBatch("");setProductionOwner("");setPackedBy("");setReceivedBy("");setPackedAt("");
   setTimeout(()=>window.print(),100);
  }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء التكويد")}finally{setSaving(false)}
 }
 async function reprint(unit:Unit){
  try{await api("/api/coding/units/"+unit.id+"/print",{method:"POST"});setPrintUnit(unit);setTimeout(()=>window.print(),100)}
  catch(e){setError(e instanceof Error?e.message:"تعذر إعادة الطباعة")}
 }
 async function cancel(unit:Unit){
  const reason=window.prompt("سبب إلغاء التكويد؟");if(!reason)return;
  try{await api("/api/coding/units/"+unit.id+"/cancel",{method:"POST",body:JSON.stringify({reason})});await load();setSelected(null)}
  catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء التكويد")}
 }
 const printTemplate=printUnit?templates.find(x=>x.id===printUnit.template_id):undefined;
 const printWidth=printTemplate?.width_mm??selectedType?.default_width_mm??80;
 const printHeight=printTemplate?.height_mm??selectedType?.default_height_mm??50;

 return <div className="app-shell"><Sidebar active="/coding"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">نظام التكويد</h1><p className="page-subtitle">تعريف وتتبع كل كرتونة أو كيس أو شيكارة بكود فريد وبطاقة مطبوعة مرنة المقاس.</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   {has("cartons.manage")&&<form className="card form-card" onSubmit={create}>
    <div className="card-header"><div><h2 className="card-title">إنشاء تكويد جديد</h2><div className="form-hint">المقاس يتحدد حسب نوع العبوة والقالب، ويمكن تغييره من إعدادات القوالب.</div></div></div>
    <div className="form-grid coding-form-grid">
     <label>نوع العبوة<select value={typeId} onChange={e=>setTypeId(e.target.value)} required><option value="">اختر النوع</option>{types.map(x=><option key={x.id} value={x.id}>{x.name} — {x.default_width_mm} × {x.default_height_mm} مم</option>)}</select></label>
     <label>قالب الطباعة<select value={templateId} onChange={e=>setTemplateId(e.target.value)} required><option value="">اختر القالب</option>{availableTemplates.map(x=><option key={x.id} value={x.id}>{x.name} — {x.width_mm} × {x.height_mm} مم</option>)}</select></label>
     <label>المنتج<select value={productId} onChange={e=>setProductId(e.target.value)} required><option value="">اختر المنتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
     <label>التشغيل <span className="optional">اختياري</span><input value={batch} onChange={e=>setBatch(e.target.value)} placeholder="رقم / كود التشغيل"/></label>
     <label>الكمية<input type="number" min="0.001" step="0.001" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
     <label>الوزن <span className="optional">اختياري</span><input type="number" min="0" step="0.001" value={weight} onChange={e=>setWeight(e.target.value)}/></label>
     <label>صاحب الإنتاج<select value={productionOwner} onChange={e=>setProductionOwner(e.target.value)}><option value="">اختياري</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
     <label>قام بالتقفيل<select value={packedBy} onChange={e=>setPackedBy(e.target.value)}><option value="">اختياري</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
     <label>المستلم<select value={receivedBy} onChange={e=>setReceivedBy(e.target.value)}><option value="">اختياري</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
     <label>وقت التقفيل <span className="optional">اختياري</span><input type="datetime-local" value={packedAt} onChange={e=>setPackedAt(e.target.value)}/></label>
    </div>
    <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ إنشاء الكود...":"إنشاء التكويد وطباعة الكارت"}</button><span className="form-hint">{selectedType?"المقاس الحالي: "+selectedType.default_width_mm+" × "+selectedType.default_height_mm+" مم":"اختر نوع العبوة"}</span></div>
   </form>}
   <section className="card">
    <div className="card-header"><div><h2 className="card-title">سجل التكويدات</h2><div className="form-hint">ابحث بالكود أو المنتج أو التشغيل. الـBarcode يحتوي الكود فقط.</div></div><span className="count-badge">{filtered.length}</span></div>
    <div className="card-body coding-toolbar"><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ابحث بالكود أو المنتج أو التشغيل..."/></div>
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>العبوة</th><th>المنتج</th><th>الكمية</th><th>الوزن</th><th>التقفيل</th><th>الحالة</th><th>التكويد</th><th>إجراءات</th></tr></thead>
     <tbody>{filtered.map(x=><tr key={x.id}><td className="mono strong">{x.code}</td><td>{x.packaging_type_name}</td><td className="strong">{x.product_name}<div className="form-hint">{x.product_code}</div></td><td>{x.quantity}</td><td>{x.weight??"—"}</td><td>{x.packed_by_name||"—"}</td><td><span className={"status "+x.status.toLowerCase()}>{statusLabels[x.status]||x.status}</span></td><td>{new Date(x.coded_at).toLocaleString("ar-EG")}</td><td><div className="row-actions"><button className="secondary-btn" onClick={()=>setSelected(x)}>تفاصيل</button><button className="approve-button" onClick={()=>reprint(x)}>إعادة طباعة</button>{x.status!=="CANCELLED"&&x.status!=="OUT"&&<button className="danger-button" onClick={()=>cancel(x)}>إلغاء</button>}</div></td></tr>)}{!filtered.length&&<tr><td colSpan={9}>لا توجد تكويدات مطابقة.</td></tr>}</tbody>
    </table></div>
   </section>
   {selected&&<div className="modal-backdrop" onClick={()=>setSelected(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">{selected.code}</h2><div className="form-hint">{selected.packaging_type_name} — {statusLabels[selected.status]||selected.status}</div></div><button className="secondary-btn" onClick={()=>setSelected(null)}>إغلاق</button></div>
    <div className="detail-grid"><div><b>المنتج</b><span>{selected.product_name}</span></div><div><b>التشغيل</b><span>{selected.batch_code||"—"}</span></div><div><b>الكمية</b><span>{selected.quantity}</span></div><div><b>الوزن</b><span>{selected.weight??"—"}</span></div><div><b>صاحب الإنتاج</b><span>{selected.production_owner_name||"—"}</span></div><div><b>قام بالتقفيل</b><span>{selected.packed_by_name||"—"}</span></div><div><b>المستلم</b><span>{selected.received_by_name||"—"}</span></div><div><b>وقت التقفيل</b><span>{selected.packed_at?new Date(selected.packed_at).toLocaleString("ar-EG"):"—"}</span></div><div><b>وقت التكويد</b><span>{new Date(selected.coded_at).toLocaleString("ar-EG")}</span></div><div><b>المخزن</b><span>{selected.warehouse_name||"—"}</span></div><div><b>المكان</b><span>{selected.location_name||"—"}</span></div><div><b>Barcode</b><span className="mono">{selected.barcode}</span></div></div>
    <div className="modal-actions"><button className="primary-button" onClick={()=>reprint(selected)}>طباعة البطاقة</button></div>
   </div></div>}
   {printUnit&&<div className="coding-print-sheet" style={{"--print-width":printWidth+"mm","--print-height":printHeight+"mm"} as React.CSSProperties}><div className="coding-print-inner">
    <div className="coding-print-head"><img src="/tezkar-mark.svg" alt="تذكار"/><div><strong>تذكار</strong><small>إدارة وتشغيل المصنع</small></div></div>
    <div className="coding-print-title">بطاقة تعريف الإنتاج</div>
    <div className="coding-print-data"><span>المنتج: <b>{printUnit.product_name}</b></span><span>التشغيل: <b>{printUnit.batch_code||"—"}</b></span><span>الكمية: <b>{printUnit.quantity}</b></span><span>الوزن: <b>{printUnit.weight??"—"}</b></span></div>
    <div className="coding-print-code">{printUnit.code}</div><Code128Barcode value={printUnit.code} height={Math.max(34,Math.min(52,printHeight*0.9))}/>
    <div className="coding-print-meta"><span>التقفيل: {printUnit.packed_at?new Date(printUnit.packed_at).toLocaleDateString("ar-EG"):"—"}</span><span>التكويد: {new Date(printUnit.coded_at).toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"})}</span></div>
    <div className="coding-print-address">عنوان الشركة</div>
   </div></div>}
  </section>
 </main></div>;
}
