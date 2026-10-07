"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Location=Item&{warehouse_id:string};
type Warehouse=Item&{warehouse_type:string};
type Receipt={id:string;code:string;receipt_date:string;source:string;line_count:number;total_cost:number;created_at:string};
type Line={productId:string;warehouseId:string;locationId:string;quantity:string;unitCost:string;batchCode:string;weight:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");

export default function ReceiptsPage(){
 const {has}=usePermissions();
 const [products,setProducts]=useState<Item[]>([]),[warehouses,setWarehouses]=useState<Warehouse[]>([]),[locations,setLocations]=useState<Location[]>([]),[receipts,setReceipts]=useState<Receipt[]>([]);
 const [receiptDate,setReceiptDate]=useState(new Date().toISOString().slice(0,10)),[source,setSource]=useState(""),[notes,setNotes]=useState(""),[lines,setLines]=useState<Line[]>([{productId:"",warehouseId:"",locationId:"",quantity:"",unitCost:"",batchCode:"",weight:""}]),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){try{const [p,w,l,r]=await Promise.all([api<{data:Item[]}>("/api/products"),api<{data:Warehouse[]}>("/api/warehouses"),api<{data:Location[]}>("/api/warehouse/locations"),api<{data:Receipt[]}>("/api/warehouse/receipts")]);setProducts(p.data);setWarehouses(w.data);setLocations(l.data);setReceipts(r.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الاستلامات")}}
 useEffect(()=>{void load()},[]);
 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name})),[products]);
 const warehouseOptions=useMemo(()=>warehouses.map(x=>({value:x.id,label:x.name,meta:x.warehouse_type})),[warehouses]);
 function update(i:number,key:keyof Line,value:string){setLines(v=>v.map((x,n)=>n===i?{...x,[key]:value}:x))}
 function addLine(){setLines(v=>[...v,{productId:"",warehouseId:"",locationId:"",quantity:"",unitCost:"",batchCode:"",weight:""}])}
 function removeLine(i:number){setLines(v=>v.filter((_,n)=>n!==i))}
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{
  await api("/api/warehouse/receipts",{method:"POST",body:JSON.stringify({receiptDate,source,notes:notes||undefined,lines:lines.map(x=>({productId:x.productId,warehouseId:x.warehouseId,locationId:x.locationId,quantity:Number(normalizeNumber(x.quantity)),unitCost:Number(normalizeNumber(x.unitCost||"0")),batchCode:x.batchCode||undefined,weight:x.weight?Number(normalizeNumber(x.weight)):undefined}))})});
  setSource("");setNotes("");setLines([{productId:"",warehouseId:"",locationId:"",quantity:"",unitCost:"",batchCode:"",weight:""}]);await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الاستلام")}finally{setSaving(false)}}
 return <div className="app-shell"><Sidebar active="/receipts"/><main className="main"><header className="topbar"><div><h1 className="page-title">الاستلامات</h1><p className="page-subtitle">استلام قماش ومنتجات وخامات ومستلزمات وتسجيلها على المخزن بتكلفتها وسجل حركة مستقل.</p></div></header><section className="content">{error&&<div className="alert error">{error}</div>}
 {has("warehouse.move")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل استلام جديد</h2><div className="form-hint">كل استلام له رقم REC، ويمكن أن يحتوي على أكثر من صنف.</div></div></div>
  <div className="form-grid"><label>تاريخ الاستلام<input type="date" value={receiptDate} onChange={e=>setReceiptDate(e.target.value)} required/></label><label>المصدر / المورد<input value={source} onChange={e=>setSource(e.target.value)} placeholder="مثال: مورد القماش" required/></label><label style={{gridColumn:"1/-1"}}>ملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)}/></label></div>
  <div className="card-body"><div className="section-title"><strong>الأصناف المستلمة</strong><button type="button" className="secondary-btn" onClick={addLine}>+ إضافة صنف</button></div>
   <div className="stage-editor-list">{lines.map((x,i)=>{const loc=locations.filter(l=>l.warehouse_id===x.warehouseId);return <div className="stage-editor-row" key={i}>
    <div><span className="field-caption">الصنف</span><SearchableSelect value={x.productId} onChange={v=>update(i,"productId",v)} options={productOptions} placeholder="اختر الصنف"/></div>
    <div><span className="field-caption">المخزن</span><SearchableSelect value={x.warehouseId} onChange={v=>{update(i,"warehouseId",v);update(i,"locationId","")}} options={warehouseOptions} placeholder="اختر المخزن"/></div>
    <div><span className="field-caption">المكان</span><SearchableSelect value={x.locationId} onChange={v=>update(i,"locationId",v)} options={loc.map(l=>({value:l.id,label:l.name}))} placeholder="اختر المكان"/></div>
    <div><span className="field-caption">الكمية</span><input inputMode="decimal" value={x.quantity} onChange={e=>update(i,"quantity",e.target.value)} required/></div>
    <div><span className="field-caption">تكلفة الوحدة</span><input inputMode="decimal" value={x.unitCost} onChange={e=>update(i,"unitCost",e.target.value)} required/></div>
    <div><span className="field-caption">الباتش / التشغيلة</span><input value={x.batchCode} onChange={e=>update(i,"batchCode",e.target.value)}/></div>
    <button type="button" className="danger-button" onClick={()=>removeLine(i)} disabled={lines.length===1}>حذف</button>
   </div>})}</div>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الحفظ...":"تسجيل الاستلام"}</button></div>
 </form>}
 <section className="card"><div className="card-header"><h2 className="card-title">سجل الاستلامات</h2><span className="count-badge">{receipts.length}</span></div><div className="table-wrap"><table><thead><tr><th>رقم الاستلام</th><th>التاريخ</th><th>المصدر</th><th>الأصناف</th><th>التكلفة</th></tr></thead><tbody>{receipts.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.receipt_date}</td><td className="strong">{x.source}</td><td>{x.line_count}</td><td className="money">{Number(x.total_cost||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td></tr>)}{!receipts.length&&<tr><td colSpan={5}>لا توجد استلامات.</td></tr>}</tbody></table></div></section>
 </section></main></div>
}
