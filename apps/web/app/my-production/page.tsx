"use client";
import {useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
import {formatMoney,formatQuantity} from "../../lib/format";
type Row={id:string;code:string;work_date:string;quantity:string;earning_amount:string;bonus_amount:string;deduction_amount:string;net_earning:string;paid_amount:string;remaining_amount:string;status:string;product_name:string;stage_name:string;shift_name:string;unit_name:string};
type Daily={work_date:string;production_earned:string;bonuses:string;deductions:string;net_earned:string;approved_count:number;pending_count:number};
type Adjustment={id:string;adjustment_date:string;adjustment_type:"BONUS"|"DEDUCTION";amount:string;reason:string;production_code:string|null};
function todayDate(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
export default function MyProductionPage(){
 const [rows,setRows]=useState<Row[]>([]),[daily,setDaily]=useState<Daily[]>([]),[adjustments,setAdjustments]=useState<Adjustment[]>([]);
 const [from,setFrom]=useState(todayDate),[to,setTo]=useState(todayDate),[error,setError]=useState(""),[loading,setLoading]=useState(false);
 useEffect(()=>{let active=true;setLoading(true);setError("");const params=new URLSearchParams();if(from)params.set("from",from);if(to)params.set("to",to);api<{data:Row[];daily:Daily[];adjustments:Adjustment[]}>("/api/production/my?"+params.toString()).then(x=>{if(active){setRows(x.data);setDaily(x.daily??[]);setAdjustments(x.adjustments??[])}}).catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل إنتاجك")}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[from,to]);
 const totals=useMemo(()=>daily.reduce((a,d)=>({earned:a.earned+Number(d.production_earned||0),bonuses:a.bonuses+Number(d.bonuses||0),deductions:a.deductions+Number(d.deductions||0),net:a.net+Number(d.net_earned||0)}),{earned:0,bonuses:0,deductions:0,net:0}),[daily]);
 return <div className="app-shell"><Sidebar active="/my-production"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">إنتاجي وحسابي اليومي</h1><p className="page-subtitle">إنتاجك وأجرك والبونص والخصومات وصافي المستحق لكل يوم</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   <section className="card"><div className="card-header"><div><h2 className="card-title">اختيار الفترة</h2><p className="form-hint">يفتح على حساب اليوم تلقائيًا؛ غيّر التاريخ لمراجعة فترة سابقة.</p></div></div><div className="form-grid">
    <label>من تاريخ<input type="date" value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></label>
    <label>إلى تاريخ<input type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></label>
    <div style={{display:"flex",gap:8,alignItems:"end",flexWrap:"wrap"}}><button type="button" className="secondary-btn" onClick={()=>{const t=todayDate();setFrom(t);setTo(t)}}>حساب اليوم</button><button type="button" className="secondary-btn" onClick={()=>{setFrom("");setTo("")}}>كل الفترات</button></div>
   </div></section>
   <div className="stats-grid">
    <article className="card stat"><div className="stat-label">إنتاج معتمد</div><div className="stat-value">{formatMoney(totals.earned)}</div></article>
    <article className="card stat"><div className="stat-label">بونص وإضافات</div><div className="stat-value">{formatMoney(totals.bonuses)}</div></article>
    <article className="card stat"><div className="stat-label">إجمالي الخصومات</div><div className="stat-value">{formatMoney(totals.deductions)}</div></article>
    <article className="card stat accent"><div className="stat-label">صافي المستحق للفترة</div><div className="stat-value">{formatMoney(totals.net)}</div></article>
   </div>
   <section className="card"><div className="card-header"><div><h2 className="card-title">ملخص كل يوم</h2><p className="form-hint">الصافي = الإنتاج المعتمد + البونص − الخصومات. الإنتاج المعلّق لا يدخل في المستحق المعتمد.</p></div></div><div className="table-wrap"><table><thead><tr><th>اليوم</th><th>معتمد</th><th>معلّق</th><th>إنتاج</th><th>بونص وإضافات</th><th>خصومات</th><th>صافي مستحق</th></tr></thead><tbody>{daily.map(d=><tr key={d.work_date}><td>{d.work_date}</td><td>{d.approved_count}</td><td>{d.pending_count}</td><td>{formatMoney(d.production_earned)}</td><td>{formatMoney(d.bonuses)}</td><td>{formatMoney(d.deductions)}</td><td className="strong">{formatMoney(d.net_earned)}</td></tr>)}{!daily.length&&<tr><td colSpan={7}>{loading?"جارٍ تحميل الحساب...":"لا توجد حركة في الفترة المختارة."}</td></tr>}</tbody></table></div></section>
   <section className="card"><div className="card-header"><div><h2 className="card-title">تفاصيل الإنتاج</h2><p className="form-hint">«المدفوع الموزع» هو المبلغ المرتبط بسجل الإنتاج داخل النظام.</p></div></div><div className="table-wrap"><table><thead><tr><th>السجل</th><th>التاريخ</th><th>المنتج / المرحلة</th><th>الوردية</th><th>الكمية</th><th>أجر الإنتاج</th><th>بونص</th><th>خصم</th><th>صافي العملية</th><th>مدفوع موزع</th><th>المتبقي</th><th>الحالة</th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><td>{x.code}</td><td>{x.work_date}</td><td>{x.product_name}<div className="form-hint">{x.stage_name}</div></td><td>{x.shift_name}</td><td>{formatQuantity(x.quantity,0)} {x.unit_name}</td><td>{formatMoney(x.earning_amount)}</td><td>{formatMoney(x.bonus_amount)}</td><td>{formatMoney(x.deduction_amount)}</td><td className="strong">{formatMoney(x.net_earning)}</td><td>{formatMoney(x.paid_amount)}</td><td>{formatMoney(x.remaining_amount)}</td><td><span className={"status "+(x.status==="APPROVED"?"success":x.status==="PENDING"?"warning":"muted")}>{x.status==="APPROVED"?"معتمد":x.status==="PENDING"?"قيد المراجعة":x.status==="REJECTED"?"مرفوض":"ملغي"}</span></td></tr>)}{!rows.length&&<tr><td colSpan={12}>{loading?"جارٍ تحميل الإنتاج...":"لا يوجد إنتاج مسجل في الفترة المختارة."}</td></tr>}</tbody></table></div></section>
   <section className="card"><div className="card-header"><div><h2 className="card-title">تفاصيل البونص والخصومات</h2><p className="form-hint">سبب كل إضافة أو خصم وتاريخ تسجيله.</p></div></div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>النوع</th><th>القيمة</th><th>السبب</th><th>سجل الإنتاج</th></tr></thead><tbody>{adjustments.map(a=><tr key={a.id}><td>{a.adjustment_date}</td><td>{a.adjustment_type==="BONUS"?"بونص / إضافة":"خصم"}</td><td className="strong">{formatMoney(a.amount)}</td><td>{a.reason||"—"}</td><td>{a.production_code||"تسوية يومية"}</td></tr>)}{!adjustments.length&&<tr><td colSpan={5}>لا توجد إضافات أو خصومات في الفترة المختارة.</td></tr>}</tbody></table></div></section>
  </section>
 </main></div>;
}
