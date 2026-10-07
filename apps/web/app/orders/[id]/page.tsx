"use client";

import {useEffect,useState} from "react";
import {useParams} from "next/navigation";
import {api} from "../../../lib/api";
import {Sidebar,usePermissions} from "../../../components/sidebar";
import {SearchableSelect} from "../../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Dashboard={order:any;stages:any[];production:any[];movements:any[];deliveries:any[];totals:any};

export default function OrderDetailPage(){
 const {id}=useParams<{id:string}>(); const {has}=usePermissions();
 const [data,setData]=useState<Dashboard|null>(null),[stages,setStages]=useState<Item[]>([]),[products,setProducts]=useState<Item[]>([]);
 const [stageId,setStageId]=useState(""),[outputProductId,setOutputProductId]=useState(""),[planned,setPlanned]=useState(""),[error,setError]=useState("");
 async function load(){try{const [d,s,p]=await Promise.all([api<{data:Dashboard}>("/api/orders/"+id+"/dashboard"),api<{data:Item[]}>("/api/stages"),api<{data:Item[]}>("/api/products")]);setData(d.data);setStages(s.data);setProducts(p.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل ملف الطلب")}}
 useEffect(()=>{if(id)void load()},[id]);
 async function addStage(){if(!stageId)return;try{await api("/api/orders/"+id+"/stages",{method:"POST",body:JSON.stringify({stageId,outputProductId:outputProductId||null,sequenceNo:(data?.stages.length??0)+1,plannedQuantity:planned?Number(planned):undefined})});setStageId("");setOutputProductId("");setPlanned("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إضافة المرحلة")}}
 async function editStage(stage:any){const next=window.prompt("الحالة الجديدة (PENDING / READY / IN_PROGRESS / COMPLETED / CANCELLED)",stage.status);if(!next)return;try{await api("/api/order-stages/"+stage.id,{method:"PATCH",body:JSON.stringify({status:next})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعديل المرحلة")}}
 if(!data)return <div className="app-shell"><Sidebar active="/orders"/><main className="main"><div className="content">{error?<div className="alert error">{error}</div>:<div className="empty">جارٍ تحميل ملف الطلب...</div>}</div></main></div>;
 const o=data.order; const productOptions=products.map(x=>({value:x.id,label:x.name,meta:x.code}));const stageOptions=stages.map(x=>({value:x.id,label:x.name,meta:x.code}));
 return <div className="app-shell"><Sidebar active="/orders"/><main className="main">
  <header className="topbar"><div><button className="link-button" onClick={()=>window.location.href="/orders"}>← العودة للطلبات</button><h1 className="page-title">{o.order_name}</h1><p className="page-subtitle">{o.code}{o.customer_name?" · "+o.customer_name:""} · {o.status}</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   <div className="stats">
    <article className="card stat"><div className="stat-label">تكلفة الإنتاج</div><div className="stat-value">{Number(data.totals.production_cost||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</div><div className="stat-note">أجور الإنتاج المعتمدة</div></article>
    <article className="card stat accent"><div className="stat-label">تكلفة المسحوبات</div><div className="stat-value">{Number(data.totals.stock_out_cost||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</div><div className="stat-note">صرف المخزن المرتبط بالطلب</div></article>
    <article className="card stat warning"><div className="stat-label">تكلفة الداخل</div><div className="stat-value">{Number(data.totals.stock_in_cost||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</div><div className="stat-note">إدخالات مرتبطة بالطلب</div></article>
    <article className="card stat neutral"><div className="stat-label">الكمية المنجزة</div><div className="stat-value">{Number(o.completed_quantity||0).toLocaleString("ar-EG")}</div><div className="stat-note">تتحدث مع التشغيل</div></article>
   </div>
   <section className="card" style={{marginBottom:16}}><div className="card-header"><div><h2 className="card-title">بيانات الطلب</h2><div className="form-hint">تاريخ الطلب {o.order_date} · بداية التسليم {o.delivery_start_date||"—"} · آخر دفعة {o.last_delivery_date||o.due_date||"—"}</div></div></div><div className="order-detail-meta"><div><span>العميل</span><strong>{o.customer_name||"—"}</strong></div><div><span>الحالة</span><strong>{o.status}</strong></div><div><span>ملاحظات</span><strong>{o.notes||"—"}</strong></div></div></section>
   <section className="card" style={{marginBottom:16}}><div className="card-header"><div><h2 className="card-title">مراحل الطلب</h2><div className="form-hint">يمكن تعديل المرحلة أو المنتج الناتج أو ترتيبها من هنا.</div></div></div>
    {has("orders.manage_stages")&&<div className="stage-add-bar"><SearchableSelect value={stageId} onChange={setStageId} options={stageOptions} placeholder="اختر المرحلة"/><SearchableSelect value={outputProductId} onChange={setOutputProductId} options={productOptions} placeholder="المنتج الناتج"/><input inputMode="decimal" placeholder="الكمية المخططة" value={planned} onChange={e=>setPlanned(e.target.value)}/><button className="primary-button" onClick={addStage}>إضافة</button></div>}
    <div className="table-wrap"><table><thead><tr><th>#</th><th>المرحلة</th><th>المنتج الناتج</th><th>المخطط</th><th>المنجز</th><th>الحالة</th><th></th></tr></thead><tbody>{data.stages.map((x,i)=><tr key={x.id}><td>{i+1}</td><td>{x.stage_name}</td><td>{x.output_product_name||"—"}</td><td>{x.planned_quantity??"—"}</td><td>{x.completed_quantity}</td><td><span className="status">{x.status}</span></td><td>{has("orders.manage_stages")&&<button className="link-button" onClick={()=>editStage(x)}>تعديل</button>}</td></tr>)}</tbody></table></div>
   </section>
   <div className="grid">
    <section className="card"><div className="card-header"><h2 className="card-title">إنتاج الطلب</h2></div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>المرحلة</th><th>النوع</th><th>الكمية</th><th>المستحق</th></tr></thead><tbody>{data.production.map(x=><tr key={x.id}><td>{x.work_date}</td><td>{x.employee_name}</td><td>{x.stage_name}</td><td>{x.production_type_name||"—"}</td><td>{x.quantity}</td><td className="money">{x.earning_amount}</td></tr>)}{!data.production.length&&<tr><td colSpan={6}>لا يوجد إنتاج مرتبط حتى الآن.</td></tr>}</tbody></table></div></section>
    <section className="card"><div className="card-header"><h2 className="card-title">مسحوبات المخزن</h2></div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>المنتج</th><th>المخزن</th><th>الكمية</th><th>التكلفة</th></tr></thead><tbody>{data.movements.map(x=><tr key={x.code}><td>{new Date(x.created_at).toLocaleDateString("ar-EG")}</td><td>{x.product_name}</td><td>{x.warehouse_name}</td><td>{x.quantity}</td><td className="money">{Number(x.total_cost||0).toLocaleString("ar-EG",{maximumFractionDigits:2})}</td></tr>)}{!data.movements.length&&<tr><td colSpan={5}>لا توجد مسحوبات مرتبطة بالطلب.</td></tr>}</tbody></table></div></section>
   </div>
   <section className="card" style={{marginTop:16}}><div className="card-header"><h2 className="card-title">التسليمات</h2></div><div className="table-wrap"><table><thead><tr><th>الإذن</th><th>الوجهة</th><th>الكمية</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>{data.deliveries.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.destination}</td><td>{x.quantity}</td><td>{x.status}</td><td>{new Date(x.created_at).toLocaleDateString("ar-EG")}</td></tr>)}{!data.deliveries.length&&<tr><td colSpan={5}>لا توجد تسليمات بعد.</td></tr>}</tbody></table></div></section>
  </section>
 </main></div>;
}
