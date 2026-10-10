"use client";

import { useEffect, useMemo, useState } from "react";
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
type LedgerRow={id:string;code:string;transaction_date:string;direction:"IN"|"OUT";amount:number;description:string;source_type:string;source_label:string;employee_id:string|null;employee_name:string|null;order_id:string|null;order_code:string|null;order_name:string|null;created_by_username:string|null;notes:string|null;is_internal_transfer:boolean};
type LedgerSummary={movement_count:number;total_in:number;total_out:number;net:number;company_income:number;recorded_expenses:number;internal_transfer_in:number;internal_transfer_out:number};

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
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [periods,setPeriods]=useState<AccountingPeriod[]>([]);
  const [selectedPeriodId,setSelectedPeriodId]=useState("");
  const [periodDetail,setPeriodDetail]=useState<PeriodDetail|null>(null);
  const [periodForm,setPeriodForm]=useState({name:"",periodStart:new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10),periodEnd:new Date().toISOString().slice(0,10),notes:""});
  const [periodSaving,setPeriodSaving]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [ledgerRows,setLedgerRows]=useState<LedgerRow[]>([]);
  const [ledgerSummary,setLedgerSummary]=useState<LedgerSummary>({movement_count:0,total_in:0,total_out:0,net:0,company_income:0,recorded_expenses:0,internal_transfer_in:0,internal_transfer_out:0});
  const [ledgerLoading,setLedgerLoading]=useState(false);
  const [ledgerFilters,setLedgerFilters]=useState({from:"",to:"",direction:"",employeeId:"",orderId:"",sourceType:"",q:""});
  const [dashboardPeriodId,setDashboardPeriodId]=useState("");


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
  async function loadLedger(next=ledgerFilters){
    if(!has("finance.ledger.view"))return;
    setLedgerLoading(true);
    try{
      const q=new URLSearchParams();
      if(next.from)q.set("from",next.from);if(next.to)q.set("to",next.to);
      if(next.direction)q.set("direction",next.direction);if(next.employeeId)q.set("employeeId",next.employeeId);
      if(next.orderId)q.set("orderId",next.orderId);if(next.sourceType)q.set("sourceType",next.sourceType);
      if(next.q.trim())q.set("q",next.q.trim());q.set("limit","500");
      const r=await api<{data:LedgerRow[];summary:LedgerSummary}>("/api/accounting/ledger?"+q.toString());
      setLedgerRows(r.data);setLedgerSummary(r.summary);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل الحركة المالية")}finally{setLedgerLoading(false)}
  }
  useEffect(()=>{
    if(!has("finance.ledger.view"))return;
    let active=true;
    api<{data:LedgerRow[];summary:LedgerSummary}>("/api/accounting/ledger?limit=500").then(r=>{if(active){setLedgerRows(r.data);setLedgerSummary(r.summary)}}).catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل سجل الحركة المالية")});
    return()=>{active=false};
  },[has]);
  function chooseDashboardPeriod(id:string){
    setDashboardPeriodId(id);
    const period=periods.find(x=>x.id===id);
    const next={...ledgerFilters,from:period?.period_start||"",to:period?.period_end||""};
    setLedgerFilters(next);void loadLedger(next);
  }

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
    try{
      await api("/api/cash-custody/order-collections",{method:"POST",body:JSON.stringify({orderId:collectionForm.orderId,employeeId:collectionForm.employeeId,amount:Number(collectionForm.amount),description:collectionForm.description.trim(),notes:collectionForm.notes.trim()||null})});
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
  const totalIn=Number(ledgerSummary.total_in||0);
  const totalOut=Number(ledgerSummary.total_out||0);
  const net=Number(ledgerSummary.net||0);

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
      <div className="card">
       <div className="card-header"><div><h2 className="card-title">لوحة الحركة المالية</h2><div className="form-hint">كل حركة مع بيانها والطلبية والموظف والحساب الذي سجّلها. الحركة المرتبطة بالعهدة لا تتكرر في الإجماليات.</div></div><button className="secondary-button" disabled={ledgerLoading} onClick={()=>void loadLedger()}>{ledgerLoading?"جارٍ التحديث...":"تحديث البيانات"}</button></div>
       <div className="form-grid finance-four-grid">
        <label>الفترة المحاسبية<select value={dashboardPeriodId} onChange={e=>chooseDashboardPeriod(e.target.value)}><option value="">كل الفترات / تحديد يدوي</option>{periods.map(p=><option key={p.id} value={p.id}>{p.name} — {p.status==="CLOSED"?"مقفلة":"مفتوحة"}</option>)}</select></label>
        <label>من تاريخ<input type="date" value={ledgerFilters.from} onChange={e=>{setDashboardPeriodId("");setLedgerFilters(v=>({...v,from:e.target.value}))}}/></label>
        <label>إلى تاريخ<input type="date" value={ledgerFilters.to} onChange={e=>{setDashboardPeriodId("");setLedgerFilters(v=>({...v,to:e.target.value}))}}/></label>
        <label>نوع الحركة<select value={ledgerFilters.direction} onChange={e=>setLedgerFilters(v=>({...v,direction:e.target.value}))}><option value="">الداخل والخارج</option><option value="IN">داخل</option><option value="OUT">خارج</option></select></label>
        <label>الموظف / صاحب العهدة<select value={ledgerFilters.employeeId} onChange={e=>setLedgerFilters(v=>({...v,employeeId:e.target.value}))}><option value="">كل الموظفين</option>{employees.map(x=><option key={x.id} value={x.id}>{x.full_name} — {x.code}</option>)}</select></label>
        <label>الطلبية<select value={ledgerFilters.orderId} onChange={e=>setLedgerFilters(v=>({...v,orderId:e.target.value}))}><option value="">كل الطلبيات</option>{orders.map(x=><option key={x.id} value={x.id}>{orderLabel(x)}</option>)}</select></label>
        <label>مصدر الحركة<select value={ledgerFilters.sourceType} onChange={e=>setLedgerFilters(v=>({...v,sourceType:e.target.value}))}><option value="">كل المصادر</option><option value="ORDER_REVENUE">تحصيلات وإيرادات الطلبيات</option><option value="ACCOUNTING_EXPENSE">المصروفات</option><option value="CUSTODY_TRANSFER">تحويل بين العهد</option><option value="CASH_CUSTODY">حركة عهدة يدوية</option><option value="MANAGER_TOPUP">توريد من المدير المالي</option></select></label>
        <label>بحث في البيان / الكود / الحساب<input value={ledgerFilters.q} onChange={e=>setLedgerFilters(v=>({...v,q:e.target.value}))} placeholder="اسم الموظف أو البيان أو الكود"/></label>
       </div>
       <div className="form-actions"><button className="primary-button" disabled={ledgerLoading} onClick={()=>void loadLedger()}>{ledgerLoading?"جارٍ البحث...":"تطبيق الفلاتر"}</button><button className="secondary-button" onClick={()=>{const next={from:"",to:"",direction:"",employeeId:"",orderId:"",sourceType:"",q:""};setDashboardPeriodId("");setLedgerFilters(next);void loadLedger(next)}}>مسح الفلاتر</button></div>
      </div>
      <div className="stats finance-stats">
       <article className="card stat accent"><div className="stat-label">إجمالي الداخل</div><div className="stat-value">{n(totalIn)}</div><div className="stat-note">{Number(ledgerSummary.movement_count||0).toLocaleString("ar-EG")} حركة حسب الفلاتر</div></article>
       <article className="card stat warning"><div className="stat-label">إجمالي الخارج</div><div className="stat-value">{n(totalOut)}</div><div className="stat-note">يشمل المصروفات والحركات الخارجة</div></article>
       <article className="card stat"><div className="stat-label">صافي الحركة</div><div className="stat-value">{n(net)}</div><div className="stat-note">الداخل − الخارج</div></article>
       <article className="card stat neutral"><div className="stat-label">إيراد الشركة المسجل</div><div className="stat-value">{n(Number(ledgerSummary.company_income||0))}</div><div className="stat-note">لا يشمل التحويلات بين العهد</div></article>
      </div>
      <div className="stats finance-stats">
       <article className="card stat"><div className="stat-label">المصروفات المسجلة</div><div className="stat-value">{n(Number(ledgerSummary.recorded_expenses||0))}</div></article>
       <article className="card stat"><div className="stat-label">تحويلات داخلة بين العهد</div><div className="stat-value">{n(Number(ledgerSummary.internal_transfer_in||0))}</div></article>
       <article className="card stat"><div className="stat-label">تحويلات خارجة بين العهد</div><div className="stat-value">{n(Number(ledgerSummary.internal_transfer_out||0))}</div></article>
       <article className="card stat"><div className="stat-label">الفترات المحاسبية</div><div className="stat-value">{periods.length.toLocaleString("ar-EG")}</div><div className="stat-note">مفتوحة: {periods.filter(p=>p.status==="OPEN").length.toLocaleString("ar-EG")} · مقفلة: {periods.filter(p=>p.status==="CLOSED").length.toLocaleString("ar-EG")}</div></article>
      </div>
      <section className="card"><div className="card-header"><div><h2 className="card-title">سجل الداخل والخارج بالتفصيل</h2><div className="form-hint">البيان والمصدر والطلبية والموظف واسم الحساب المسجّل.</div></div><span className="count-badge">{ledgerRows.length.toLocaleString("ar-EG")}</span></div>
       <div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الكود</th><th>نوع الحركة</th><th>البيان</th><th>الطلبية</th><th>الموظف / العهدة</th><th>المبلغ</th><th>الحساب المسجّل</th></tr></thead><tbody>
        {ledgerRows.map(x=><tr key={x.id}><td>{new Date(x.transaction_date).toLocaleDateString("ar-EG")}</td><td className="mono">{x.code}</td><td><span className={"status "+(x.direction==="IN"?"approved":"pending")}>{x.direction==="IN"?"داخل":"خارج"}</span><div className="form-hint">{x.source_label}</div></td><td><strong>{x.description||"—"}</strong>{x.notes&&<div className="form-hint">{x.notes}</div>}</td><td>{x.order_code?x.order_code+" — "+(x.order_name||""):"—"}</td><td>{x.employee_name||"—"}</td><td className="money">{x.direction==="OUT"?"− ":"+ "}{n(Number(x.amount))}</td><td>{x.created_by_username||"حساب غير متاح"}</td></tr>)}
        {!ledgerRows.length&&<tr><td colSpan={8}>{ledgerLoading?"جارٍ تحميل الحركات...":"لا توجد حركات مطابقة للفلاتر الحالية."}</td></tr>}
       </tbody></table></div>
      </section>
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
        <div className="table-wrap"><table><thead><tr><th>المصروف</th><th>الطلبية</th><th>المبلغ الموزع</th></tr></thead><tbody>{periodDetail.allocations.map((a,i)=><tr key={a.id}><td>{a.expense_code} — {a.expense_description}</td><td>{a.order_code} — {a.order_name}</td><td><input type="number" min="0" step="0.01" disabled={periodDetail.period.status==="CLOSED"} value={a.amount} onChange={e=>setPeriodDetail(d=>d?({...d,allocations:d.allocations.map((x,j)=>j===i?({...x,amount:Number(e.target.value)}):x)}):d)}/></td></tr>)}{!periodDetail.allocations.length&&<tr><td colSpan={3}>اضغط «توزيع تلقائي» لإنشاء التوزيع الافتراضي أولًا.</td></tr>}</tbody></table></div>
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
