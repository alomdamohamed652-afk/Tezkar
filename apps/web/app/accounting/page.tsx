"use client";

import {useEffect,useState} from "react";
import {api,ApiError} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type Profit={order:{id:string;code:string;order_name:string;customer_name:string|null;status:string};revenue:number;expenses:number;materialCost:number;laborCost:number;totalCost:number;profit:number;marginPercent:number|null};
type Expense={id:string;code:string;order_code:string|null;category:string;description:string;amount:number;expense_date:string};
type Revenue={id:string;code:string;order_code:string;amount:number;revenue_date:string;source:string};

export default function AccountingPage(){
 const {has}=usePermissions();
 const [orderId,setOrderId]=useState(""),[orders,setOrders]=useState<Array<{id:string;code:string;order_name:string}>>([]),[profit,setProfit]=useState<Profit|null>(null);
 const [expenses,setExpenses]=useState<Expense[]>([]),[revenues,setRevenues]=useState<Revenue[]>([]);
 const [eForm,setEForm]=useState({category:"تشغيل",description:"",amount:"",orderId:""}),[rForm,setRForm]=useState({orderId:"",amount:"",source:"MANUAL",notes:""});
 const [error,setError]=useState(""),[message,setMessage]=useState("");

 async function load(){
  try{
   const [o,e,r]=await Promise.all([api<{data:Array<{id:string;code:string;order_name:string}>>}("/api/orders"),api<{data:Expense[]}>("/api/accounting/expenses"),api<{data:Revenue[]}>("/api/accounting/revenues")]);
   setOrders(o.data);setExpenses(e.data);setRevenues(r.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل المالية")}
 }
 useEffect(()=>{void load()},[]);
 async function loadProfit(id:string){
  setOrderId(id);setProfit(null);if(!id)return;
  try{const x=await api<{data:Profit}>("/api/accounting/orders/"+id+"/profitability");setProfit(x.data)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تحميل ربحية الطلبية")}
 }
 async function addExpense(){
  try{await api("/api/accounting/expenses",{method:"POST",body:JSON.stringify({orderId:eForm.orderId||null,category:eForm.category,description:eForm.description,amount:Number(eForm.amount)})});setEForm(v=>({...v,description:"",amount:""}));setMessage("تم تسجيل المصروف");await load();if(orderId)await loadProfit(orderId)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المصروف")}
 }
 async function addRevenue(){
  try{await api("/api/accounting/revenues",{method:"POST",body:JSON.stringify({orderId:rForm.orderId,amount:Number(rForm.amount),source:rForm.source,notes:rForm.notes||null})});setRForm(v=>({...v,amount:"",notes:""}));setMessage("تم تسجيل الإيراد");await load();if(orderId)await loadProfit(orderId)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الإيراد")}
 }
 const n=(x:number|null|undefined)=>Number(x||0).toLocaleString("ar-EG",{maximumFractionDigits:2});
 return <div className="app-shell"><Sidebar active="/accounting"/><main className="main"><header className="topbar"><div><h1 className="page-title">المالية وربحية الطلبات</h1><p className="page-subtitle">اربط الإيرادات والمصروفات بتكلفة المخزون وأجور الإنتاج لمعرفة نتيجة كل طلبية.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}{message&&<div className="success-box">{message}</div>}
  <section className="card"><div className="card-header"><div><h2 className="card-title">ربحية الطلبية</h2><div className="form-hint">التكلفة تجمع أجور الإنتاج المعتمدة، وتكلفة خروج المخزون، والمصروفات المباشرة على الطلب.</div></div></div><div className="card-body"><label className="finance-select">الطلبية<select value={orderId} onChange={e=>void loadProfit(e.target.value)}><option value="">اختر الطلبية</option>{orders.map(o=><option key={o.id} value={o.id}>{o.code} — {o.order_name}</option>)}</select></label>{profit&&<><div className="stats finance-stats"><article className="card stat"><div className="stat-label">الإيراد</div><div className="stat-value">{n(profit.revenue)}</div></article><article className="card stat warning"><div className="stat-label">تكلفة الخروج المخزني</div><div className="stat-value">{n(profit.materialCost)}</div></article><article className="card stat neutral"><div className="stat-label">أجور الإنتاج</div><div className="stat-value">{n(profit.laborCost)}</div></article><article className="card stat accent"><div className="stat-label">صافي الربح</div><div className="stat-value">{n(profit.profit)}</div><div className="stat-note">{profit.marginPercent==null?"—":"هامش "+n(profit.marginPercent)+"%"}</div></article></div><div className="detail-grid finance-detail"><div><b>إجمالي التكلفة</b><span>{n(profit.totalCost)}</span></div><div><b>مصروفات مباشرة</b><span>{n(profit.expenses)}</span></div><div><b>حالة الطلب</b><span>{profit.order.status}</span></div></div></>}</div></section>

  {has("finance.expenses.create")&&<section className="card finance-two-col"><div className="card-header"><h2 className="card-title">تسجيل مصروف</h2></div><div className="form-grid"><label>الطلبية <span className="optional">اختياري</span><select value={eForm.orderId} onChange={e=>setEForm({...eForm,orderId:e.target.value})}><option value="">مصروف عام</option>{orders.map(o=><option key={o.id} value={o.id}>{o.code} — {o.order_name}</option>)}</select></label><label>التصنيف<input value={eForm.category} onChange={e=>setEForm({...eForm,category:e.target.value})}/></label><label>الوصف<input value={eForm.description} onChange={e=>setEForm({...eForm,description:e.target.value})}/></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={eForm.amount} onChange={e=>setEForm({...eForm,amount:e.target.value})}/></label></div><div className="form-actions"><button className="primary-button" onClick={addExpense}>تسجيل المصروف</button></div></section>}

  {has("finance.revenues.create")&&<section className="card finance-two-col"><div className="card-header"><h2 className="card-title">تسجيل إيراد طلبية</h2></div><div className="form-grid"><label>الطلبية<select value={rForm.orderId} onChange={e=>setRForm({...rForm,orderId:e.target.value})}><option value="">اختر الطلبية</option>{orders.map(o=><option key={o.id} value={o.id}>{o.code} — {o.order_name}</option>)}</select></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={rForm.amount} onChange={e=>setRForm({...rForm,amount:e.target.value})}/></label><label>المصدر<input value={rForm.source} onChange={e=>setRForm({...rForm,source:e.target.value})}/></label><label>ملاحظات<input value={rForm.notes} onChange={e=>setRForm({...rForm,notes:e.target.value})}/></label></div><div className="form-actions"><button className="primary-button" onClick={addRevenue}>تسجيل الإيراد</button></div></section>}

  <section className="grid finance-lists"><section className="card"><div className="card-header"><h2 className="card-title">آخر المصروفات</h2></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>التصنيف</th><th>الوصف</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>{expenses.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code||"عام"}</td><td>{x.category}</td><td>{x.description}</td><td className="money">{n(x.amount)}</td><td>{x.expense_date}</td></tr>)}{!expenses.length&&<tr><td colSpan={6}>لا توجد مصروفات.</td></tr>}</tbody></table></div></section><section className="card"><div className="card-header"><h2 className="card-title">آخر الإيرادات</h2></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>الطلبية</th><th>المصدر</th><th>المبلغ</th><th>التاريخ</th></tr></thead><tbody>{revenues.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.order_code}</td><td>{x.source}</td><td className="money">{n(x.amount)}</td><td>{x.revenue_date}</td></tr>)}{!revenues.length&&<tr><td colSpan={5}>لا توجد إيرادات.</td></tr>}</tbody></table></div></section></section>
 </section></main></div>;
}
