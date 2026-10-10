"use client";
import {useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
type Row={id:string;code:string;work_date:string;quantity:string;earning_amount:string;status:string;product_name:string;stage_name:string;shift_name:string;unit_name:string;created_by_username?:string|null;order_code?:string|null;order_name?:string|null};
export default function MyProductionPage(){
 const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState("");
 const [filters,setFilters]=useState({product:"",stage:"",status:"",from:"",to:"",q:""});
 useEffect(()=>{api<{data:Row[]}>("/api/production/my").then(x=>setRows(x.data)).catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل إنتاجك"));},[]);
 const visible=useMemo(()=>rows.filter(x=>
  (!filters.product||x.product_name===filters.product)&&(!filters.stage||x.stage_name===filters.stage)&&
  (!filters.status||x.status===filters.status)&&(!filters.from||x.work_date>=filters.from)&&(!filters.to||x.work_date<=filters.to)&&
  (!filters.q||[x.code,x.product_name,x.stage_name,x.shift_name,x.order_code||"",x.order_name||""].join(" ").toLowerCase().includes(filters.q.toLowerCase()))
 ),[rows,filters]);
 const products=Array.from(new Set(rows.map(x=>x.product_name))).sort((a,b)=>a.localeCompare(b,"ar"));
 const stages=Array.from(new Set(rows.map(x=>x.stage_name))).sort((a,b)=>a.localeCompare(b,"ar"));
 return <div className="app-shell"><Sidebar active="/my-production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاجي</h1><p className="page-subtitle">سجل إنتاجك وحالة اعتماد كل عملية</p></div></header><section className="content">{error&&<div className="alert error">{error}</div>}<section className="card"><div className="card-header"><div><h2 className="card-title">سجل إنتاجي</h2><div className="form-hint">{visible.length.toLocaleString("ar-EG")} سجل مطابق للفلاتر.</div></div></div>
 <div className="form-grid finance-four-grid" style={{padding:16}}>
  <label>المنتج<select value={filters.product} onChange={e=>setFilters(v=>({...v,product:e.target.value}))}><option value="">كل المنتجات</option>{products.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
  <label>المرحلة<select value={filters.stage} onChange={e=>setFilters(v=>({...v,stage:e.target.value}))}><option value="">كل المراحل</option>{stages.map(x=><option key={x} value={x}>{x}</option>)}</select></label>
  <label>الحالة<select value={filters.status} onChange={e=>setFilters(v=>({...v,status:e.target.value}))}><option value="">كل الحالات</option><option value="APPROVED">معتمد</option><option value="PENDING">قيد المراجعة</option><option value="REJECTED">مرفوض</option></select></label>
  <label>من تاريخ<input type="date" value={filters.from} onChange={e=>setFilters(v=>({...v,from:e.target.value}))}/></label>
  <label>إلى تاريخ<input type="date" value={filters.to} onChange={e=>setFilters(v=>({...v,to:e.target.value}))}/></label>
  <label>بحث بالكود أو الطلبية<input value={filters.q} onChange={e=>setFilters(v=>({...v,q:e.target.value}))} placeholder="الكود أو اسم الطلبية"/></label>
  <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setFilters({product:"",stage:"",status:"",from:"",to:"",q:""})}>مسح الفلاتر</button></div>
 </div>
 <div className="table-wrap"><table><thead><tr><th>السجل</th><th>التاريخ</th><th>الطلبية</th><th>المنتج</th><th>المرحلة</th><th>الوردية</th><th>الكمية</th><th>المستحق</th><th>الحالة</th><th>الحساب المسجّل</th></tr></thead><tbody>{visible.map(x=><tr key={x.id}><td>{x.code}</td><td>{x.work_date}</td><td>{x.order_code?x.order_code+" — "+(x.order_name||""):"—"}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.shift_name}</td><td>{Number(x.quantity).toLocaleString("ar-EG")} {x.unit_name}</td><td>{Number(x.earning_amount).toLocaleString("ar-EG")}</td><td>{x.status==="APPROVED"?"معتمد":x.status==="PENDING"?"قيد المراجعة":x.status==="REJECTED"?"مرفوض":"ملغي"}</td><td>{x.created_by_username||"—"}</td></tr>)}{!visible.length&&<tr><td colSpan={10}>لا توجد سجلات مطابقة للفلاتر.</td></tr>}</tbody></table></div></section></section></main></div>;
}