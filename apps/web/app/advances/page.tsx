"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
type Advance={id:string;code:string;employee_name:string;amount:number;reason:string;status:string;created_at:string;rejection_reason:string|null};
const labels:Record<string,string>={PENDING:"قيد المراجعة",APPROVED:"معتمدة",REJECTED:"مرفوضة",PAID:"تم الصرف",CANCELLED:"ملغاة"};
export default function AdvancesPage(){
 const { has } = usePermissions();
 const [items,setItems]=useState<Advance[]>([]),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){try{setItems((await api<{data:Advance[]}>("/api/advances")).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل السلف")}}
 useEffect(()=>{void load()},[]);
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{await api("/api/advances",{method:"POST",body:JSON.stringify({amount:Number(amount),reason})});setAmount("");setReason("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء الطلب")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){try{if(a==="reject"){const r=window.prompt("سبب الرفض؟");if(!r)return;await api("/api/advances/"+id+"/reject",{method:"POST",body:JSON.stringify({reason:r})})}else await api("/api/advances/"+id+"/"+a,{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}}
 return <div className="app-shell"><Sidebar active="/advances" /><main className="main"><header className="topbar"><div><h1 className="page-title">السلف</h1><p className="page-subtitle">طلب ومراجعة وصرف السلف وربطها بدفتر المستحقات</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 {has("advances.create") && <form className="card form-card" onSubmit={submit}><div className="card-header"><h2 className="card-title">طلب سلفة</h2></div><div className="form-grid"><label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>السبب<input value={reason} onChange={e=>setReason(e.target.value)} required/></label></div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الإرسال...":"إرسال طلب السلفة"}</button></div></form>}
 <section className="card"><div className="card-header"><h2 className="card-title">طلبات السلف</h2><span className="count-badge">{items.length}</span></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>المبلغ</th><th>السبب</th><th>التاريخ</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
 {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td className="money">{x.amount}</td><td>{x.reason}</td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td><span className={"status "+x.status.toLowerCase()}>{labels[x.status]||x.status}</span></td><td>{x.status==="PENDING"&&<div className="row-actions">{has("advances.approve")&&<button className="approve-button" onClick={()=>action(x.id,"approve")}>اعتماد</button>}{has("advances.reject")&&<button className="reject-button" onClick={()=>action(x.id,"reject")}>رفض</button>}</div>}{x.status==="APPROVED"&&has("advances.pay")&&<button className="approve-button" onClick={()=>action(x.id,"pay")}>صرف السلفة</button>}</td></tr>)}
 {!items.length&&<tr><td colSpan={7}>لا توجد طلبات سلف.</td></tr>}</tbody></table></div></section>
 </section></main></div>
}