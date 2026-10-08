"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { SearchableSelect } from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Employee={id:string;code:string;full_name:string};
type Shift=Item & {rate_group_name:string};
type Destination={id:string;code:string;name:string;warehouse_id:string;warehouse_code:string;warehouse_name:string};
type Order={id:string;code:string;order_name:string};
type OrderStage={id:string;order_id:string;order_code:string;order_name:string;stage_id:string;stage_name:string;output_product_id:string|null;output_product_name:string|null;sequence_no:number;stage_rate:number|null;stage_rate_method:string|null;stage_rate_unit_id:string|null};
type ProductionType=Item & {calculation_method:string};
type Entry={id:string;code:string;work_date:string;quantity:number;rate_snapshot:number;earning_amount:number;bonus_amount:number;deduction_amount:number;total_earning_amount:number;status:string;employee_name:string;product_name:string;stage_name:string;production_type_name:string|null;shift_name:string;unit_name:string};
type Adjustment={id:string;code:string;adjustment_date:string;adjustment_type:"BONUS"|"DEDUCTION";amount:number;reason:string;employee_name:string;shift_name:string|null;production_code:string|null};

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};

export default function ProductionPage(){
 const {has}=usePermissions();
 const [employees,setEmployees]=useState<Employee[]>([]),[orders,setOrders]=useState<Order[]>([]),[products,setProducts]=useState<Item[]>([]),[stages,setStages]=useState<Item[]>([]),[shifts,setShifts]=useState<Shift[]>([]),[destinations,setDestinations]=useState<Destination[]>([]),[orderStages,setOrderStages]=useState<OrderStage[]>([]),[productionTypes,setProductionTypes]=useState<ProductionType[]>([]),[entries,setEntries]=useState<Entry[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[orderId,setOrderId]=useState(""),[orderStageId,setOrderStageId]=useState(""),[productId,setProductId]=useState(""),[stageId,setStageId]=useState(""),[productionTypeId,setProductionTypeId]=useState(""),[shiftId,setShiftId]=useState(""),[workDate,setWorkDate]=useState(new Date().toISOString().slice(0,10)),[quantity,setQuantity]=useState(""),[baseAmount,setBaseAmount]=useState(""),[hoursWorked,setHoursWorked]=useState(""),[warehouseId,setWarehouseId]=useState(""),[locationId,setLocationId]=useState(""),[status,setStatus]=useState("");
 const selectedOrderStage=useMemo(()=>orderStages.find(x=>x.id===orderStageId),[orderStages,orderStageId]);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(""),[resolvedMethod,setResolvedMethod]=useState(""),[resolvedRate,setResolvedRate]=useState<number|null>(null),[rateOverride,setRateOverride]=useState(""),[editTarget,setEditTarget]=useState<Entry|null>(null),[editQuantity,setEditQuantity]=useState(""),[reviewTarget,setReviewTarget]=useState(""),[reviewReason,setReviewReason]=useState("");
 const [adjustments,setAdjustments]=useState<Adjustment[]>([]),[adjustmentEmployee,setAdjustmentEmployee]=useState(""),[adjustmentShift,setAdjustmentShift]=useState(""),[adjustmentType,setAdjustmentType]=useState<"BONUS"|"DEDUCTION">("BONUS"),[adjustmentAmount,setAdjustmentAmount]=useState(""),[adjustmentReason,setAdjustmentReason]=useState(""),[adjustmentSaving,setAdjustmentSaving]=useState(false);
 const [bonusAmount,setBonusAmount]=useState(""),[bonusReason,setBonusReason]=useState(""),[deductionAmount,setDeductionAmount]=useState(""),[deductionReason,setDeductionReason]=useState("");

 async function load(){
  setLoading(true);setError("");
  try{
   const [e,o,p,s,h,d,os,pt,r]=await Promise.all([
    api<{data:Employee[]}>("/api/employees"),api<{data:Order[]}>("/api/orders"),api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/stages"),api<{data:Shift[]}>("/api/shifts"),
    api<{data:Destination[]}>("/api/production/destinations"),api<{data:OrderStage[]}>("/api/order-stages"),api<{data:ProductionType[]}>("/api/production-types"),
    api<{data:Entry[]}>(status?"/api/production?status="+status:"/api/production")
   ]);
   setEmployees(e.data);setOrders(o.data.filter(x=>true));setProducts(p.data);setShifts(h.data);setDestinations(d.data);setOrderStages(os.data);setProductionTypes(pt.data);setEntries(r.data);
   if(!warehouseId){const first=d.data[0]?.warehouse_id;if(first)setWarehouseId(first)}
   const pref=await api<{data:Record<string,string>}>("/api/account/preferences/production").catch(()=>({data:{}}));
   setEmployeeId((pref.data as any).employeeId||"");setShiftId((pref.data as any).shiftId||"");setProductionTypeId((pref.data as any).productionTypeId||pt.data[0]?.id||"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الإنتاج")}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[status]);

 useEffect(()=>{
  if(selectedOrderStage?.stage_rate!=null){
    setResolvedMethod(selectedOrderStage.stage_rate_method||"PER_PIECE");
    setResolvedRate(Number(selectedOrderStage.stage_rate));
    setRateOverride(String(selectedOrderStage.stage_rate));
    return;
  }
  if(!productId||!stageId||!shiftId||!workDate){setResolvedMethod("");setResolvedRate(null);setRateOverride("");return}
  const q=new URLSearchParams({productId,stageId,shiftId,workDate});
  if(productionTypeId)q.set("productionTypeId",productionTypeId);
  api<{data:{method:string;rate:number}}>("/api/rates/resolve?"+q.toString()).then(r=>{setResolvedMethod(r.data.method);setResolvedRate(Number(r.data.rate));setRateOverride(String(r.data.rate))}).catch(()=>{setResolvedMethod("");setResolvedRate(null);setRateOverride("")});
 },[selectedOrderStage,productId,stageId,shiftId,workDate,productionTypeId]);

 const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
 const isShiftWage=resolvedMethod==="PER_DAY";

 const employeeOptions=useMemo(()=>employees.filter(x=>x.full_name).map(x=>({value:x.id,label:x.full_name,meta:x.code})),[employees]);
 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name})),[products]);
 const stageOptions=useMemo(()=>stages.map(x=>({value:x.id,label:x.name})),[stages]);
 const shiftOptions=useMemo(()=>shifts.map(x=>({value:x.id,label:x.name})),[shifts]);
 const orderOptions=useMemo(()=>orders.map(x=>({value:x.id,label:x.order_name,meta:x.code})),[orders]);
 const filteredOrderStages=useMemo(()=>orderStages.filter(x=>!orderId||x.order_id===orderId),[orderStages,orderId]);
 const orderStageOptions=useMemo(()=>filteredOrderStages.map(x=>({value:x.id,label:x.stage_name,meta:x.stage_rate!=null?((x.stage_rate_method==="PER_1000"?"لكل ألف":"بالقطعة")+" · "+Number(x.stage_rate).toLocaleString("ar-EG")):"بدون سعر"})),[filteredOrderStages]);
 const typeOptions=useMemo(()=>productionTypes.map(x=>({value:x.id,label:x.name})),[productionTypes]);
 const warehouseOptions=useMemo(()=>Array.from(new Map(destinations.map(x=>[x.warehouse_id,{value:x.warehouse_id,label:x.warehouse_name}])).values()),[destinations]);
 const productionToday=useMemo(()=>entries.filter(x=>x.work_date===new Date().toISOString().slice(0,10)),[entries]);
 const approvedCount=useMemo(()=>entries.filter(x=>x.status==="APPROVED").length,[entries]);
 const calculatedBase=useMemo(()=>{
  const rate=Number(normalizeNumber(rateOverride||"0")),q=Number(normalizeNumber(quantity||"0")),hours=Number(normalizeNumber(hoursWorked||"0")),base=Number(normalizeNumber(baseAmount||"0"));
  if(resolvedMethod==="PER_PIECE") return q*rate;
  if(resolvedMethod==="PER_1000") return q/1000*rate;
  if(resolvedMethod==="PER_DAY") return rate;
  if(resolvedMethod==="PER_HOUR") return hours*rate;
  if(resolvedMethod==="PERCENTAGE") return base*rate/100;
  return 0;
 },[resolvedMethod,rateOverride,quantity,hoursWorked,baseAmount]);
 const pendingCount=useMemo(()=>entries.filter(x=>x.status==="PENDING").length,[entries]);
 async function loadAdjustments(){if(!has("production.adjustments.view"))return;try{const x=await api<{data:Adjustment[]}>("/api/production/adjustments");setAdjustments(x.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البونص والخصومات")}}
 useEffect(()=>{void loadAdjustments()},[has]);

 function selectOrder(value:string){setOrderId(value);setOrderStageId("");setStageId("");setProductId("");}
 function selectOrderStage(value:string){setOrderStageId(value);const x=filteredOrderStages.find(s=>s.id===value);if(x){setStageId(x.stage_id);if(x.output_product_id)setProductId(x.output_product_id)}}

 async function submit(e:FormEvent){
  e.preventDefault();setError("");
  const q=isShiftWage?1:Number(normalizeNumber(quantity||"0"));
  const bonus=Number(normalizeNumber(bonusAmount||"0"));
  const deduction=Number(normalizeNumber(deductionAmount||"0"));
  if(!employeeId) return setError("اختر الموظف.");
  if(!orderId) return setError("اختر الطلبية.");
  if(!orderStageId) return setError("اختر المرحلة من مراحل الطلبية.");
  if(!productionTypeId) return setError("اختر نوع الإنتاج.");
  if(!shiftId) return setError("اختر الوردية.");
  if(!resolvedMethod||resolvedRate===null) return setError("لم يتم العثور على سعر إنتاج مطابق للطلب والمرحلة والوردية.");
  if(!isShiftWage && (!Number.isFinite(q)||q<=0)) return setError("أدخل كمية إنتاج صحيحة.");
  if(resolvedMethod==="PERCENTAGE" && (!baseAmount || Number(normalizeNumber(baseAmount))<0)) return setError("أدخل قيمة أساس صحيحة.");
  if(resolvedMethod==="PER_HOUR" && (!hoursWorked || Number(normalizeNumber(hoursWorked))<=0)) return setError("أدخل عدد ساعات صحيح.");
  if(bonus>0&&!bonusReason.trim()) return setError("اكتب بيان البونص.");
  if(deduction>0&&!deductionReason.trim()) return setError("اكتب بيان الخصم.");
  if(bonus<0||deduction<0) return setError("البونص والخصم لا يمكن أن يكونا سالبين.");
  setSaving(true);
  try{
   await api("/api/production",{method:"POST",body:JSON.stringify({employeeId:employeeId||undefined,orderStageId,productionTypeId,productId,stageId,shiftId,workDate,quantity:q,rateOverride:resolvedRate!==null&&rateOverride!==""?Number(normalizeNumber(rateOverride)):undefined,baseAmount:resolvedMethod==="PERCENTAGE"?Number(normalizeNumber(baseAmount)):undefined,hoursWorked:resolvedMethod==="PER_HOUR"?Number(normalizeNumber(hoursWorked)):undefined,warehouseId,locationId,
     bonusAmount:bonus,bonusReason:bonus>0?bonusReason.trim():null,deductionAmount:deduction,deductionReason:deduction>0?deductionReason.trim():null
    })});
   await api("/api/account/preferences/production",{method:"PUT",body:JSON.stringify({employeeId,shiftId,productionTypeId})}).catch(()=>{});
   setQuantity("");setBaseAmount("");setHoursWorked("");setResolvedMethod("");setResolvedRate(null);setRateOverride("");setBonusAmount("");setBonusReason("");setDeductionAmount("");setDeductionReason("");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الإنتاج")}finally{setSaving(false)}
 }
 async function addAdjustment(){
  setAdjustmentSaving(true);setError("");
  try{
    await api("/api/production/adjustments",{method:"POST",body:JSON.stringify({
      employeeId:adjustmentEmployee,shiftId:adjustmentShift||null,adjustmentType,amount:Number(normalizeNumber(adjustmentAmount)),reason:adjustmentReason.trim()
    })});
    setAdjustmentAmount("");setAdjustmentReason("");await loadAdjustments();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل البونص أو الخصم")}finally{setAdjustmentSaving(false)}
 }
 async function editEntry(x:Entry){setEditTarget(x);setEditQuantity(String(x.quantity));}
 async function review(id:string,action:"approve"|"reject"){if(action==="reject"){setReviewTarget(id);setReviewReason("");return}try{await api("/api/production/"+id+"/approve",{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ المراجعة")}}

 return <div className="app-shell"><Sidebar active="/production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاج العمال</h1><p className="page-subtitle">اختار الطلبية ونوع الإنتاج فقط؛ المنتج والمرحلة والسعر بيتحددوا تلقائيًا من بيانات الطلب.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}
  <div className="stats">
   <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">{productionToday.reduce((s,x)=>s+Number(x.quantity||0),0).toLocaleString("ar-EG")}</div><div className="stat-note">{productionToday.length} سجل</div></article>
   <article className="card stat accent"><div className="stat-label">إنتاج معتمد</div><div className="stat-value">{approvedCount.toLocaleString("ar-EG")}</div><div className="stat-note">إجمالي السجلات المعتمدة</div></article>
   <article className="card stat warning"><div className="stat-label">بانتظار المراجعة</div><div className="stat-value">{pendingCount.toLocaleString("ar-EG")}</div><div className="stat-note">يحتاج اعتماد أو رفض</div></article>
   <article className="card stat neutral"><div className="stat-label">صافي التعديلات</div><div className="stat-value">{adjustments.reduce((s,x)=>s+(x.adjustment_type==="BONUS"?Number(x.amount):-Number(x.amount)),0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</div><div className="stat-note">بونص ناقص خصومات</div></article>
  </div>
  {has("production.create")&&<form className="card production-form" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل إنتاج عامل</h2><span className="form-hint">الاسم فقط يظهر للمستخدم؛ الأكواد تستخدم داخليًا.</span></div></div>
   <div className="production-grid">
    <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employeeOptions} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/></label>
    <label>الطلبية<SearchableSelect value={orderId} onChange={selectOrder} options={orderOptions} placeholder="اختر الطلبية" searchPlaceholder="ابحث باسم الطلبية"/></label>
    <label>المرحلة<SearchableSelect value={orderStageId} onChange={selectOrderStage} options={orderStageOptions} placeholder={orderId?"اختر مرحلة من الطلبية":"اختر الطلبية أولًا"} searchPlaceholder="ابحث في مراحل الطلبية" /></label>
    {orderStageId&&<div className="form-hint" style={{alignSelf:"end"}}>المنتج والمرحلة بيتحددوا تلقائيًا من الطلبية: {products.find(x=>x.id===productId)?.name||"—"} — {stages.find(x=>x.id===stageId)?.name||"—"}</div>}
    <label>نوع الإنتاج<SearchableSelect value={productionTypeId} onChange={setProductionTypeId} options={typeOptions} placeholder="اختر نوع الإنتاج"/></label>
    <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shiftOptions} placeholder="اختر الوردية"/></label>
    <label>تاريخ الإنتاج<input type="date" value={workDate} onChange={e=>setWorkDate(e.target.value)} required/></label>
    {!isShiftWage&&<label>الكمية<input inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>}
    {resolvedRate!==null ? <label>سعر المرحلة<input inputMode="decimal" value={rateOverride} readOnly={Boolean(selectedOrderStage?.stage_rate!=null)} onChange={e=>setRateOverride(e.target.value)} required/><span className="form-hint">{selectedOrderStage?.stage_rate!=null?"السعر محدد داخل الطلبية ومرحلتها، ولا يمكن تغييره من تسجيل الإنتاج.":"السعر الحالي من تسعير المرحلة العام."}</span></label> : null}{isShiftWage ? <div className="form-hint" style={{alignSelf:"end"}}>نوع الحساب: وردية — يتم تسجيل وردية واحدة ولا تحتاج قيمة أساس أو أجر نسبة.</div> : null}
    <div className="form-hint" style={{alignSelf:"end"}}>المخزن يتحدد تلقائيًا: مراحل التشغيل إلى «تحت التشغيل»، والمرحلة النهائية إلى «المنتجات الجاهزة».</div>
    {resolvedMethod==="PERCENTAGE"&&<label>قيمة الأساس <span className="optional">(لأجر النسبة)</span><input inputMode="decimal" value={baseAmount} onChange={e=>setBaseAmount(e.target.value)} required/></label>}
    {resolvedMethod==="PER_HOUR"&&<label>عدد الساعات <span className="optional">(لأجر الساعة)</span><input inputMode="decimal" value={hoursWorked} onChange={e=>setHoursWorked(e.target.value)} required/></label>}
    <div className="production-adjustment-box">
      <div className="production-adjustment-title">تعديل مستحق الإنتاج <span>اختياري</span></div>
      <div className="production-adjustment-grid">
        <label>بونص<input inputMode="decimal" value={bonusAmount} onChange={e=>setBonusAmount(e.target.value)} placeholder="٠"/></label>
        <label>بيان البونص<input value={bonusReason} onChange={e=>setBonusReason(e.target.value)} placeholder="مثال: جودة ممتازة"/></label>
        <label>خصم<input inputMode="decimal" value={deductionAmount} onChange={e=>setDeductionAmount(e.target.value)} placeholder="٠"/></label>
        <label>بيان الخصم<input value={deductionReason} onChange={e=>setDeductionReason(e.target.value)} placeholder="مثال: هالك زائد"/></label>
      </div>
      <div className="production-total-preview">
        <span>إجمالي مستحق العامل</span>
        <strong>{(calculatedBase + Number(normalizeNumber(bonusAmount||"0")) - Number(normalizeNumber(deductionAmount||"0"))).toLocaleString("ar-EG",{maximumFractionDigits:2})}</strong>
      </div>
    </div>
   </div>
   <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ التسجيل...":"تسجيل الإنتاج"}</button></div>
  </form>}
  {editTarget&&<div className="modal-backdrop" onClick={()=>setEditTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">تعديل الإنتاج</h2><button type="button" className="secondary-btn" onClick={()=>setEditTarget(null)}>إغلاق</button></div><label>الكمية<input inputMode="decimal" value={editQuantity} onChange={e=>setEditQuantity(e.target.value)}/></label><div className="form-actions"><button type="button" className="primary-button" onClick={async()=>{const next=Number(normalizeNumber(editQuantity));if(!Number.isFinite(next)||next<=0){setError("الكمية غير صحيحة");return}try{await api("/api/production/"+editTarget.id,{method:"PATCH",body:JSON.stringify({quantity:next})});setEditTarget(null);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعديل الإنتاج")}}}>حفظ التعديل</button></div></div></div>}
  {reviewTarget&&<div className="modal-backdrop" onClick={()=>setReviewTarget("")}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">رفض الإنتاج</h2><button type="button" className="secondary-btn" onClick={()=>setReviewTarget("")}>إغلاق</button></div><label>سبب الرفض<textarea rows={4} value={reviewReason} onChange={e=>setReviewReason(e.target.value)}/></label><div className="form-actions"><button type="button" className="danger-button" disabled={!reviewReason.trim()} onClick={async()=>{try{await api("/api/production/"+reviewTarget+"/reject",{method:"POST",body:JSON.stringify({reason:reviewReason.trim()})});setReviewTarget("");setReviewReason("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر رفض الإنتاج")}}}>تأكيد الرفض</button></div></div></div>}
  <section className="card"><div className="card-header"><h2 className="card-title">سجل الإنتاج</h2><select className="filter-select" value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات</option><option value="PENDING">معلق</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option></select></div>
   {loading?<div className="empty">جارٍ تحميل السجل...</div>:!entries.length?<div className="empty">لا يوجد إنتاج مسجل.</div>:<div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>المنتج</th><th>المرحلة</th><th>نوع الإنتاج</th><th>الوردية</th><th>الكمية</th><th>السعر الأساسي</th><th>البونص</th><th>الخصم</th><th>إجمالي المستحق</th><th>الحالة</th><th></th></tr></thead><tbody>{entries.map(x=><tr key={x.id}><td>{x.work_date}</td><td className="strong">{x.employee_name}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.production_type_name||"—"}</td><td>{x.shift_name}</td><td>{x.quantity} {x.unit_name}</td><td>{Number(x.earning_amount).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td><td>{Number(x.bonus_amount||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td><td>{Number(x.deduction_amount||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td><td className="money strong">{Number(x.total_earning_amount??x.earning_amount).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td><td><span className={"status "+x.status.toLowerCase()}>{statusLabel[x.status]||x.status}</span></td><td>{x.status==="PENDING"&&<div className="row-actions">{has("production.edit")&&<button className="secondary-btn" onClick={()=>editEntry(x)}>تعديل</button>}{has("production.approve")&&<button className="approve-button" onClick={()=>review(x.id,"approve")}>اعتماد</button>}{has("production.reject")&&<button className="reject-button" onClick={()=>review(x.id,"reject")}>رفض</button>}</div>}</td></tr>)}</tbody></table></div>}
  </section>
 </section></main></div>;
}
