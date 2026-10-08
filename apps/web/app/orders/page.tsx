"use client";

import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type Order={id:string;code:string;order_name:string;customer_name:string|null;order_date:string;delivery_start_date:string|null;due_date:string|null;last_delivery_date:string|null;status:string;line_count:number;ordered_quantity:string;completed_quantity:string};
type StageRow={stageName:string;outputProductName:string;plannedQuantity:string;notes:string;stageRate:string;stageRateMethod:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={DRAFT:"مسودة",PLANNED:"مخططة",IN_PROGRESS:"قيد التنفيذ",COMPLETED:"مكتملة",CANCELLED:"ملغاة"};

export default function OrdersPage(){
 const {has}=usePermissions();
 const [orders,setOrders]=useState<Order[]>([]);
 const [orderName,setOrderName]=useState(""),[customer,setCustomer]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[deliveryStart,setDeliveryStart]=useState(""),[lastDelivery,setLastDelivery]=useState(""),[notes,setNotes]=useState("");
 const [stageRows,setStageRows]=useState<StageRow[]>([]);
 const [error,setError]=useState(""),[saving,setSaving]=useState(false);

 async function load(){try{const o=await api<{data:Order[]}>("/api/orders");setOrders(o.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الطلبات")}}
 useEffect(()=>{void load()},[]);

 function addStage(){setStageRows(v=>[...v,{stageName:"",outputProductName:"",plannedQuantity:"",notes:"",stageRate:"",stageRateMethod:"PER_1000"}])}
 function updateStage(i:number,key:keyof StageRow,value:string){setStageRows(v=>v.map((r,n)=>n===i?{...r,[key]:value}:r))}
 function removeStage(i:number){setStageRows(v=>v.filter((_,n)=>n!==i))}

 async function submit(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   await api("/api/orders",{method:"POST",body:JSON.stringify({
    orderName,customerName:customer||undefined,orderDate:date,deliveryStartDate:deliveryStart||undefined,lastDeliveryDate:lastDelivery||undefined,notes:notes||undefined,
    lines:[],
    stages:stageRows.filter(x=>x.stageName.trim()).map((x,i)=>({stageName:x.stageName.trim(),outputProductName:x.outputProductName.trim()||undefined,sequenceNo:i+1,plannedQuantity:x.plannedQuantity?Number(normalizeNumber(x.plannedQuantity)):undefined,notes:x.notes||undefined,stageRate:x.stageRate?Number(normalizeNumber(x.stageRate)):undefined,stageRateMethod:x.stageRate||x.stageRateMethod?x.stageRateMethod:undefined}))
   })});
   setOrderName("");setCustomer("");setDeliveryStart("");setLastDelivery("");setNotes("");setStageRows([]);await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء الطلبية")}finally{setSaving(false)}
 }

 return <div className="app-shell"><Sidebar active="/orders"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الطلبات</h1><p className="page-subtitle">سجّل الطلبية باسمها، ثم اكتب كل مرحلة والمنتج الناتج بجانبها. النظام ينشئ المنتج والمرحلة تلقائيًا عند الحاجة.</p></div></header>
  <section className="content">{error&&<div className="alert error">{error}</div>}
   {has("orders.create")&&<form className="card form-card" onSubmit={submit}>
    <div className="card-header"><div><h2 className="card-title">تسجيل طلبية جديدة</h2><div className="form-hint">لو كتبت منتجًا أو مرحلة غير موجودة، تذكار ينشئها تلقائيًا في البيانات الأساسية.</div></div></div>
    <div className="form-grid">
     <label>اسم الطلبية<input value={orderName} onChange={e=>setOrderName(e.target.value)} placeholder="مثال: طلبية الجوهري أكتوبر" required/></label>
     <label>اسم العميل / الجهة<input value={customer} onChange={e=>setCustomer(e.target.value)} placeholder="اختياري"/></label>
     <label>تاريخ الطلب<input type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
     <label>بداية التسليم<input type="date" value={deliveryStart} onChange={e=>setDeliveryStart(e.target.value)}/></label>
     <label>آخر دفعة تسليم<input type="date" value={lastDelivery} onChange={e=>setLastDelivery(e.target.value)}/></label>
     <div className="form-hint" style={{gridColumn:"1/-1"}}>المنتج والسعر بيتحددوا داخل مراحل الطلبية؛ إنتاج العامل هيقرأهم تلقائيًا.</div>
     <label style={{gridColumn:"1/-1"}}>ملاحظات<textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="ملاحظات التشغيل أو التسليم"/></label>
    </div>
    <div className="card-body order-stages-editor">
     <div className="section-title"><div><strong>مراحل الطلب</strong><div className="form-hint">كل مرحلة لها منتج ناتج وسعر إنتاج وطريقة تسعير. السعر ينتقل تلقائيًا لإنتاج العامل.</div></div><button type="button" className="secondary-btn" onClick={addStage}>+ إضافة مرحلة</button></div>
     {!stageRows.length?<div className="empty small-empty">أضف مراحل الطلب واحدة واحدة.</div>:
      <div className="stage-editor-list">{stageRows.map((row,i)=><div className="stage-editor-row" key={i}><div className="stage-number">{i+1}</div>
       <div><span className="field-caption">اسم المرحلة</span><input value={row.stageName} onChange={e=>updateStage(i,"stageName",e.target.value)} placeholder="مثال: طباعة المقلمة"/></div>
       <div><span className="field-caption">المنتج الناتج</span><input value={row.outputProductName} onChange={e=>updateStage(i,"outputProductName",e.target.value)} placeholder="مثال: مقلمة مطبوعة"/></div>
       <div><span className="field-caption">الكمية المخططة</span><input inputMode="decimal" value={row.plannedQuantity} onChange={e=>updateStage(i,"plannedQuantity",e.target.value)} /></div>
       <div><span className="field-caption">طريقة التسعير</span><select value={row.stageRateMethod} onChange={e=>updateStage(i,"stageRateMethod",e.target.value)}><option value="PER_PIECE">بالقطعة</option><option value="PER_1000">لكل ألف</option><option value="PER_HOUR">بالساعة</option><option value="PER_DAY">باليومية</option><option value="PERCENTAGE">نسبة</option></select></div>
       <div><span className="field-caption">سعر المرحلة</span><input inputMode="decimal" value={row.stageRate} onChange={e=>updateStage(i,"stageRate",e.target.value)} placeholder="مثال: 300" required /></div>
       <button type="button" className="danger-button" onClick={()=>removeStage(i)}>حذف</button>
      </div>)}</div>}
    </div>
    <div className="form-actions"><button className="primary-button" disabled={saving||!stageRows.some(x=>x.stageName.trim()&&x.outputProductName.trim()&&x.plannedQuantity)}>{saving?"جارٍ الحفظ...":"حفظ الطلبية"}</button></div>
   </form>}

   <section className="card"><div className="card-header"><div><h2 className="card-title">لوحة الطلبات</h2><div className="form-hint">كل طلبية لها ملف مستقل للتشغيل والتكلفة والمسحوبات والتسليم.</div></div><span className="count-badge">{orders.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>اسم الطلبية</th><th>رقم الطلب</th><th>تاريخ الطلب</th><th>بداية التسليم</th><th>آخر دفعة</th><th>الكمية</th><th>المنجز</th><th>الحالة</th></tr></thead>
    <tbody>{orders.map(x=><tr key={x.id} onClick={()=>window.location.href="/orders/"+x.id} style={{cursor:"pointer"}}><td className="strong">{x.order_name}</td><td className="mono">{x.code}</td><td>{x.order_date}</td><td>{x.delivery_start_date??"—"}</td><td>{x.last_delivery_date??x.due_date??"—"}</td><td>{Number(x.ordered_quantity).toLocaleString("ar-EG")}</td><td>{Number(x.completed_quantity).toLocaleString("ar-EG")}</td><td><span className="status">{labels[x.status]??x.status}</span></td></tr>)}{!orders.length&&<tr><td colSpan={8}>لا توجد طلبات حتى الآن.</td></tr>}</tbody></table></div>
   </section>
  </section>
 </main></div>;
}
