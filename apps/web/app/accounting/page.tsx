"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Order = { id: string; code: string; order_name: string; status?: string };
type Profit = {
  order: { id: string; code: string; order_name: string; customer_name: string | null; status: string };
  revenue: number; expenses: number; administrativeAllocation?: number; materialCost: number; laborCost: number; totalCost: number; profit: number; marginPercent: number | null;
};
type Employee = {id:string;full_name:string;code:string};
type AccountingPeriod = {id:string;code:string;name:string;period_start:string;period_end:string;status:"OPEN"|"CLOSED";allocation_count:number;allocated_amount:number};
type PeriodExpense = {id:string;code:string;category:string;description:string;amount:number;expense_date:string};
type PeriodAllocation = {id:string;expense_id:string;order_id:string;amount:number;expense_code:string;expense_description:string;order_code:string;order_name:string};
type PeriodDetail = {period:AccountingPeriod;expenses:PeriodExpense[];allocations:PeriodAllocation[];orders:Order[]};
type Expense = { id: string; code: string; order_code: string | null; category: string; description: string; amount: number; expense_date: string; expense_type?: "DIRECT"|"ADMINISTRATIVE"; paid_from_employee_id?: string|null };
type Revenue = { id: string; code: string; order_code: string | null; order_name?: string | null; amount: number; revenue_date: string; source: string; notes?: string | null };

const orderLabel=(o:Order)=>o.code+" — "+o.order_name;
const revenueSourceLabel=(source:string)=>(({ "CUSTOMER_COLLECTION":"تحصيل من عميل","MANUAL":"إيراد مسجل يدويًا","BANK_TRANSFER":"تحويل بنكي","OTHER":"إيراد آخر" } as Record<string,string>)[source]||source);

