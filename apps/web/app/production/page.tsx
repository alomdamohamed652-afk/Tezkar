"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { SearchableSelect } from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Employee={id:string;code:string;full_name:string};
type Shift=Item & {rate_group_name:string};
type Destination={id:string;code:string;name:string;warehouse_id:string;warehouse_code:string;warehouse_name:string};
type OrderStage={id:string;order_id:string;order_code:string;order_name:string;stage_id:string;stage_name:string;output_product_id:string|null;output_product_name:string|null;sequence_no:number};
type ProductionType=Item & {calculation_method:string};
type Entry={id:string;code:string;work_date:string;quantity:number;rate_snapshot:number;earning_amount:number;status:string;employee_name:string;product_name:string;stage_name:string;production_type_name:string|null;shift_name:string;unit_name:string};

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};

export default function ProductionPage(){
 const {has}=usePermissions();
 const [employees,setEmployees]=useState<Employee[]>([]),[products,setProducts]=useState<Item[]>([]),[stages,setStages]=useState<Item[]>([]),[shifts,setShifts]=useState<Shift[]>([]),[destinations,setDestinations]=useState<Destination[]>([]),[orderStages,setOrderStages]=useState<OrderStage[]>([]),[productionTypes,setProductionTypes]=useState<ProductionType[]>([]),[entries,setEntries]=useState<Entry[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[orderStageId,setOrderStageId]=useState(""),[productId,setProductId]=useState(""),[stageId,setStageId]=useState(""),[productionTypeId,setProductionTypeId]=useState(""),[shiftId,setShiftId]=useState(""),[workDate,setWorkDate]=useState(new Date().toISOString().slice(0,10)),[quantity,setQuantity]=useState(""),[baseAmount,setBaseAmount]=useState(""),[hoursWorked,setHoursWorked]=useState(""),[warehouseId,setWarehouseId]=useState(""),[locationId,setLocationId]=useState(""),[status,setStatus]=useState("");
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(""),[resolvedMethod,setResolvedMethod]=useState(""),[resolvedRate,setResolvedRate]=useState<number|null>(null),[rateOverride,setRateOverride]=useState(""),[editTarget,setEditTarget]=useState<Entry|null>(null),[editQuantity,setEditQuantity]=useState(""),[reviewTarget,setReviewTarget]=useState(""),[reviewReason,setReviewReason]=useState("");

 async function load(){
  setLoading(true);setError("");
  try{
   const [e,p,s,h,d,os,pt,r]=await Promise.all([
    api<{data:Employee[]}>("/api/employees"),api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/stages"),api<{data:Shift[]}>("/api/shifts"),
    api<{data:Destination[]}>("/api/production/destinations"),api<{data:OrderStage[]}>("/api/order-stages"),api<{data:ProductionType[]}>("/api/production-types"),
    api<{data:Entry[]}>(status?"/api/production?status="+status:"/api/production")
   ]);
   setEmployees(e.data);setProducts(p.data);setStages(s.data);setShifts(h.data);setDestinations(d.data);setOrderStages(os.data);setProductionTypes(pt.data);setEntries(r.data);
   const pref=await api<{data:Record<string,string>}>("/api/account/preferences/production").catch(()=>({data:{}}));
   setEmployeeId((pref.data as any).employeeId||"");setShiftId((pref.data as any).shiftId||"");setProductionTypeId((pref.data as any).productionTypeId||pt.data[0]?.id||"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الإنتاج")}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[status]);

 useEffect(()=>{
  if(!productId||!stageId||!shiftId||!workDate){setResolvedMethod("");setResolvedRate(null);setRateOverride("");return}
  const q=new URLSearchParams({productId,stageId,shiftId,workDate});
  if(productionTypeId)q.set("productionTypeId",productionTypeId);
  api<{data:{method:string;rate:number}}>("/api/rates/resolve?"+q.toString()).then(r=>{setResolvedMethod(r.data.method);setResolvedRate(Number(r.data.rate));setRateOverride(String(r.data.rate))}).catch(()=>{setResolvedMethod("");setResolvedRate(null);setRateOverride("")});
 },[productId,stageId,shiftId,workDate,productionTypeId]);

 const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
 const isShiftWage=resolvedMethod==="PER_DAY";

 const employeeOptions=useMemo(()=>employees.filter(x=>x.full_name).map(x=>({value:x.id,label:x.full_name,meta:x.code})),[employees]);
 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name})),[products]);
 const stageOptions=useMemo(()=>stages.map(x=>({value:x.id,label:x.name})),[stages]);
 const shiftOptions=useMemo(()=>shifts.map(x=>({value:x.id,label:x.name})),[shifts]);
 const orderStageOptions=useMemo(()=>orderStages.map(x=>({value:x.id,label:x.order_name+" — "+x.stage_name,meta:x.order_code})),[orderStages]);
 const typeOptions=useMemo(()=>productionTypes.map(x=>({value:x.id,label:x.name})),[productionTypes]);
 const warehouseOptions=useMemo(()=>Array.from(new Map(destinations.map(x=>[x.warehouse_id,{value:x.warehouse_id,label:x.warehouse_name}])).values()),[destinations]);
 const locationOptions=useMemo(()=>destinations.filter(x=>x.warehouse_id===warehouseId).map(x=>({value:x.id,label:x.name})),[destinations,warehouseId]);

 function selectOrderStage(value:string){setOrderStageId(value);const x=orderStages.find(s=>s.id===value);if(x){setStageId(x.stage_id);if(x.output_product_id)setProductId(x.output_product_id)}}

 async function submit(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   await api("/api/production",{method:"POST",body:JSON.stringify({employeeId:employeeId||undefined,orderStageId:orderStageId||null,productionTypeId:productionTypeId||null,productId,stageId,shiftId,workDate,quantity:isShiftWage?1:Number(normalizeNumber(quantity)),rateOverride:resolvedRate!==null&&rateOverride!==""?Number(normalizeNumber(rateOverride)):undefined,baseAmount:resolvedMethod==="PERCENTAGE"?Number(normalizeNumber(baseAmount)):undefined,hoursWorked:resolvedMethod==="PER_HOUR"?Number(normalizeNumber(hoursWorked)):undefined,warehouseId,locationId})});
   await api("/api/account/preferences/production",{method:"PUT",body:JSON.stringify({employeeId,shiftId,productionTypeId})}).catch(()=>{});
   setQuantity("");setBaseAmount("");setHoursWorked("");setResolvedMethod("");setResolvedRate(null);setRateOverride("");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الإنتاج")}finally{setSaving(false)}
 }
 async function editEntry(x:Entry){setEditTarget(x);setEditQuantity(String(x.quantity));}
 async function review(id:string,action:"approve"|"reject"){if(action==="reject"){setReviewTarget(id);setReviewReason("");return}try{await api("/api/production/"+id+"/approve",{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ المراجعة")}}

 return <div className="app-shell"><Sidebar active="/production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاج العمال</h1><p className="page-subtitle">اختار الطلب والمرحلة ونوع الإنتاج، وحدد سعر المرحلة وقت تسجيل الإنتاج.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}
  {has("production.create")&&<form className="card production-form" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل إنتاج عامل</h2><span className="form-hint">الاسم فقط يظهر للمستخدم؛ الأكواد تستخدم داخليًا.</span></div></div>
   <div className="production-grid">
    <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employeeOptions} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/></label>
    <label>الطلب والمرحلة<SearchableSelect value={orderStageId} onChange={selectOrderStage} options={orderStageOptions} placeholder="اختياري — اختر الطلب والمرحلة" searchPlaceholder="ابحث باسم الطلب أو المرحلة"/></label>
    <label>المنتج<SearchableSelect value={productId} onChange={setProductId} options={productOptions} placeholder="اختر المنتج"/></label>
    <label>المرحلة<SearchableSelect value={stageId} onChange={setStageId} options={stageOptions} placeholder="اختر المرحلة"/></label>
    <label>نوع الإنتاج<SearchableSelect value={productionTypeId} onChange={setProductionTypeId} options={typeOptions} placeholder="اختر نوع الإنتاج"/></label>
    <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shiftOptions} placeholder="اختر الوردية"/></label>
    <label>تاريخ الإنتاج<input type="date" value={workDate} onChange={e=>setWorkDate(e.target.value)} required/></label>
    {!isShiftWage&&<label>الكمية<input inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>}}
    {resolvedRate!==null&&<label>سعر المرحلة<input inputMode="decimal" value={rateOverride} onChange={e=>setRateOverride(e.target.value)} required/><span className="form-hint">السعر يُثبت على سجل الإنتاج وقت التسجيل. أي تعديل لاحق يتم من البيانات الأساسية ويؤثر على الإنتاج الجديد فقط.</span></label>}{isShiftWage&&<div className="form-hint" style={{alignSelf:"end"}}>نوع الحساب: وردية — يتم تسجيل وردية واحدة ولا تحتاج قيمة أساس أو أجر نسبة.</div>}
    <label>مخزن دخول الإنتاج<SearchableSelect value={warehouseId} onChange={v=>{setWarehouseId(v);setLocationId("")}} options={warehouseOptions} placeholder="اختر المخزن"/></label>
    <label>مكان دخول الإنتاج<SearchableSelect value={locationId} onChange={setLocationId} options={locationOptions} placeholder="اختر المكان"/></label>
    {resolvedMethod==="PERCENTAGE"&&<label>قيمة الأساس <span className="optional">(لأجر النسبة)</span><input inputMode="decimal" value={baseAmount} onChange={e=>setBaseAmount(e.target.value)} required/></label>}
    {resolvedMethod==="PER_HOUR"&&<label>عدد الساعات <span className="optional">(لأجر الساعة)</span><input inputMode="decimal" value={hoursWorked} onChange={e=>setHoursWorked(e.target.value)} required/></label>}
   </div>
   <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ التسجيل...":"تسجيل الإنتاج"}</button></div>
  </form>}
  {editTarget&&<div className="modal-backdrop" onClick={()=>setEditTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">تعديل الإنتاج</h2><button type="button" className="secondary-btn" onClick={()=>setEditTarget(null)}>إغلاق</button></div><label>الكمية<input inputMode="decimal" value={editQuantity} onChange={e=>setEditQuantity(e.target.value)}/></label><div className="form-actions"><button type="button" className="primary-button" onClick={async()=>{const next=Number(normalizeNumber(editQuantity));if(!Number.isFinite(next)||next<=0){setError("الكمية غير صحيحة");return}try{await api("/api/production/"+editTarget.id,{method:"PATCH",body:JSON.stringify({quantity:next})});setEditTarget(null);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعديل الإنتاج")}}}>حفظ التعديل</button></div></div></div>}
  {reviewTarget&&<div className="modal-backdrop" onClick={()=>setReviewTarget("")}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">رفض الإنتاج</h2><button type="button" className="secondary-btn" onClick={()=>setReviewTarget("")}>إغلاق</button></div><label>سبب الرفض<textarea rows={4} value={reviewReason} onChange={e=>setReviewReason(e.target.value)}/></label><div className="form-actions"><button type="button" className="danger-button" disabled={!reviewReason.trim()} onClick={async()=>{try{await api("/api/production/"+reviewTarget+"/reject",{method:"POST",body:JSON.stringify({reason:reviewReason.trim()})});setReviewTarget("");setReviewReason("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر رفض الإنتاج")}}}>تأكيد الرفض</button></div></div></div>}
  <section className="card"><div className="card-header"><h2 className="card-title">سجل الإنتاج</h2><select className="filter-select" value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات</option><option value="PENDING">معلق</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option></select></div>
   {loading?<div className="empty">جارٍ تحميل السجل...</div>:!entries.length?<div className="empty">لا يوجد إنتاج مسجل.</div>:<div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>المنتج</th><th>المرحلة</th><th>نوع الإنتاج</th><th>الوردية</th><th>الكمية</th><th>السعر</th><th>المستحق</th><th>الحالة</th><th></th></tr></thead><tbody>{entries.map(x=><tr key={x.id}><td>{x.work_date}</td><td className="strong">{x.employee_name}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.production_type_name||"—"}</td><td>{x.shift_name}</td><td>{x.quantity} {x.unit_name}</td><td>{x.rate_snapshot}</td><td className="money">{x.earning_amount}</td><td><span className={"status "+x.status.toLowerCase()}>{statusLabel[x.status]||x.status}</span></td><td>{x.status==="PENDING"&&<div className="row-actions">{has("production.edit")&&<button className="secondary-btn" onClick={()=>editEntry(x)}>تعديل</button>}{has("production.approve")&&<button className="approve-button" onClick={()=>review(x.id,"approve")}>اعتماد</button>}{has("production.reject")&&<button className="reject-button" onClick={()=>review(x.id,"reject")}>رفض</button>}</div>}</td></tr>)}</tbody></table></div>}
  </section>
 </section></main></div>;
}
