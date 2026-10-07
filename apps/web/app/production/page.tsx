"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Item={id:string;code:string;name:string};
type Shift=Item & {rate_group_name:string};
type Destination={id:string;code:string;name:string;warehouse_id:string;warehouse_code:string;warehouse_name:string};
type Entry={id:string;code:string;work_date:string;quantity:number;rate_snapshot:number;earning_amount:number;status:string;employee_code:string;employee_name:string;product_code:string;product_name:string;stage_code:string;stage_name:string;shift_code:string;shift_name:string;unit_name:string;wage_type_code_snapshot:string;wage_type_method_snapshot:string};

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};

export default function ProductionPage(){
  const { has } = usePermissions();
  const [employees,setEmployees]=useState<Item[]>([]);
  const [products,setProducts]=useState<Item[]>([]);
  const [stages,setStages]=useState<Item[]>([]);
  const [shifts,setShifts]=useState<Shift[]>([]);
  const [destinations,setDestinations]=useState<Destination[]>([]);
  const [entries,setEntries]=useState<Entry[]>([]);
  const [employeeId,setEmployeeId]=useState("");
  const [productId,setProductId]=useState("");
  const [stageId,setStageId]=useState("");
  const [shiftId,setShiftId]=useState("");
  const [workDate,setWorkDate]=useState(new Date().toISOString().slice(0,10));
  const [quantity,setQuantity]=useState("");
  const [baseAmount,setBaseAmount]=useState("");
  const [hoursWorked,setHoursWorked]=useState("");
  const [warehouseId,setWarehouseId]=useState("");
  const [locationId,setLocationId]=useState("");
  const [status,setStatus]=useState("");
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  async function load(){
    setLoading(true); setError("");
    try{
      const [e,p,s,h,d,r]=await Promise.all([
        api<{data:Item[]}>("/api/employees"),
        api<{data:Item[]}>("/api/products"),
        api<{data:Item[]}>("/api/stages"),
        api<{data:Shift[]}>("/api/shifts"),
        api<{data:Destination[]}>("/api/production/destinations"),
        api<{data:Entry[]}>(status?"/api/production?status="+status:"/api/production")
      ]);
      setEmployees(e.data);setProducts(p.data);setStages(s.data);setShifts(h.data);setDestinations(d.data);setEntries(r.data);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الإنتاج");}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load();},[status]);

  async function submit(e:FormEvent){
    e.preventDefault(); setSaving(true); setError("");
    try{
      await api("/api/production",{method:"POST",body:JSON.stringify({
        employeeId:employeeId||undefined,productId,stageId,shiftId,workDate,
        quantity:Number(quantity),baseAmount:baseAmount?Number(baseAmount):undefined,hoursWorked:hoursWorked?Number(hoursWorked):undefined,warehouseId,locationId
      })});
      setQuantity("");setBaseAmount("");setHoursWorked("");await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الإنتاج");}
    finally{setSaving(false);}
  }

  async function review(id:string, action:"approve"|"reject"){
    setError("");
    try{
      if(action==="reject"){
        const reason=window.prompt("سبب الرفض؟");
        if(!reason)return;
        await api("/api/production/"+id+"/reject",{method:"POST",body:JSON.stringify({reason})});
      }else{
        await api("/api/production/"+id+"/approve",{method:"POST"});
      }
      await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ المراجعة");}
  }

  return <div className="app-shell">
    <Sidebar active="/production" />
    <main className="main"><header className="topbar"><div><h1 className="page-title">الإنتاج والأجور</h1><p className="page-subtitle">تسجيل الإنتاج، تحديد السعر تلقائيًا، ثم المراجعة والاعتماد</p></div></header>
      <section className="content">{error&&<div className="alert error">{error}</div>}
        {has("production.create") && <form className="card production-form" onSubmit={submit}>
          <div className="card-header"><h2 className="card-title">تسجيل إنتاج</h2><span className="form-hint">السعر لا يكتبه المستخدم — النظام يحدده من الإعدادات</span></div>
          <div className="production-grid">
            <label>الموظف<select value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">تلقائي من الحساب</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
            <label>المنتج<select value={productId} onChange={e=>setProductId(e.target.value)} required><option value="">اختر المنتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
            <label>المرحلة<select value={stageId} onChange={e=>setStageId(e.target.value)} required><option value="">اختر المرحلة</option>{stages.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
            <label>الوردية<select value={shiftId} onChange={e=>setShiftId(e.target.value)} required><option value="">اختر الوردية</option>{shifts.map(x=><option key={x.id} value={x.id}>{x.name} — {x.rate_group_name}</option>)}</select></label>
            <label>تاريخ الإنتاج<input type="date" value={workDate} onChange={e=>setWorkDate(e.target.value)} required/></label>
            <label>الكمية<input type="number" min="0.001" step="0.001" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
            <label>مخزن دخول الإنتاج<select value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);setLocationId("");}} required><option value="">اختر المخزن</option>{Array.from(new Map(destinations.map(x=>[x.warehouse_id,x])).values()).map(x=><option key={x.warehouse_id} value={x.warehouse_id}>{x.warehouse_name} — {x.warehouse_code}</option>)}</select></label>
            <label>مكان دخول الإنتاج<select value={locationId} onChange={e=>setLocationId(e.target.value)} required><option value="">اختر المكان</option>{destinations.filter(x=>x.warehouse_id===warehouseId).map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>
            <label>قيمة الأساس <span className="optional">(لأجر النسبة فقط)</span><input type="number" min="0" step="0.01" value={baseAmount} onChange={e=>setBaseAmount(e.target.value)} /></label>
            <label>عدد الساعات <span className="optional">(لأجر الساعة فقط)</span><input type="number" min="0.01" step="0.01" value={hoursWorked} onChange={e=>setHoursWorked(e.target.value)} /></label>
          </div>
          <div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ التسجيل...":"تسجيل الإنتاج"}</button></div>
        </form>}

        <section className="card">
          <div className="card-header"><h2 className="card-title">سجل الإنتاج</h2><select className="filter-select" value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات</option><option value="PENDING">معلق</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option></select></div>
          {loading?<div className="empty">جارٍ تحميل السجل...</div>:!entries.length?<div className="empty">لا يوجد إنتاج مسجل.</div>:
          <div className="table-wrap"><table><thead><tr><th>الكود</th><th>التاريخ</th><th>الموظف</th><th>المنتج</th><th>المرحلة</th><th>الوردية</th><th>الكمية</th><th>السعر</th><th>المستحق</th><th>الحالة</th><th>إجراء</th></tr></thead>
          <tbody>{entries.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.work_date}</td><td className="strong">{x.employee_name}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.shift_name}</td><td>{x.quantity} {x.unit_name}</td><td>{x.rate_snapshot}</td><td className="money">{x.earning_amount}</td><td><span className={"status "+x.status.toLowerCase()}>{statusLabel[x.status]||x.status}</span></td><td>{x.status==="PENDING"&&<div className="row-actions">{has("production.approve")&&<button className="approve-button" onClick={()=>review(x.id,"approve")}>اعتماد</button>}{has("production.reject")&&<button className="reject-button" onClick={()=>review(x.id,"reject")}>رفض</button>}</div>}</td></tr>)}</tbody></table></div>}
        </section>
      </section>
    </main>
  </div>
}
