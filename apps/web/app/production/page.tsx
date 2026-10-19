"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import {formatInteger,formatMoney,formatQuantity} from "../../lib/format";
import { SearchableSelect } from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Employee={id:string;code:string;full_name:string};
type Shift=Item & {rate_group_name:string};
type ShiftLeader={id:string;shift_id:string;shift_name:string;employee_id:string;employee_name:string;assignment_type:string};
type Order={id:string;code:string;order_name:string};
type OrderStage={id:string;order_id:string;order_code:string;order_name:string;stage_id:string;stage_name:string;output_product_id:string|null;output_product_name:string|null;sequence_no:number;stage_rate:number|null;stage_rate_method:string|null;stage_rate_unit_id:string|null;production_type_id:string|null};
type ProductionType=Item & {calculation_method:string};
type Entry={id:string;code:string;work_date:string;employee_id:string;shift_id:string;shift_leader_employee_id:string|null;order_stage_id:string|null;product_id:string;stage_id:string;production_type_id:string|null;base_amount:number|null;hours_worked:number|null;shift_leader_name:string|null;quantity:number;rate_snapshot:number;earning_amount:number;bonus_amount:number;deduction_amount:number;bonus_reason:string|null;deduction_reason:string|null;total_earning_amount:number;status:string;employee_name:string;product_name:string;stage_name:string;production_type_name:string|null;shift_name:string;unit_name:string};
type Adjustment={id:string;code:string;adjustment_date:string;adjustment_type:"BONUS"|"DEDUCTION";amount:number;reason:string;employee_name:string;shift_name:string|null;production_code:string|null};