export default function AccountingPage() {
  const { has } = usePermissions();
  const [tab,setTab]=useState<"dashboard"|"in"|"out"|"profitability"|"periods">("dashboard");
  const [orders,setOrders]=useState<Order[]>([]);
  const [orderId,setOrderId]=useState("");
  const [profit,setProfit]=useState<Profit|null>(null);
  const [expenses,setExpenses]=useState<Expense[]>([]);
  const [revenues,setRevenues]=useState<Revenue[]>([]);
  const [eForm,setEForm]=useState({category:"تشغيل",description:"",amount:"",orderId:"",expenseType:"DIRECT" as "DIRECT"|"ADMINISTRATIVE",paidFromEmployeeId:""});
  const [rForm,setRForm]=useState({orderId:"",amount:"",source:"MANUAL",notes:""});
  const [collectionForm,setCollectionForm]=useState({orderId:"",employeeId:"",amount:"",description:"تحصيل من العميل",notes:""});
  const collectionIdempotency=useRef<{fingerprint:string;key:string}|null>(null);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [periods,setPeriods]=useState<AccountingPeriod[]>([]);
  const [selectedPeriodId,setSelectedPeriodId]=useState("");
  const [periodDetail,setPeriodDetail]=useState<PeriodDetail|null>(null);
  const [periodForm,setPeriodForm]=useState({name:"",periodStart:new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10),periodEnd:new Date().toISOString().slice(0,10),notes:""});
  const [periodSaving,setPeriodSaving]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  async function load() {
    setError("");
    try {
      const [o,e,r]=await Promise.all([
        api<{data:Order[]}>("/api/orders"),
        api<{data:Expense[]}>("/api/accounting/expenses"),
        api<{data:Revenue[]}>("/api/accounting/revenues")
      ]);
      setOrders(o.data);setExpenses(e.data);setRevenues(r.data);
    } catch(e) { setError(e instanceof Error?e.message:"تعذر تحميل المالية"); }
  }
  useEffect(()=>{void load()},[]);
  useEffect(()=>{
    let active=true;
    api<{data:Employee[]}>("/api/custodies/eligible-employees").then(r=>{if(active)setEmployees(r.data)}).catch(()=>{});
    if(has("finance.period_close.view"))api<{data:AccountingPeriod[]}>("/api/accounting/periods").then(r=>{if(active)setPeriods(r.data)}).catch(()=>{});
    return()=>{active=false};
  },[has]);
  async function loadPeriods(){
    if(!has("finance.period_close.view"))return;
    try{setPeriods((await api<{data:AccountingPeriod[]}>("/api/accounting/periods")).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل فترات التصفية")}
  }
  async function loadPeriodDetail(id:string){
    setSelectedPeriodId(id);setPeriodDetail(null);if(!id)return;
    try{setPeriodDetail((await api<{data:PeriodDetail}>("/api/accounting/periods/"+id)).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل تفاصيل التصفية")}
  }
  async function createPeriod(){
    setError("");setMessage("");
    try{
      const r=await api<{data:AccountingPeriod}>("/api/accounting/periods",{method:"POST",body:JSON.stringify(periodForm)});
      setPeriodForm(v=>({...v,name:"",notes:""}));await loadPeriods();await loadPeriodDetail(r.data.id);setMessage("تم إنشاء فترة التصفية");
    }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء فترة التصفية")}
  }
  async function autoAllocate(){
    if(!selectedPeriodId)return;setPeriodSaving(true);setError("");setMessage("");
    try{await api("/api/accounting/periods/"+selectedPeriodId+"/auto-allocate",{method:"POST",body:"{}"});await loadPeriodDetail(selectedPeriodId);await loadPeriods();setMessage("تم توزيع المصروفات الإدارية حسب تكلفة الطلبيات، ويمكنك تعديل التوزيع قبل الإقفال");}
    catch(e){setError(e instanceof Error?e.message:"تعذر توزيع المصروفات الإدارية")}finally{setPeriodSaving(false)}
  }
  async function saveAllocations(){
    if(!selectedPeriodId||!periodDetail)return;setPeriodSaving(true);setError("");setMessage("");
    try{
      await api("/api/accounting/periods/"+selectedPeriodId+"/allocations",{method:"PUT",body:JSON.stringify({allocations:periodDetail.allocations.map(a=>({expenseId:a.expense_id,orderId:a.order_id,amount:Number(a.amount)}))})});
      await loadPeriodDetail(selectedPeriodId);setMessage("تم حفظ توزيع المصروفات");
    }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ توزيع المصروفات")}finally{setPeriodSaving(false)}
  }
  async function closePeriod(){
    if(!selectedPeriodId||!periodDetail)return;
    if(!window.confirm("تأكيد إقفال الفترة؟ لن يمكن تعديل التوزيع بعدها."))return;
    setPeriodSaving(true);setError("");setMessage("");
    try{await api("/api/accounting/periods/"+selectedPeriodId+"/close",{method:"POST",body:"{}"});await loadPeriodDetail(selectedPeriodId);await loadPeriods();setMessage("تم إقفال الفترة المالية بنجاح")}
    catch(e){setError(e instanceof Error?e.message:"تعذر إقفال الفترة")}finally{setPeriodSaving(false)}
  }

  async function loadProfit(id:string) {
    setOrderId(id);setProfit(null);if(!id)return;
    try{const x=await api<{data:Profit}>(`/api/accounting/orders/${id}/profitability`);setProfit(x.data)}
    catch(e){setError(e instanceof Error?e.message:"تعذر تحميل ربحية الطلبية")}
  }

  async function addExpense() {
    setError("");setMessage("");
    try {
      await api("/api/accounting/expenses",{method:"POST",body:JSON.stringify({orderId:eForm.expenseType==="ADMINISTRATIVE"?null:(eForm.orderId||null),category:eForm.category,description:eForm.description,amount:Number(eForm.amount),expenseType:eForm.expenseType,paidFromEmployeeId:eForm.paidFromEmployeeId||null})});
      setEForm(v=>({...v,description:"",amount:""}));setMessage("تم تسجيل المصروف"+(eForm.paidFromEmployeeId?" وتم خصمه من عهدة الموظف":""));await load();if(orderId)await loadProfit(orderId);
    } catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المصروف")}
  }

  async function addOrderCollection(){
    setError("");setMessage("");
    if(!collectionForm.orderId||!collectionForm.employeeId||!collectionForm.amount||!collectionForm.description.trim()){
      setError("اختر الطلبية والموظف واكتب المبلغ والبيان");return;
    }
    const payload={orderId:collectionForm.orderId,employeeId:collectionForm.employeeId,amount:Number(collectionForm.amount),description:collectionForm.description.trim(),notes:collectionForm.notes.trim()||null};
    const fingerprint=JSON.stringify(payload);
    if(!collectionIdempotency.current||collectionIdempotency.current.fingerprint!==fingerprint){
      collectionIdempotency.current={fingerprint,key:crypto.randomUUID()};
    }
    try{
      await api("/api/cash-custody/order-collections",{method:"POST",body:JSON.stringify({...payload,idempotencyKey:collectionIdempotency.current.key})});
      collectionIdempotency.current=null;
      setCollectionForm(v=>({...v,amount:"",notes:""}));setMessage("تم تسجيل تحصيل العميل كإيراد للطلبية ووارد في عهدة الموظف");await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل التحصيل")}
  }

  async function addRevenue() {
    setError("");setMessage("");
    try {
      await api("/api/accounting/revenues",{method:"POST",body:JSON.stringify({orderId:rForm.orderId||null,amount:Number(rForm.amount),source:rForm.source,notes:rForm.notes||null})});
      setRForm(v=>({...v,amount:"",notes:""}));setMessage("تم تسجيل الإيراد");await load();if(orderId)await loadProfit(orderId);
    } catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الإيراد")}
  }

  const activeOrders=useMemo(()=>orders.filter(o=>o.status!=="COMPLETED"&&o.status!=="CANCELLED"),[orders]);
  const n=(x:number|null|undefined)=>Number(x||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2});
  const totalIn=useMemo(()=>revenues.reduce((s,x)=>s+Number(x.amount||0),0),[revenues]);
  const totalOut=useMemo(()=>expenses.reduce((s,x)=>s+Number(x.amount||0),0),[expenses]);
  const net=totalIn-totalOut;

  return <div className="app-shell">
   <Sidebar active="/accounting"/>
   <main className="main">
    <header className="topbar"><div><h1 className="page-title">المالية</h1><p className="page-subtitle">لوحة مالية واضحة: الداخل، الخارج، وربحية كل طلبية.</p></div></header>
    <section className="content">
     {error&&<div className="alert error">{error}</div>}
     {message&&<div className="success-box">{message}</div>}

     <div className="tabs finance-tabs">
      <button className={"tab "+(tab==="dashboard"?"active":"")} onClick={()=>setTab("dashboard")}>الرئيسية المالية</button>
      <button className={"tab "+(tab==="in"?"active":"")} onClick={()=>setTab("in")}>الداخل</button>
      <button className={"tab "+(tab==="out"?"active":"")} onClick={()=>setTab("out")}>الخارج</button>
      <button className={"tab "+(tab==="profitability"?"active":"")} onClick={()=>setTab("profitability")}>ربحية الطلبات</button>
      {has("finance.period_close.view")&&<button className={"tab "+(tab==="periods"?"active":"")} onClick={()=>{setTab("periods");void loadPeriods()}}>تصفية الفترة</button>}
     </div>

     {tab==="dashboard"&&<>
      <div className="stats finance-stats">
       <article className="card stat accent"><div className="stat-label">إجمالي الداخل</div><div className="stat-value">{n(totalIn)}</div><div className="stat-note">{revenues.length} حركة إيراد محملة</div></article>
       <article className="card stat warning"><div className="stat-label">إجمالي الخارج</div><div className="stat-value">{n(totalOut)}</div><div className="stat-note">{expenses.length} حركة مصروف محملة</div></article>
       <article className="card stat"><div className="stat-label">الصافي</div><div className="stat-value">{n(net)}</div><div className="stat-note">الداخل − الخارج</div></article>
       <article className="card stat neutral"><div className="stat-label">الطلبات</div><div className="stat-value">{orders.length}</div><div className="stat-note">متاحة للتحليل المالي</div></article>
      </div>
      <div className="grid">
       <section className="card"><div className="card-header"><h2 className="card-title">آخر الداخل</h2><button className="link-button" onClick={()=>setTab("in")}>عرض الكل</button></div>
        <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>المصدر</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>
         {revenues.slice(0,8).map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code||"عام"}</td><td>{revenueSourceLabel(x.source)}</td><td className="money">{n(x.amount)}</td><td>{x.revenue_date}</td></tr>)}
         {!revenues.length&&<tr><td colSpan={5}>لا توجد إيرادات.</td></tr>}
        </tbody></table></div>
       </section>
       <section className="card"><div className="card-header"><h2 className="card-title">آخر الخارج</h2><button className="link-button" onClick={()=>setTab("out")}>عرض الكل</button></div>
        <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>التصنيف</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>
         {expenses.slice(0,8).map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code||"عام"}</td><td>{x.category}</td><td className="money">{n(x.amount)}</td><td>{x.expense_date}</td></tr>)}
         {!expenses.length&&<tr><td colSpan={5}>لا توجد مصروفات.</td></tr>}
        </tbody></table></div>
       </section>
      </div>
     </>}

     {tab==="in"&&<section className="card">
      <div className="card-header"><div><h2 className="card-title">الداخل — الإيرادات</h2><div className="form-hint">الإيرادات المرتبطة بالطلبات والواردات العامة أو الإدارية من المدير المالي.</div></div></div>
      {(has("cash_custody.create")||has("cash_custody.create_own"))&&<section className="card nested-card">
       <div className="card-header"><div><h3 className="card-title">تحصيل عميل على عهدة موظف</h3><div className="form-hint">يسجل إيراد الطلبية ووارد العهدة في حركة واحدة، من غير تكرار عند تحويل الأموال لاحقًا.</div></div></div>
       <div className="form-grid finance-four-grid">
        <label>الطلبية<select value={collectionForm.orderId} onChange={e=>setCollectionForm({...collectionForm,orderId:e.target.value})}><option value="">اختر الطلبية</option>{orders.map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}</select></label>
        <label>الموظف المستلم<select value={collectionForm.employeeId} onChange={e=>setCollectionForm({...collectionForm,employeeId:e.target.value})}><option value="">اختر الموظف</option>{employees.map(e=><option key={e.id} value={e.id}>{e.full_name}</option>)}</select></label>
        <label>المبلغ<input type="number" min="0.01" step="0.01" value={collectionForm.amount} onChange={e=>setCollectionForm({...collectionForm,amount:e.target.value})}/></label>
        <label>البيان<input value={collectionForm.description} onChange={e=>setCollectionForm({...collectionForm,description:e.target.value})}/></label>
        <label>ملاحظات اختيارية<input value={collectionForm.notes} onChange={e=>setCollectionForm({...collectionForm,notes:e.target.value})}/></label>
       </div>
       <div className="form-actions"><button className="primary-button" onClick={addOrderCollection}>تسجيل التحصيل وإضافته للعهدة</button></div>
      </section>}
      {has("finance.revenues.create")&&<div className="form-grid finance-four-grid">
       <label>الطلبية <span className="optional">اختياري</span><select value={rForm.orderId} onChange={e=>setRForm({...rForm,orderId:e.target.value})}><option value="">وارد عام / إداري</option>{activeOrders.map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}</select></label>
       <label>المبلغ<input type="number" min="0.01" step="0.01" value={rForm.amount} onChange={e=>setRForm({...rForm,amount:e.target.value})}/></label>
       <label>المصدر<input value={rForm.source} onChange={e=>setRForm({...rForm,source:e.target.value})}/></label>
       <label>ملاحظات<input value={rForm.notes} onChange={e=>setRForm({...rForm,notes:e.target.value})}/></label>
      </div>}
      {has("finance.revenues.create")&&<div className="form-actions"><button className="primary-button" onClick={addRevenue}>تسجيل الإيراد</button></div>}
      <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>المصدر</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>{revenues.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code}</td><td>{revenueSourceLabel(x.source)}</td><td className="money">{n(x.amount)}</td><td>{x.revenue_date}</td></tr>)}{!revenues.length&&<tr><td colSpan={5}>لا توجد إيرادات.</td></tr>}</tbody></table></div>
     </section>}

     {tab==="out"&&<section className="card">
      <div className="card-header"><div><h2 className="card-title">الخارج — المصروفات</h2><div className="form-hint">المصروفات العامة والمصروفات المرتبطة بالطلبات.</div></div></div>
      {has("finance.expenses.create")&&<div className="form-grid finance-four-grid">
       <label>نوع المصروف<select value={eForm.expenseType} onChange={e=>setEForm({...eForm,expenseType:e.target.value as "DIRECT"|"ADMINISTRATIVE",orderId:e.target.value==="ADMINISTRATIVE"?"":eForm.orderId})}><option value="DIRECT">مصروف مباشر</option><option value="ADMINISTRATIVE">مصروف إداري — يوزع وقت التصفية</option></select></label>
       {eForm.expenseType==="DIRECT"&&<label>الطلبية <span className="optional">اختياري</span><select value={eForm.orderId} onChange={e=>setEForm({...eForm,orderId:e.target.value})}><option value="">مصروف عام</option>{activeOrders.map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}</select></label>}
       <label>الدفع من عهدة موظف <span className="optional">اختياري</span><select value={eForm.paidFromEmployeeId} onChange={e=>setEForm({...eForm,paidFromEmployeeId:e.target.value})}><option value="">ليس من عهدة موظف</option>{employees.map(e=><option key={e.id} value={e.id}>{e.full_name}</option>)}</select></label>
       <label>التصنيف<input value={eForm.category} onChange={e=>setEForm({...eForm,category:e.target.value})}/></label>
       <label>الوصف<input value={eForm.description} onChange={e=>setEForm({...eForm,description:e.target.value})}/></label>
       <label>المبلغ<input type="number" min="0.01" step="0.01" value={eForm.amount} onChange={e=>setEForm({...eForm,amount:e.target.value})}/></label>
      </div>}
      {has("finance.expenses.create")&&<div className="form-actions"><button className="primary-button" onClick={addExpense}>تسجيل المصروف</button></div>}
      <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>التصنيف</th><th>الوصف</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>{expenses.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code||"عام"}</td><td>{x.category}</td><td>{x.description}</td><td className="money">{n(x.amount)}</td><td>{x.expense_date}</td></tr>)}{!expenses.length&&<tr><td colSpan={6}>لا توجد مصروفات.</td></tr>}</tbody></table></div>
     </section>}

     {tab==="periods"&&has("finance.period_close.view")&&<section className="card">
      <div className="card-header"><div><h2 className="card-title">تصفية وإقفال الفترة المالية</h2><div className="form-hint">المصروفات الإدارية تتجمع خلال الفترة، ثم توزع افتراضيًا بنسبة تكلفة كل طلبية. تقدر تعدل التوزيع قبل الإقفال.</div></div></div>
      {has("finance.period_close.create")&&<div className="card-body">
       <h3 className="card-title">إنشاء فترة جديدة</h3>
       <div className="form-grid finance-four-grid">
        <label>اسم الفترة<input value={periodForm.name} onChange={e=>setPeriodForm({...periodForm,name:e.target.value})} placeholder="مثال: تصفية أكتوبر ٢٠٢٦"/></label>
        <label>من تاريخ<input type="date" value={periodForm.periodStart} onChange={e=>setPeriodForm({...periodForm,periodStart:e.target.value})}/></label>
        <label>إلى تاريخ<input type="date" value={periodForm.periodEnd} onChange={e=>setPeriodForm({...periodForm,periodEnd:e.target.value})}/></label>
        <label>ملاحظات<input value={periodForm.notes} onChange={e=>setPeriodForm({...periodForm,notes:e.target.value})}/></label>
       </div>
       <div className="form-actions"><button className="primary-button" onClick={createPeriod}>إنشاء الفترة</button></div>
      </div>}
      <div className="card-body">
       <label className="finance-select">الفترة المسجلة<select value={selectedPeriodId} onChange={e=>void loadPeriodDetail(e.target.value)}><option value="">اختر فترة مالية</option>{periods.map(p=><option key={p.id} value={p.id}>{p.name} — {p.period_start} إلى {p.period_end} — {p.status==="CLOSED"?"مقفلة":"مفتوحة"}</option>)}</select></label>
       {periodDetail&&<>
        <div className="detail-grid finance-detail"><div><b>الفترة</b><span>{periodDetail.period.name}</span></div><div><b>المصروفات الإدارية</b><span>{n(periodDetail.expenses.reduce((s,x)=>s+Number(x.amount),0))}</span></div><div><b>الموزع</b><span>{n(periodDetail.allocations.reduce((s,x)=>s+Number(x.amount),0))}</span></div><div><b>الحالة</b><span>{periodDetail.period.status==="CLOSED"?"مقفلة":"مفتوحة"}</span></div></div>
        <h3 className="card-title">المصروفات الإدارية داخل الفترة</h3>
        <div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الكود</th><th>التصنيف</th><th>البيان</th><th>القيمة</th></tr></thead><tbody>{periodDetail.expenses.map(x=><tr key={x.id}><td>{x.expense_date}</td><td className="mono">{x.code}</td><td>{x.category}</td><td>{x.description}</td><td className="money">{n(x.amount)}</td></tr>)}{!periodDetail.expenses.length&&<tr><td colSpan={5}>لا توجد مصروفات إدارية في الفترة المحددة.</td></tr>}</tbody></table></div>
        <div className="card-header"><div><h3 className="card-title">توزيع المصروفات على الطلبيات</h3><div className="form-hint">عدّل المبالغ يدويًا إذا لزم الأمر، مع الحفاظ على إجمالي كل مصروف مساويًا لقيمته الأصلية.</div></div></div>
        <div className="detail-grid finance-detail"><div><b>إجمالي المصروفات</b><span>{n(periodDetail.expenses.reduce((s,x)=>s+Number(x.amount),0))}</span></div><div><b>إجمالي الموزع</b><span>{n(periodDetail.allocations.reduce((s,x)=>s+Number(x.amount),0))}</span></div><div><b>المتبقي</b><span>{n(periodDetail.expenses.reduce((s,x)=>s+Number(x.amount),0)-periodDetail.allocations.reduce((s,x)=>s+Number(x.amount),0))}</span></div></div>
        <div className="table-wrap"><table><thead><tr><th>المصروف</th><th>الطلبية المستفيدة</th><th>المبلغ الموزع</th><th>إجراء</th></tr></thead><tbody>{periodDetail.allocations.map((a,i)=><tr key={a.id}><td>{a.expense_code} — {a.expense_description}</td><td><select disabled={periodDetail.period.status==="CLOSED"} value={a.order_id} onChange={e=>{const order=periodDetail.orders.find(o=>o.id===e.target.value);setPeriodDetail(d=>d?({...d,allocations:d.allocations.map((x,j)=>j===i?({...x,order_id:e.target.value,order_code:order?.code||"",order_name:order?.order_name||""}):x)}):d)}}>{periodDetail.orders.map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}</select></td><td><input type="number" min="0" step="0.01" disabled={periodDetail.period.status==="CLOSED"} value={a.amount} onChange={e=>setPeriodDetail(d=>d?({...d,allocations:d.allocations.map((x,j)=>j===i?({...x,amount:Number(e.target.value)}):x)}):d)}/></td><td><button type="button" className="secondary-button" disabled={periodDetail.period.status==="CLOSED"} onClick={()=>setPeriodDetail(d=>d?({...d,allocations:d.allocations.filter((_,j)=>j!==i)}):d)}>حذف</button></td></tr>)}{!periodDetail.allocations.length&&<tr><td colSpan={4}>لم يتم إنشاء صفوف توزيع بعد. أضف توزيعًا لكل مصروف أو استخدم التوزيع التلقائي.</td></tr>}</tbody></table></div>
        {periodDetail.period.status==="OPEN"&&has("finance.period_close.create")&&periodDetail.expenses.length>0&&<div className="form-actions" style={{flexWrap:"wrap"}}>{periodDetail.expenses.map(expense=><button key={expense.id} type="button" className="secondary-button" disabled={periodSaving||!periodDetail.orders.length} onClick={()=>setPeriodDetail(d=>{if(!d)return d;const order=d.orders[0];if(!order)return d;return {...d,allocations:[...d.allocations,{id:"draft-"+crypto.randomUUID(),expense_id:expense.id,order_id:order.id,amount:0,expense_code:expense.code,expense_description:expense.description,order_code:order.code,order_name:order.order_name}]}})}>إضافة توزيع: {expense.code}</button>)}</div>}
        {periodDetail.period.status==="OPEN"&&has("finance.period_close.create")&&<div className="form-actions">
         <button className="secondary-button" disabled={periodSaving||!periodDetail.expenses.length} onClick={autoAllocate}>توزيع تلقائي حسب التكلفة</button>
         <button className="secondary-button" disabled={periodSaving||!periodDetail.allocations.length} onClick={saveAllocations}>حفظ التوزيع المعدّل</button>
         <button className="primary-button" disabled={periodSaving||(periodDetail.expenses.length>0&&!periodDetail.allocations.length)} onClick={closePeriod}>إقفال الفترة</button>
        </div>}
       </>}
      </div>
     </section>}
     {tab==="profitability"&&<section className="card">
      <div className="card-header"><div><h2 className="card-title">ربحية الطلبية</h2><div className="form-hint">الإيراد − تكلفة المخزون − أجور الإنتاج − المصروفات المباشرة.</div></div></div>
      <div className="card-body"><label className="finance-select">الطلبية<select value={orderId} onChange={e=>void loadProfit(e.target.value)}><option value="">اختر الطلبية</option>{activeOrders.map(o=><option key={o.id} value={o.id}>{orderLabel(o)}</option>)}</select></label>
      {profit&&<><div className="stats finance-stats"><article className="card stat"><div className="stat-label">الإيراد</div><div className="stat-value">{n(profit.revenue)}</div></article><article className="card stat warning"><div className="stat-label">تكلفة المخزون</div><div className="stat-value">{n(profit.materialCost)}</div></article><article className="card stat neutral"><div className="stat-label">أجور الإنتاج</div><div className="stat-value">{n(profit.laborCost)}</div></article><article className="card stat accent"><div className="stat-label">صافي الربح</div><div className="stat-value">{n(profit.profit)}</div><div className="stat-note">{profit.marginPercent==null?"—":"هامش "+n(profit.marginPercent)+"%"}</div></article></div>
       <div className="detail-grid finance-detail"><div><b>إجمالي التكلفة</b><span>{n(profit.totalCost)}</span></div><div><b>المصروفات والتوزيع الإداري</b><span>{n(profit.expenses)}</span></div><div><b>نصيب المصروفات الإدارية</b><span>{n(profit.administrativeAllocation||0)}</span></div><div><b>حالة الطلب</b><span>{profit.order.status}</span></div></div></>}
      </div>
     </section>}
    </section>
   </main>
  </div>;
}
