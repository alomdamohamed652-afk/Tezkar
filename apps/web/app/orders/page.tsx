"use client";

import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Order={id:string;code:string;order_name:string;customer_name:string|null;order_date:string;delivery_start_date:string|null;due_date:string|null;last_delivery_date:string|null;status:string;line_count:number;ordered_quantity:string;completed_quantity:string};
type StageRow={stageId:string;outputProductId:string;plannedQuantity:string;notes:string};
const labels:Record<string,string>={DRAFT:"مسودة",PLANNED:"مخططة",IN_PROGRESS:"قيد التنفيذ",COMPLETED:"مكتملة",CANCELLED:"ملغاة"};

export default function OrdersPage(){
 const {has}=usePermissions();
 const [orders,setOrders]=useState<Order[]>([]),[products,setProducts]=useState<Item[]>([]),[units,setUnits]=useState<Item[]>([]),[stages,setStages]=useState<Item[]>([]);
 const [orderName,setOrderName]=useState(""),[customer,setCustomer]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[deliveryStart,setDeliveryStart]=useState(""),[lastDelivery,setLastDelivery]=useState(""),[notes,setNotes]=useState("");
 const [product,setProduct]=useState(""),[quantity,setQuantity]=useState(""),[unit,setUnit]=useState(""),[stageRows,setStageRows]=useState<StageRow[]>([]);
 const [error,setError]=useState(""),[saving,setSaving]=useState(false);

 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name,meta:x.code})),[products]);
 const unitOptions=useMemo(()=>units.map(x=>({value:x.id,label:x.name,meta:x.code})),[units]);
 const stageOptions=useMemo(()=>stages.map(x=>({value:x.id,label:x.name,meta:x.code})),[stages]);

 async function load(){
  try{
   const [o,p,u,s]=await Promise.all([api<{data:Order[]}>("/api/orders"),api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/units"),api<{data:Item[]}>("/api/stages")]);
   setOrders(o.data);setProducts(p.data);setUnits(u.data);setStages(s.data);
   const pref=await api<{data:Record<string,string>}>("/api/account/preferences/orders").catch(()=>({data:{}}));
   if(!product&&((pref.data as any).productId||p.data[0]))setProduct((pref.data as any).productId||p.data[0]?.id||"");
   if(!unit&&((pref.data as any).unitId||u.data[0]))setUnit((pref.data as any).unitId||u.data[0]?.id||"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الطلبات")}
 }
 useEffect(()=>{void load()},[]);

 function addStage(){setStageRows(v=>[...v,{stageId:stages[0]?.id||"",outputProductId:"",plannedQuantity:quantity,notes:""}])}
 function updateStage(i:number,key:keyof StageRow,value:string){setStageRows(v=>v.map((r,n)=>n===i?{...r,[key]:value}:r))}
 function removeStage(i:number){setStageRows(v=>v.filter((_,n)=>n!==i))}

 async function submit(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   await api("/api/orders",{method:"POST",body:JSON.stringify({
    orderName,customerName:customer||undefined,orderDate:date,deliveryStartDate:deliveryStart||undefined,dueDate:lastDelivery||undefined,lastDeliveryDate:lastDelivery||undefined,notes:notes||undefined,
    lines:[{productId:product,quantity:Number(quantity),unitId:unit}],
    stages:stageRows.filter(x=>x.stageId).map((x,i)=>({stageId:x.stageId,outputProductId:x.outputProductId||null,sequenceNo:i+1,plannedQuantity:x.plannedQuantity?Number(x.plannedQuantity):undefined,notes:x.notes||undefined}))
   })});
   await api("/api/account/preferences/orders",{method:"PUT",body:JSON.stringify({productId:product,unitId:unit})}).catch(()=>{});
   setOrderName("");setCustomer("");setQuantity("");setDeliveryStart("");setLastDelivery("");setNotes("");setStageRows([]);await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء الطلب")}finally{setSaving(false)}
 }

 return <div className="app-shell"><Sidebar active="/orders"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الطلبات</h1><p className="page-subtitle">كل طلب له ملف مستقل: مراحل، إنتاج، مسحوبات مخزن، تكلفة وتسليمات.</p></div></header>
  <section className="content">{error&&<div className="alert error">{error}</div>}
   {has("orders.create")&&<form className="card form-card" onSubmit={submit}>
    <div className="card-header"><div><h2 className="card-title">تسجيل طلبية جديدة</h2><div className="form-hint">الاختيارات الأخيرة يتم تذكرها تلقائيًا على حسابك.</div></div></div>
    <div className="form-grid">
     <label>اسم الطلبية<input value={orderName} onChange={e=>setOrderName(e.target.value)} placeholder="مثال: طلبية الجوهري — مقالم أكتوبر" required/></label>
     <label>اسم العميل / الجهة<input value={customer} onChange={e=>setCustomer(e.target.value)} placeholder="اختياري"/></label>
     <label>تاريخ الطلب<input type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
     <label>بداية التسليم<input type="date" value={deliveryStart} onChange={e=>setDeliveryStart(e.target.value)}/></label>
     <label>آخر دفعة تسليم<input type="date" value={lastDelivery} onChange={e=>setLastDelivery(e.target.value)}/></label>
     <label>المنتج الرئيسي<SearchableSelect value={product} onChange={setProduct} options={productOptions} placeholder="اختر المنتج" searchPlaceholder="ابحث باسم المنتج أو الكود"/></label>
     <label>الكمية<input inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required placeholder="0"/></label>
     <label>الوحدة<SearchableSelect value={unit} onChange={setUnit} options={unitOptions} placeholder="اختر الوحدة"/></label>
     <label style={{gridColumn:"1/-1"}}>ملاحظات<textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="ملاحظات التشغيل أو التسليم"/></label>
    </div>
    <div className="card-body order-stages-editor">
     <div className="section-title"><div><strong>مراحل الطلب</strong><div className="form-hint">أضف كل مرحلة يدويًا وحدد المنتج الناتج وسعرها من إعدادات التشغيل.</div></div><button type="button" className="secondary-btn" onClick={addStage}>+ إضافة مرحلة</button></div>
     {!stageRows.length?<div className="empty small-empty">لم تتم إضافة مراحل. يمكنك إنشاء الطلب ثم إضافة المراحل من ملف الطلب.</div>:
      <div className="stage-editor-list">{stageRows.map((row,i)=><div className="stage-editor-row" key={i}><div className="stage-number">{i+1}</div>
       <div><span className="field-caption">المرحلة</span><SearchableSelect value={row.stageId} onChange={v=>updateStage(i,"stageId",v)} options={stageOptions} placeholder="اختر المرحلة"/></div>
       <div><span className="field-caption">المنتج الناتج</span><SearchableSelect value={row.outputProductId} onChange={v=>updateStage(i,"outputProductId",v)} options={productOptions} placeholder="اختر المنتج"/></div>
       <div><span className="field-caption">الكمية المخططة</span><input inputMode="decimal" value={row.plannedQuantity} onChange={e=>updateStage(i,"plannedQuantity",e.target.value)} /></div>
       <button type="button" className="danger-button" onClick={()=>removeStage(i)}>حذف</button>
      </div>)}</div>}
    </div>
    <div className="form-actions"><button className="primary-button" disabled={saving||!product||!unit}>{saving?"جارٍ الحفظ...":"حفظ الطلبية"}</button></div>
   </form>}

   <section className="card"><div className="card-header"><div><h2 className="card-title">لوحة الطلبات</h2><div className="form-hint">اضغط على أي طلب لفتح ملفه الكامل.</div></div><span className="count-badge">{orders.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>اسم الطلبية</th><th>رقم الطلب</th><th>تاريخ الطلب</th><th>بداية التسليم</th><th>آخر دفعة</th><th>الكمية</th><th>المنجز</th><th>الحالة</th></tr></thead>
    <tbody>{orders.map(x=><tr key={x.id} onClick={()=>window.location.href="/orders/"+x.id} style={{cursor:"pointer"}}><td className="strong">{x.order_name}</td><td className="mono">{x.code}</td><td>{x.order_date}</td><td>{x.delivery_start_date??"—"}</td><td>{x.last_delivery_date??x.due_date??"—"}</td><td>{Number(x.ordered_quantity).toLocaleString("ar-EG")}</td><td>{Number(x.completed_quantity).toLocaleString("ar-EG")}</td><td><span className="status">{labels[x.status]??x.status}</span></td></tr>)}{!orders.length&&<tr><td colSpan={8}>لا توجد طلبات حتى الآن.</td></tr>}</tbody></table></div>
   </section>
  </section>
 </main></div>;
}
