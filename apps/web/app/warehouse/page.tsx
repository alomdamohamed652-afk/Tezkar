"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";

type Item={id:string;code:string;name:string};
type Warehouse=Item & {address:string|null;location_count:number};
type Location=Item & {warehouse_id:string;warehouse_name:string};
type Product=Item & {unit_name?:string};
type Stock={product_code:string;product_name:string;warehouse_name:string;location_name:string;quantity:number;unit_name:string};
type Movement={code:string;movement_type:string;quantity:number;product_name:string;warehouse_name:string;location_name:string;carton_code:string|null;created_at:string;unit_name:string};

const labels:Record<string,string>={IN:"وارد",OUT:"صرف",RETURN:"مرتجع",ADJUSTMENT:"تسوية",TRANSFER_OUT:"تحويل"};

export default function WarehousePage(){
 const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
 const [locations,setLocations]=useState<Location[]>([]);
 const [products,setProducts]=useState<Product[]>([]);
 const [stock,setStock]=useState<Stock[]>([]);
 const [movements,setMovements]=useState<Movement[]>([]);
 const [warehouseId,setWarehouseId]=useState("");
 const [locationId,setLocationId]=useState("");
 const [productId,setProductId]=useState("");
 const [movementType,setMovementType]=useState("IN");
 const [quantity,setQuantity]=useState("");
 const [cartonCode,setCartonCode]=useState("");
 const [notes,setNotes]=useState("");
 const [newWarehouse,setNewWarehouse]=useState("");
 const [newLocation,setNewLocation]=useState("");
 const [error,setError]=useState("");
 const [saving,setSaving]=useState(false);

 async function load(){
  setError("");
  try{
   const [w,l,p,s,m]=await Promise.all([api<{data:Warehouse[]}>("/api/warehouses"),api<{data:Location[]}>("/api/warehouse/locations"),api<{data:Product[]}>("/api/products"),api<{data:Stock[]}>("/api/warehouse/stock"),api<{data:Movement[]}>("/api/warehouse/movements")]);
   setWarehouses(w.data);setLocations(l.data);setProducts(p.data);setStock(s.data);setMovements(m.data);
   if(!warehouseId&&w.data[0])setWarehouseId(w.data[0].id);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل المخزن");}
 }
 useEffect(()=>{void load()},[]);

 async function addWarehouse(e:FormEvent){e.preventDefault();if(!newWarehouse.trim())return;try{await api("/api/warehouses",{method:"POST",body:JSON.stringify({name:newWarehouse})});setNewWarehouse("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إضافة المخزن")}}
 async function addLocation(e:FormEvent){e.preventDefault();if(!warehouseId||!newLocation.trim())return;try{await api("/api/warehouse/locations",{method:"POST",body:JSON.stringify({warehouseId,code:newLocation.toUpperCase(),name:newLocation})});setNewLocation("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إضافة المكان")}}
 async function addMovement(e:FormEvent){e.preventDefault();if(!productId||!warehouseId||!locationId||!quantity)return;setSaving(true);setError("");try{await api("/api/warehouse/movements",{method:"POST",body:JSON.stringify({movementType,productId,warehouseId,locationId,quantity:Number(quantity),cartonCode:cartonCode||null,notes:notes||null})});setQuantity("");setCartonCode("");setNotes("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الحركة")}finally{setSaving(false)}}
 const currentLocations=locations.filter(x=>x.warehouse_id===warehouseId);

 return <div className="app-shell">
  <aside className="sidebar"><div className="brand"><div className="brand-mark"/><div className="brand-copy"><div className="brand-name">تيزكار</div><div className="brand-sub">إدارة المصنع</div></div></div><div className="nav-title">النظام</div><nav className="nav">
   <a className="nav-item" href="/"><span className="nav-icon">⌂</span><span>الرئيسية</span></a><a className="nav-item" href="/employees"><span className="nav-icon">▣</span><span>الموظفون</span></a><a className="nav-item" href="/production"><span className="nav-icon">▤</span><span>الإنتاج</span></a><a className="nav-item active" href="/warehouse"><span className="nav-icon">▥</span><span>المخزن</span></a><a className="nav-item" href="/payments"><span className="nav-icon">₤</span><span>القبض والمدفوعات</span></a><a className="nav-item" href="/settings"><span className="nav-icon">⚙</span><span>الإعدادات</span></a>
  </nav></aside>
  <main className="main"><header className="topbar"><div><h1 className="page-title">المخزن</h1><p className="page-subtitle">الأرصدة وحركات الوارد والصرف والتسويات</p></div></header><section className="content">
   {error&&<div className="alert error">{error}</div>}
   <div className="stats"><article className="card stat"><div className="stat-label">المخازن</div><div className="stat-value">{warehouses.length}</div><div className="stat-note">المخازن النشطة</div></article><article className="card stat accent"><div className="stat-label">أرصدة بها مخزون</div><div className="stat-value">{stock.length}</div><div className="stat-note">حسب المنتج والمكان</div></article><article className="card stat warning"><div className="stat-label">حركات مسجلة</div><div className="stat-value">{movements.length}</div><div className="stat-note">آخر 100 حركة</div></article></div>
   <section className="card form-card"><div className="card-header"><h2 className="card-title">تسجيل حركة</h2></div><form className="production-grid" onSubmit={addMovement}>
    <label>نوع الحركة<select value={movementType} onChange={e=>setMovementType(e.target.value)}>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
    <label>المنتج<select value={productId} onChange={e=>setProductId(e.target.value)}><option value="">اختر المنتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
    <label>المخزن<select value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);setLocationId("")}}><option value="">اختر المخزن</option>{warehouses.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <label>المكان<select value={locationId} onChange={e=>setLocationId(e.target.value)}><option value="">اختر المكان</option>{currentLocations.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
    <label>الكمية<input type="number" min="0.001" step="0.001" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
    <label>كود الكرتونة <span className="optional">اختياري الآن</span><input value={cartonCode} onChange={e=>setCartonCode(e.target.value)} placeholder="مثال CTN-000123"/></label>
    <label>ملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)}/></label>
    <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الحفظ...":"تسجيل الحركة"}</button></div>
   </form></section>
   <div className="grid">
    <section className="card"><div className="card-header"><h2 className="card-title">الأرصدة الحالية</h2></div><div className="table-wrap"><table><thead><tr><th>المنتج</th><th>المخزن</th><th>المكان</th><th>الرصيد</th></tr></thead><tbody>{stock.map((x,i)=><tr key={i}><td className="strong">{x.product_name}<div className="form-hint">{x.product_code}</div></td><td>{x.warehouse_name}</td><td>{x.location_name}</td><td className="money">{x.quantity} {x.unit_name}</td></tr>)}{!stock.length&&<tr><td colSpan={4}>لا يوجد مخزون مسجل.</td></tr>}</tbody></table></div></section>
    <section className="card"><div className="card-header"><h2 className="card-title">آخر الحركات</h2></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>النوع</th><th>المنتج</th><th>الكمية</th><th>التاريخ</th></tr></thead><tbody>{movements.map(x=><tr key={x.code}><td className="mono">{x.code}</td><td>{labels[x.movement_type]||x.movement_type}</td><td>{x.product_name}</td><td>{x.quantity} {x.unit_name}</td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td></tr>)}{!movements.length&&<tr><td colSpan={5}>لا توجد حركات.</td></tr>}</tbody></table></div></section>
   </div>
   <div className="grid" style={{marginTop:16}}><section className="card"><div className="card-header"><h2 className="card-title">إضافة مخزن</h2></div><form className="inline-form" onSubmit={addWarehouse}><input value={newWarehouse} onChange={e=>setNewWarehouse(e.target.value)} placeholder="اسم المخزن"/><button className="primary-button">إضافة</button></form></section><section className="card"><div className="card-header"><h2 className="card-title">إضافة مكان للمخزن الحالي</h2></div><form className="inline-form" onSubmit={addLocation}><input value={newLocation} onChange={e=>setNewLocation(e.target.value)} placeholder="مثال A-01"/><button className="primary-button" disabled={!warehouseId}>إضافة</button></form></section></div>
  </section></main>
 </div>
}