const localDateKey=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`};

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};

export default function ProductionPage(){
 const {has}=usePermissions();
 const [employees,setEmployees]=useState<Employee[]>([]),[orders,setOrders]=useState<Order[]>([]),[products,setProducts]=useState<Item[]>([]),[stages,setStages]=useState<Item[]>([]),[shifts,setShifts]=useState<Shift[]>([]),[shiftLeaders,setShiftLeaders]=useState<ShiftLeader[]>([]),[orderStages,setOrderStages]=useState<OrderStage[]>([]),[productionTypes,setProductionTypes]=useState<ProductionType[]>([]),[entries,setEntries]=useState<Entry[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[shiftLeaderEmployeeId,setShiftLeaderEmployeeId]=useState(""),[orderId,setOrderId]=useState(""),[orderStageId,setOrderStageId]=useState(""),[productId,setProductId]=useState(""),[stageId,setStageId]=useState(""),[productionTypeId,setProductionTypeId]=useState(""),[shiftId,setShiftId]=useState(""),[workDate,setWorkDate]=useState(localDateKey()),[quantity,setQuantity]=useState(""),[scrapQuantity,setScrapQuantity]=useState("0"),[scrapType,setScrapType]=useState<"WORKER_SCRAP"|"MANUFACTURING_DEFECT">("WORKER_SCRAP"),[scrapNotes,setScrapNotes]=useState(""),[baseAmount,setBaseAmount]=useState(""),[hoursWorked,setHoursWorked]=useState(""),[status,setStatus]=useState(""),[recordEmployeeFilter,setRecordEmployeeFilter]=useState(""),[recordEntries,setRecordEntries]=useState<Entry[]>([]),[recordLoading,setRecordLoading]=useState(false);
 const selectedOrderStage=useMemo(()=>orderStages.find(x=>x.id===orderStageId),[orderStages,orderStageId]);
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(""),[resolvedMethod,setResolvedMethod]=useState(""),[resolvedRate,setResolvedRate]=useState<number|null>(null),[rateOverride,setRateOverride]=useState(""),[editTarget,setEditTarget]=useState<Entry|null>(null),[editValues,setEditValues]=useState({employeeId:"",orderStageId:"",productId:"",stageId:"",productionTypeId:"",shiftId:"",shiftLeaderEmployeeId:"",workDate:"",quantity:"",baseAmount:"",hoursWorked:"",rateOverride:"",bonusAmount:"",bonusReason:"",deductionAmount:"",deductionReason:""}),[editSaving,setEditSaving]=useState(false),[reviewTarget,setReviewTarget]=useState(""),[reviewReason,setReviewReason]=useState("");
 const [adjustments,setAdjustments]=useState<Adjustment[]>([]),[adjustmentEmployee,setAdjustmentEmployee]=useState(""),[adjustmentShift,setAdjustmentShift]=useState(""),[adjustmentType,setAdjustmentType]=useState<"BONUS"|"DEDUCTION">("BONUS"),[adjustmentAmount,setAdjustmentAmount]=useState(""),[adjustmentReason,setAdjustmentReason]=useState(""),[adjustmentSaving,setAdjustmentSaving]=useState(false);
 const [bonusAmount,setBonusAmount]=useState(""),[bonusReason,setBonusReason]=useState(""),[deductionAmount,setDeductionAmount]=useState(""),[deductionReason,setDeductionReason]=useState("");
 const [deleteTarget,setDeleteTarget]=useState<Entry|null>(null),[deletePassword,setDeletePassword]=useState(""),[deleting,setDeleting]=useState(false),[reverseTarget,setReverseTarget]=useState<Entry|null>(null),[reversePassword,setReversePassword]=useState(""),[reverseReason,setReverseReason]=useState(""),[reversing,setReversing]=useState(false);
 useEffect(()=>{if(!error)return;const timer=window.setTimeout(()=>setError(""),6500);return()=>window.clearTimeout(timer)},[error]);

 async function load(){
  setLoading(true);setError("");
  try{
   const [e,o,p,s,h,leaders,os,pt,r]=await Promise.all([
    api<{data:Employee[]}>("/api/employees"),api<{data:Order[]}>("/api/orders"),api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/stages"),api<{data:Shift[]}>("/api/shifts"),api<{data:ShiftLeader[]}>("/api/shift-leaders"),
    api<{data:OrderStage[]}>("/api/order-stages"),api<{data:ProductionType[]}>("/api/production-types"),
    api<{data:Entry[]}>(status?"/api/production?status="+status:"/api/production")
   ]);
   setEmployees(e.data);setShiftLeaders(leaders.data);setOrders(o.data.filter(x=>!["COMPLETED","CANCELLED"].includes((x as any).status)));setProducts(p.data);setShifts(h.data);setOrderStages(os.data);setProductionTypes(pt.data);setEntries(r.data);setRecordEntries(r.data);
   const pref=await api<{data:Record<string,string>}>("/api/account/preferences/production").catch(()=>({data:{}}));
   setEmployeeId((pref.data as any).employeeId||"");setShiftId((pref.data as any).shiftId||"");setProductionTypeId((pref.data as any).productionTypeId||pt.data[0]?.id||"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الإنتاج")}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[status]);

 // Fetch the selected worker's full available production history from the API,
 // rather than filtering only the first page of the general list in the browser.
 useEffect(()=>{
  let active=true;
  const params=new URLSearchParams({limit:"200"});
  if(status)params.set("status",status);
  if(recordEmployeeFilter)params.set("employeeId",recordEmployeeFilter);
  setRecordLoading(true);
  api<{data:Entry[]}>("/api/production?"+params.toString())
   .then(result=>{if(active)setRecordEntries(result.data)})
   .catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل سجل إنتاج العامل")})
   .finally(()=>{if(active)setRecordLoading(false)});
  return ()=>{active=false};
 },[status,recordEmployeeFilter]);

 useEffect(()=>{
  if(selectedOrderStage?.stage_rate!=null){
    setResolvedMethod(selectedOrderStage.stage_rate_method||"PER_PIECE");
    setResolvedRate(Number(selectedOrderStage.stage_rate));
    setRateOverride(Number(selectedOrderStage.stage_rate).toString());
    return;
  }
  if(!productId||!stageId||!shiftId||!workDate){setResolvedMethod("");setResolvedRate(null);setRateOverride("");return}
  const q=new URLSearchParams({productId,stageId,shiftId,workDate});
  if(productionTypeId)q.set("productionTypeId",productionTypeId);
  api<{data:{method:string;rate:number}}>("/api/rates/resolve?"+q.toString()).then(r=>{setResolvedMethod(r.data.method);setResolvedRate(Number(r.data.rate));setRateOverride(Number(r.data.rate).toString())}).catch(()=>{setResolvedMethod("");setResolvedRate(null);setRateOverride("")});
 },[selectedOrderStage,productId,stageId,shiftId,workDate,productionTypeId]);

 const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
 const isShiftWage=resolvedMethod==="PER_DAY";

 const employeeOptions=useMemo(()=>employees.filter(x=>x.full_name).map(x=>({value:x.id,label:x.full_name,meta:x.code})),[employees]);
 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name})),[products]);
 const stageOptions=useMemo(()=>stages.map(x=>({value:x.id,label:x.name})),[stages]);
 const shiftOptions=useMemo(()=>shifts.map(x=>({value:x.id,label:x.name})),[shifts]);
 const responsibleOptions=useMemo(()=>Array.from(new Map(shiftLeaders.filter(x=>!shiftId||x.shift_id===shiftId).map(x=>[x.employee_id,{value:x.employee_id,label:x.employee_name,meta:x.shift_name}])).values()),[shiftLeaders,shiftId]);
 function selectShift(value:string){setShiftId(value);if(shiftLeaderEmployeeId&&!shiftLeaders.some(x=>x.employee_id===shiftLeaderEmployeeId&&x.shift_id===value))setShiftLeaderEmployeeId("")}
 function selectResponsible(value:string){setShiftLeaderEmployeeId(value)}
 const orderOptions=useMemo(()=>orders.map(x=>({value:x.id,label:x.order_name,meta:x.code})),[orders]);
 const filteredOrderStages=useMemo(()=>orderStages.filter(x=>!orderId||x.order_id===orderId),[orderStages,orderId]);
 const orderStageOptions=useMemo(()=>filteredOrderStages.map(x=>({value:x.id,label:x.stage_name,meta:x.stage_rate!=null?((x.stage_rate_method==="PER_1000"?"لكل ألف":"بالقطعة")+" · "+formatMoney(x.stage_rate)):"بدون سعر"})),[filteredOrderStages]);
 const typeOptions=useMemo(()=>productionTypes.map(x=>({value:x.id,label:x.name})),[productionTypes]);
 const productionToday=useMemo(()=>entries.filter(x=>x.work_date===localDateKey()),[entries]);
 const approvedCount=useMemo(()=>entries.filter(x=>x.status==="APPROVED").length,[entries]);
 const calculatedBase=useMemo(()=>{
  const rate=Number(normalizeNumber(rateOverride||"0")),gross=Number(normalizeNumber(quantity||"0")),scrap=Math.max(0,Number(normalizeNumber(scrapQuantity||"0"))),q=Math.max(0,gross-scrap),hours=Number(normalizeNumber(hoursWorked||"0")),base=Number(normalizeNumber(baseAmount||"0"));
  if(resolvedMethod==="PER_PIECE") return q*rate;
  if(resolvedMethod==="PER_1000") return q/1000*rate;
  if(resolvedMethod==="PER_DAY") return rate;
  if(resolvedMethod==="PER_HOUR") return hours*rate;
  if(resolvedMethod==="PERCENTAGE") return base*rate/100;
  return 0;
 },[resolvedMethod,rateOverride,quantity,scrapQuantity,hoursWorked,baseAmount]);
 const pendingCount=useMemo(()=>entries.filter(x=>x.status==="PENDING").length,[entries]);
 async function loadAdjustments(){if(!has("production.adjustments.view"))return;try{const x=await api<{data:Adjustment[]}>("/api/production/adjustments");setAdjustments(x.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البونص والخصومات")}}
 useEffect(()=>{void loadAdjustments()},[has]);

 function selectOrder(value:string){setOrderId(value);setOrderStageId("");setStageId("");setProductId("");}
 function selectOrderStage(value:string){setOrderStageId(value);const x=filteredOrderStages.find(s=>s.id===value);if(x){setStageId(x.stage_id);setProductId(x.output_product_id||"");if(x.production_type_id)setProductionTypeId(x.production_type_id)}}

 async function submit(e:FormEvent){
  e.preventDefault();setError("");
  const q=isShiftWage?1:Number(normalizeNumber(quantity||"0"));
  const bonus=Number(normalizeNumber(bonusAmount||"0"));
  const deduction=Number(normalizeNumber(deductionAmount||"0"));
  if(!employeeId) return setError("اختر الموظف.");
  if(!orderId) return setError("اختر الطلبية.");
  if(!orderStageId) return setError("اختر المرحلة من مراحل الطلبية.");
  if(!productId) return setError("اختر المنتج أو اربط منتجًا ناتجًا بالمرحلة.");
  if(!productionTypeId) return setError("اختر نوع الإنتاج.");
  if(!shiftId) return setError("اختر الوردية.");
  if(!resolvedMethod||resolvedRate===null) return setError("لم يتم العثور على سعر إنتاج مطابق للطلب والمرحلة والوردية.");
  if(!isShiftWage && (!Number.isFinite(q)||q<=0)) return setError("الكمية السليمة لازم تكون أكبر من صفر.");
  const grossQuantity=isShiftWage?q:Number(normalizeNumber(quantity||"0")),scrap=Number(normalizeNumber(scrapQuantity||"0"));
  if(!Number.isFinite(scrap)||scrap<0||scrap>=grossQuantity) return setError("كمية الهالك لازم تكون صفر أو أقل من إجمالي الإنتاج.");
  if(resolvedMethod==="PERCENTAGE" && (!baseAmount || Number(normalizeNumber(baseAmount))<0)) return setError("أدخل قيمة أساس صحيحة.");
  if(resolvedMethod==="PER_HOUR" && (!hoursWorked || Number(normalizeNumber(hoursWorked))<=0)) return setError("أدخل عدد ساعات صحيح.");
  if(bonus>0&&!bonusReason.trim()) return setError("اكتب بيان البونص.");
  if(deduction>0&&!deductionReason.trim()) return setError("اكتب بيان الخصم.");
  if(bonus<0||deduction<0) return setError("البونص والخصم لا يمكن أن يكونا سالبين.");
  setSaving(true);
  let createdProductionId:string|null=null;
  try{
   const created=await api<{data:{id:string}}>("/api/production",{method:"POST",body:JSON.stringify({employeeId:employeeId||undefined,shiftLeaderEmployeeId:shiftLeaderEmployeeId||null,orderStageId,productionTypeId,productId:productId||undefined,stageId,shiftId,workDate,quantity:q,rateOverride:resolvedRate!==null&&rateOverride!==""?Number(normalizeNumber(rateOverride)):undefined,baseAmount:resolvedMethod==="PERCENTAGE"?Number(normalizeNumber(baseAmount)):undefined,hoursWorked:resolvedMethod==="PER_HOUR"?Number(normalizeNumber(hoursWorked)):undefined,
     bonusAmount:bonus,bonusReason:bonus>0?bonusReason.trim():null,deductionAmount:deduction,deductionReason:deduction>0?deductionReason.trim():null
    })});
   createdProductionId=created.data.id;
   if(scrap>0){await api("/api/production/scrap",{method:"POST",body:JSON.stringify({productionEntryId:created.data.id,scrapType,quantity:scrap,notes:scrapNotes.trim()||null,idempotencyKey:crypto.randomUUID()})});}
   await api("/api/account/preferences/production",{method:"PUT",body:JSON.stringify({employeeId,shiftId,productionTypeId})}).catch(()=>{});
   setQuantity("");setScrapQuantity("0");setScrapType("WORKER_SCRAP");setScrapNotes("");setBaseAmount("");setHoursWorked("");setResolvedMethod("");setResolvedRate(null);setRateOverride("");setBonusAmount("");setBonusReason("");setDeductionAmount("");setDeductionReason("");await load();
  }catch(e){
   const message=e instanceof Error?e.message:"تعذر تسجيل الإنتاج";
   setError(createdProductionId&&scrap>0
    ? `تم إنشاء سجل الإنتاج بالفعل (رقم داخلي: ${createdProductionId}) لكن تسجيل الهالك لم يكتمل. لا تعِد تسجيل الإنتاج؛ راجع صفحة الهالك وسجّل الكمية الناقصة. السبب: ${message}`
    : message);
  }finally{setSaving(false)}
 }
 async function confirmReverseProduction(){
  if(!reverseTarget||!reversePassword||reverseReason.trim().length<3)return;
  setReversing(true);setError("");
  try{
   await api("/api/production/"+reverseTarget.id+"/reverse",{method:"POST",body:JSON.stringify({password:reversePassword,reason:reverseReason.trim()})});
   setReverseTarget(null);setReversePassword("");setReverseReason("");await load();await loadAdjustments();
  }catch(e){setError(e instanceof Error?e.message:"تعذر التراجع عن عملية الإنتاج")}
  finally{setReversing(false)}
 }
 async function confirmDeleteProduction(){
  if(!deleteTarget||!deletePassword)return;
  setDeleting(true);setError("");
  try{await api("/api/production/"+deleteTarget.id,{method:"DELETE",body:JSON.stringify({password:deletePassword})});setDeleteTarget(null);setDeletePassword("");await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر حذف سجل الإنتاج")}
  finally{setDeleting(false)}
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
 async function editEntry(x:Entry){
  setEditTarget(x);
  setEditValues({employeeId:x.employee_id,orderStageId:x.order_stage_id||"",productId:x.product_id,stageId:x.stage_id,productionTypeId:x.production_type_id||"",shiftId:x.shift_id,shiftLeaderEmployeeId:x.shift_leader_employee_id||"",workDate:String(x.work_date).slice(0,10),quantity:String(x.quantity),baseAmount:x.base_amount==null?"":String(x.base_amount),hoursWorked:x.hours_worked==null?"":String(x.hours_worked),rateOverride:String(x.rate_snapshot),bonusAmount:String(x.bonus_amount||0),bonusReason:x.bonus_reason||"",deductionAmount:String(x.deduction_amount||0),deductionReason:x.deduction_reason||""});
 }
 async function saveProductionEdit(){
  if(!editTarget)return;
  const v=editValues,quantity=Number(normalizeNumber(v.quantity)),bonusAmount=Number(normalizeNumber(v.bonusAmount||"0")),deductionAmount=Number(normalizeNumber(v.deductionAmount||"0"));
  if(!v.employeeId||!v.shiftId||!v.workDate||!Number.isFinite(quantity)||quantity<=0){setError("راجع الموظف والوردية والتاريخ والكمية.");return}
  if(bonusAmount>0&&!v.bonusReason.trim()){setError("بيان البونص مطلوب.");return}
  if(deductionAmount>0&&!v.deductionReason.trim()){setError("بيان الخصم مطلوب.");return}
  setEditSaving(true);setError("");
  try{
    await api("/api/production/"+editTarget.id,{method:"PATCH",body:JSON.stringify({employeeId:v.employeeId,orderStageId:v.orderStageId||null,productId:v.productId,stageId:v.stageId,productionTypeId:v.productionTypeId||null,shiftId:v.shiftId,shiftLeaderEmployeeId:v.shiftLeaderEmployeeId||null,workDate:v.workDate,quantity,baseAmount:v.baseAmount===""?null:Number(normalizeNumber(v.baseAmount)),hoursWorked:v.hoursWorked===""?null:Number(normalizeNumber(v.hoursWorked)),rateOverride:has("production.rate_override")&&v.rateOverride!==""?Number(normalizeNumber(v.rateOverride)):null,bonusAmount,bonusReason:bonusAmount?v.bonusReason.trim():null,deductionAmount,deductionReason:deductionAmount?v.deductionReason.trim():null})});
    setEditTarget(null);await load();await loadAdjustments();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تعديل سجل الإنتاج")}
  finally{setEditSaving(false)}
 }
 async function review(id:string,action:"approve"|"reject"){if(action==="reject"){setReviewTarget(id);setReviewReason("");return}try{await api("/api/production/"+id+"/approve",{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ المراجعة")}}


 return <div className="app-shell"><Sidebar active="/production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاج العمال</h1><p className="page-subtitle">اختار الطلبية ونوع الإنتاج فقط؛ المنتج والمرحلة والسعر بيتحددوا تلقائيًا من بيانات الطلب.</p></div><a className="secondary-btn" href="/production/scrap">♻ الهالك والتقارير</a></header><section className="content">
  {error&&<div role="alert" aria-live="assertive" className="alert error" style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:1000,width:"min(92vw,520px)",boxShadow:"0 8px 28px rgba(0,0,0,.22)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}><span>{error}</span><button type="button" aria-label="إغلاق التنبيه" onClick={()=>setError("")} style={{border:0,background:"transparent",color:"inherit",fontSize:20,cursor:"pointer"}}>×</button></div>}
  <div className="stats">
   <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">{formatQuantity(productionToday.reduce((s,x)=>s+Number(x.quantity||0),0),0)}</div><div className="stat-note">{productionToday.length} سجل</div></article>
   <article className="card stat accent"><div className="stat-label">إنتاج معتمد</div><div className="stat-value">{formatInteger(approvedCount)}</div><div className="stat-note">إجمالي السجلات المعتمدة</div></article>
   <article className="card stat warning"><div className="stat-label">بانتظار المراجعة</div><div className="stat-value">{formatInteger(pendingCount)}</div><div className="stat-note">يحتاج اعتماد أو رفض</div></article>
   <article className="card stat neutral"><div className="stat-label">صافي التعديلات</div><div className="stat-value">{formatMoney(adjustments.reduce((s,x)=>s+(x.adjustment_type==="BONUS"?Number(x.amount):-Number(x.amount)),0))}</div><div className="stat-note">بونص ناقص خصومات</div></article>
  </div>
  {has("production.create")&&<form className="card production-form" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل إنتاج عامل</h2><span className="form-hint">الاسم فقط يظهر للمستخدم؛ الأكواد تستخدم داخليًا.</span></div></div>
   <div className="production-grid">
    <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employeeOptions} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/></label>
    <label>الطلبية<SearchableSelect value={orderId} onChange={selectOrder} options={orderOptions} placeholder="اختر الطلبية" searchPlaceholder="ابحث باسم الطلبية"/></label>
    <label>المرحلة<SearchableSelect value={orderStageId} onChange={selectOrderStage} options={orderStageOptions} placeholder={orderId?"اختر مرحلة من الطلبية":"اختر الطلبية أولًا"} searchPlaceholder="ابحث في مراحل الطلبية" /></label>
    <label>المنتج<SearchableSelect value={productId} onChange={setProductId} options={productOptions} placeholder="اختيار المنتج" searchPlaceholder="ابحث عن المنتج"/></label>
    
    <label>نوع الإنتاج<SearchableSelect value={productionTypeId} onChange={setProductionTypeId} options={typeOptions} placeholder="اختر نوع الإنتاج"/></label>
    <label>الوردية<SearchableSelect value={shiftId} onChange={selectShift} options={shiftOptions} placeholder="اختر الوردية"/></label>
    <label>مسؤول الوردية <span className="optional">(اختياري)</span><SearchableSelect value={shiftLeaderEmployeeId} onChange={selectResponsible} options={responsibleOptions} placeholder="اختر رئيس وردية" searchPlaceholder="ابحث عن المسؤول"/></label>
    <label>تاريخ الإنتاج<input type="date" value={workDate} onChange={e=>setWorkDate(e.target.value)} required/></label>
    {!isShiftWage&&<label>إجمالي الإنتاج (شامل الهالك)<input inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>}
    {!isShiftWage&&<><label>كمية الهالك الإضافي<input inputMode="decimal" value={scrapQuantity} onChange={e=>setScrapQuantity(e.target.value)} placeholder="٠"/></label>
    {Number(normalizeNumber(scrapQuantity||"0"))>0&&<><label>نوع الهالك<select value={scrapType} onChange={e=>setScrapType(e.target.value as typeof scrapType)}><option value="WORKER_SCRAP">هالك من العامل</option><option value="MANUFACTURING_DEFECT">هالك عيب صناعة</option></select></label><label>سبب / ملاحظات الهالك<input value={scrapNotes} onChange={e=>setScrapNotes(e.target.value)} maxLength={1000} placeholder="اختياري"/></label></>}
    <div className="form-hint" style={{gridColumn:"1/-1"}}>الإجمالي: {formatQuantity(Number(normalizeNumber(quantity||"0")),3)} · الهالك: {formatQuantity(Number(normalizeNumber(scrapQuantity||"0")),3)} · المتاح للتسليم: {formatQuantity(Math.max(0,Number(normalizeNumber(quantity||"0"))-Number(normalizeNumber(scrapQuantity||"0"))),3)}. أجر القطعة يُحسب على السليم فقط.</div></>}
    {resolvedRate!==null ? <label>سعر المرحلة<input inputMode="decimal" value={rateOverride} readOnly={!has("production.rate_override") || Boolean(selectedOrderStage?.stage_rate!=null)} onChange={e=>setRateOverride(e.target.value)} required/><span className="form-hint">{selectedOrderStage?.stage_rate!=null?"السعر محدد داخل الطلبية ومرحلتها، ولا يمكن تغييره من تسجيل الإنتاج.":has("production.rate_override")?"السعر الحالي من التسعير العام ويمكن تعديله بصلاحيتك.":"السعر الحالي من تسعير المرحلة العام؛ تعديل السعر يحتاج صلاحية منفصلة."}</span></label> : null}{isShiftWage ? <div className="form-hint" style={{alignSelf:"end"}}>نوع الحساب: وردية — يتم تسجيل وردية واحدة ولا تحتاج قيمة أساس أو أجر نسبة.</div> : null}
    <div className="form-hint" style={{gridColumn:"1/-1"}}>وجهة التخزين تُحدد تلقائيًا حسب مرحلة الطلب؛ لا يتم اختيار مخزن يدويًا عند تسجيل الإنتاج.</div>
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
        <strong>{formatMoney(calculatedBase + Number(normalizeNumber(bonusAmount||"0")) - Number(normalizeNumber(deductionAmount||"0")))}</strong>
      </div>
    </div>
   </div>
   <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ التسجيل...":"تسجيل الإنتاج"}</button></div>
  </form>}
  {deleteTarget&&<div className="modal-backdrop" onClick={()=>{if(!deleting)setDeleteTarget(null)}}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-production-title" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 id="delete-production-title" className="card-title">تأكيد حذف سجل الإنتاج</h2><div className="form-hint">يمكن حذف الإنتاج المعلّق فقط. الإنتاج المعتمد لا يُحذف تلقائيًا لأنه أثّر في المخزن ومستحقات العامل.</div></div><button type="button" className="secondary-btn" onClick={()=>setDeleteTarget(null)} disabled={deleting}>إغلاق</button></div><p className="strong">{deleteTarget.employee_name} · {deleteTarget.product_name} · {formatQuantity(deleteTarget.quantity)}</p><label>كلمة المرور<input type="password" autoComplete="current-password" value={deletePassword} onChange={e=>setDeletePassword(e.target.value)} required/></label><div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>setDeleteTarget(null)} disabled={deleting}>إلغاء</button><button type="button" className="danger-button" disabled={deleting||!deletePassword} onClick={()=>void confirmDeleteProduction()}>{deleting?"جارٍ الحذف...":"تأكيد الحذف"}</button></div></section></div>}
  {editTarget&&<div className="modal-backdrop" onClick={()=>{if(!editSaving)setEditTarget(null)}}><div className="modal-card" style={{maxWidth:820,maxHeight:"90vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">تعديل بيانات عملية الإنتاج بالكامل</h2><button type="button" className="secondary-btn" onClick={()=>setEditTarget(null)} disabled={editSaving}>إغلاق</button></div><p className="form-hint">التعديل متاح للسجلات المعلقة. عند ربط العملية بمرحلة طلبية، يحدد النظام المنتج والمرحلة والمخزن من بيانات الطلبية.</p><div className="production-grid"><label>الموظف<select value={editValues.employeeId} onChange={e=>setEditValues(v=>({...v,employeeId:e.target.value}))}>{employees.map(x=><option key={x.id} value={x.id}>{x.full_name}</option>)}</select></label><label>الطلبية / المرحلة<select value={editValues.orderStageId} onChange={e=>{const id=e.target.value,os=orderStages.find(x=>x.id===id);setEditValues(v=>({...v,orderStageId:id,productId:os?.output_product_id||v.productId,stageId:os?.stage_id||v.stageId,productionTypeId:os?.production_type_id||v.productionTypeId}))}}><option value="">بدون ربط بمرحلة طلبية</option>{orderStages.map(x=><option key={x.id} value={x.id}>{x.order_name} · {x.stage_name}</option>)}</select></label><label>المنتج<select disabled={Boolean(editValues.orderStageId)} value={editValues.productId} onChange={e=>setEditValues(v=>({...v,productId:e.target.value}))}>{products.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>المرحلة<select disabled={Boolean(editValues.orderStageId)} value={editValues.stageId} onChange={e=>setEditValues(v=>({...v,stageId:e.target.value}))}>{stages.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>نوع الإنتاج<select value={editValues.productionTypeId} onChange={e=>setEditValues(v=>({...v,productionTypeId:e.target.value}))}><option value="">بدون تحديد</option>{productionTypes.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>الوردية<select value={editValues.shiftId} onChange={e=>setEditValues(v=>({...v,shiftId:e.target.value}))}>{shifts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>مسؤول الوردية<select value={editValues.shiftLeaderEmployeeId} onChange={e=>setEditValues(v=>({...v,shiftLeaderEmployeeId:e.target.value}))}><option value="">بدون</option>{employees.map(x=><option key={x.id} value={x.id}>{x.full_name}</option>)}</select></label><label>تاريخ الإنتاج<input type="date" value={editValues.workDate} onChange={e=>setEditValues(v=>({...v,workDate:e.target.value}))}/></label><label>الكمية<input inputMode="decimal" value={editValues.quantity} onChange={e=>setEditValues(v=>({...v,quantity:e.target.value}))}/></label><label>سعر الوحدة / المرحلة<input inputMode="decimal" value={editValues.rateOverride} readOnly={!has("production.rate_override")||Boolean(orderStages.find(s=>s.id===editValues.orderStageId)?.stage_rate!=null)} onChange={e=>setEditValues(v=>({...v,rateOverride:e.target.value}))}/><span className="form-hint">تغيير السعر يحتاج صلاحية تعديل سعر الإنتاج، ولا يمكن تجاوز سعر محدد داخل الطلبية.</span></label><label>قيمة الأساس (لأجر النسبة)<input inputMode="decimal" value={editValues.baseAmount} onChange={e=>setEditValues(v=>({...v,baseAmount:e.target.value}))}/></label><label>ساعات العمل (لأجر الساعة)<input inputMode="decimal" value={editValues.hoursWorked} onChange={e=>setEditValues(v=>({...v,hoursWorked:e.target.value}))}/></label><label>البونص<input inputMode="decimal" value={editValues.bonusAmount} onChange={e=>setEditValues(v=>({...v,bonusAmount:e.target.value}))}/></label><label>بيان البونص<input value={editValues.bonusReason} onChange={e=>setEditValues(v=>({...v,bonusReason:e.target.value}))}/></label><label>الخصم<input inputMode="decimal" value={editValues.deductionAmount} onChange={e=>setEditValues(v=>({...v,deductionAmount:e.target.value}))}/></label><label>بيان الخصم<input value={editValues.deductionReason} onChange={e=>setEditValues(v=>({...v,deductionReason:e.target.value}))}/></label></div><div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>setEditTarget(null)} disabled={editSaving}>إلغاء</button><button type="button" className="primary-button" onClick={()=>void saveProductionEdit()} disabled={editSaving}>{editSaving?"جارٍ الحفظ...":"حفظ كل التعديلات"}</button></div></div></div>}
  {reverseTarget&&<div className="modal-backdrop" onClick={()=>{if(!reversing)setReverseTarget(null)}}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="reverse-production-title" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 id="reverse-production-title" className="card-title">التراجع عن عملية إنتاج معتمدة</h2><p className="form-hint">سيتم تسجيل حركة مخزنية عكسية وعكس أثر المستحقات. لا يمكن التنفيذ إذا تم صرف الإنتاج من المخزن أو تخصيص دفعة مالية له.</p></div><button type="button" className="secondary-btn" onClick={()=>setReverseTarget(null)} disabled={reversing}>إغلاق</button></div><p className="strong">{reverseTarget.code} · {reverseTarget.employee_name} · {formatQuantity(reverseTarget.quantity)}</p><label>سبب التراجع<textarea rows={3} value={reverseReason} onChange={e=>setReverseReason(e.target.value)} placeholder="اكتب سبب التراجع بوضوح"/></label><label>كلمة مرور حسابك<input type="password" autoComplete="current-password" value={reversePassword} onChange={e=>setReversePassword(e.target.value)} /></label><div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>setReverseTarget(null)} disabled={reversing}>إلغاء</button><button type="button" className="danger-button" disabled={reversing||!reversePassword||reverseReason.trim().length<3} onClick={()=>void confirmReverseProduction()}>{reversing?"جارٍ تنفيذ العكس...":"تأكيد التراجع"}</button></div></section></div>}
  {reviewTarget&&<div className="modal-backdrop" onClick={()=>setReviewTarget("")}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">رفض الإنتاج</h2><button type="button" className="secondary-btn" onClick={()=>setReviewTarget("")}>إغلاق</button></div><label>سبب الرفض<textarea rows={4} value={reviewReason} onChange={e=>setReviewReason(e.target.value)}/></label><div className="form-actions"><button type="button" className="danger-button" disabled={!reviewReason.trim()} onClick={async()=>{try{await api("/api/production/"+reviewTarget+"/reject",{method:"POST",body:JSON.stringify({reason:reviewReason.trim()})});setReviewTarget("");setReviewReason("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر رفض الإنتاج")}}}>تأكيد الرفض</button></div></div></div>}
  <section className="card"><div className="card-header"><h2 className="card-title">سجل الإنتاج</h2><div className="row-actions" style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}><label style={{minWidth:220}}>فلترة حسب العامل<select className="filter-select" value={recordEmployeeFilter} onChange={e=>setRecordEmployeeFilter(e.target.value)}><option value="">كل العمال</option>{employees.map(e=><option key={e.id} value={e.id}>{e.full_name}{e.code?` — ${e.code}`:""}</option>)}</select></label><label>حالة السجل<select className="filter-select" value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات</option><option value="PENDING">معلق</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option><option value="CANCELLED">ملغي</option></select></label></div></div>
   {recordLoading?<div className="empty">جارٍ تحميل سجل الإنتاج...</div>:!recordEntries.length?<div className="empty">{recordEmployeeFilter?"لا توجد سجلات إنتاج للعامل المحدد في هذه الحالة.":"لا يوجد إنتاج مسجل."}</div>:<div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>مسؤول الوردية</th><th>المنتج</th><th>المرحلة</th><th>نوع الإنتاج</th><th>الوردية</th><th>الكمية</th><th>السعر الأساسي</th><th>البونص</th><th>الخصم</th><th>إجمالي المستحق</th><th>الحالة</th><th></th></tr></thead><tbody>{recordEntries.map(x=><tr key={x.id}><td>{String(x.work_date).slice(0,10)}</td><td className="strong">{x.employee_name}</td><td>{x.shift_leader_name||"—"}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.production_type_name||"—"}</td><td>{x.shift_name}</td><td>{formatQuantity(x.quantity)} {x.unit_name}</td><td>{formatMoney(x.earning_amount)}</td><td>{formatMoney(x.bonus_amount||0)}</td><td>{formatMoney(x.deduction_amount||0)}</td><td className="money strong">{formatMoney(x.total_earning_amount??x.earning_amount)}</td><td><span className={"status "+x.status.toLowerCase()}>{statusLabel[x.status]||x.status}</span></td><td>{x.status==="PENDING"&&<div className="row-actions">{has("production.edit")&&<button className="secondary-btn" onClick={()=>editEntry(x)}>تعديل</button>}{has("production.approve")&&<button className="approve-button" onClick={()=>review(x.id,"approve")}>اعتماد</button>}{has("production.reject")&&<button className="reject-button" onClick={()=>review(x.id,"reject")}>رفض</button>}{has("production.edit")&&<button className="danger-button" onClick={()=>{setDeleteTarget(x);setDeletePassword("")}}>حذف</button>}</div>}{x.status==="APPROVED"&&has("production.cancel")&&<button className="danger-button" onClick={()=>{setReverseTarget(x);setReversePassword("");setReverseReason("")}}>التراجع عن العملية</button>}</td></tr>)}</tbody></table></div>}
  </section>
 </section></main></div>;
}
