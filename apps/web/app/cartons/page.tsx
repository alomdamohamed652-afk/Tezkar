"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Item={id:string;code:string;name:string};
type Location=Item & {warehouse_id:string};
type Carton={id:string;code:string;barcode:string|null;product_name:string;product_code:string;warehouse_name:string;location_name:string;quantity:number;unit_name:string;weight:number|null;status:string;created_at:string};

const labels:Record<string,string>={OPEN:"مفتوحة",SEALED:"مغلقة",PARTIAL:"جزئي",EMPTY:"فارغة"};

export default function CartonsPage(){
 const {has}=usePermissions();
 const [products,setProducts]=useState<Item[]>([]),[warehouses,setWarehouses]=useState<Item[]>([]),[locations,setLocations]=useState<Location[]>([]),[items,setItems]=useState<Carton[]>([]);
 const [productId,setProductId]=useState(""),[warehouseId,setWarehouseId]=useState(""),[locationId,setLocationId]=useState(""),[quantity,setQuantity]=useState(""),[weight,setWeight]=useState(""),[barcode,setBarcode]=useState(""),[status,setStatus]=useState("OPEN"),[error,setError]=useState(""),[saving,setSaving]=useState(false);

 async function load(){
  try{
   const [p,w,l,c]=await Promise.all([
    api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/warehouses"),
    api<{data:Location[]}>("/api/warehouse/locations"),api<{data:Carton[]}>("/api/warehouse/cartons")
   ]);
   setProducts(p.data);setWarehouses(w.data);setLocations(l.data);setItems(c.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الكرتونات")}
 }
 useEffect(()=>{void load()},[]);
 async function create(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   await api("/api/warehouse/cartons",{method:"POST",body:JSON.stringify({
    productId,warehouseId,locationId,quantity:Number(quantity),weight:weight?Number(weight):null,
    barcode:barcode.trim()||null,status
   })});
   setProductId("");setQuantity("");setWeight("");setBarcode("");setStatus("OPEN");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء الكرتونة")}finally{setSaving(false)}
 }
 const currentLocations=locations.filter(x=>x.warehouse_id===warehouseId);
 return <div className="app-shell">
  <Sidebar active="/cartons"/>
  <main className="main">
   <header className="topbar"><div><h1 className="page-title">الكرتونات</h1><p className="page-subtitle">تعبئة وتتبع الكرتونات وأكوادها وحالتها</p></div></header>
   <section className="content">
    {error&&<div className="alert error">{error}</div>}
    {has("cartons.manage")&&<form className="card form-card" onSubmit={create}>
     <div className="card-header"><h2 className="card-title">تعبئة كرتونة</h2><span className="form-hint">الكمية يجب أن تكون متاحة في رصيد المكان</span></div>
     <div className="form-grid">
      <label>المنتج<select value={productId} onChange={e=>setProductId(e.target.value)} required><option value="">اختر المنتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
      <label>المخزن<select value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);setLocationId("")}} required><option value="">اختر المخزن</option>{warehouses.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>المكان<select value={locationId} onChange={e=>setLocationId(e.target.value)} required><option value="">اختر المكان</option>{currentLocations.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
      <label>الكمية<input type="number" min="0.001" step="0.001" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
      <label>الوزن <span className="optional">اختياري</span><input type="number" min="0" step="0.001" value={weight} onChange={e=>setWeight(e.target.value)}/></label>
      <label>Barcode <span className="optional">اختياري</span><input value={barcode} onChange={e=>setBarcode(e.target.value)} placeholder="سيتم استخدام كود الكرتونة إذا لم تضف واحدًا لاحقًا"/></label>
      <label>الحالة<select value={status} onChange={e=>setStatus(e.target.value)}><option value="OPEN">مفتوحة</option><option value="SEALED">مغلقة</option></select></label>
     </div>
     <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الحفظ...":"إنشاء الكرتونة"}</button></div>
    </form>}
    <section className="card"><div className="card-header"><h2 className="card-title">سجل الكرتونات</h2><span className="count-badge">{items.length}</span></div>
     <div className="table-wrap"><table><thead><tr><th>الكود</th><th>Barcode</th><th>المنتج</th><th>المخزن / المكان</th><th>الكمية</th><th>الوزن</th><th>الحالة</th><th>التاريخ</th></tr></thead>
      <tbody>{items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="mono">{x.barcode||"—"}</td><td className="strong">{x.product_name}<div className="form-hint">{x.product_code}</div></td><td>{x.warehouse_name} / {x.location_name}</td><td>{x.quantity} {x.unit_name}</td><td>{x.weight??"—"}</td><td><span className={"status "+x.status.toLowerCase()}>{labels[x.status]||x.status}</span></td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td></tr>)}{!items.length&&<tr><td colSpan={8}>لا توجد كرتونات.</td></tr>}</tbody>
     </table></div>
    </section>
   </section>
  </main>
 </div>
}
