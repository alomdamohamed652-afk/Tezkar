"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";

type Row = { id:string; code:string; name:string; is_active:boolean };
type Department = Row & { employee_count:number };
type Job = Row & { department_id:string|null; department_name:string|null };
type RateGroup = Row & { description:string|null };
type Shift = Row & { start_time:string; end_time:string; crosses_midnight:boolean; rate_group_id:string; rate_group_name:string };
type Unit = Row & { symbol:string|null; decimal_places:number };
type Stage = Row & { description:string|null };
type WageType = Row & { method:string; percentage_base:string|null };
type Product = Row & { product_type:string; unit_id:string; unit_name:string; category_name:string|null; minimum_stock:number; track_inventory:boolean };

const productTypes = [["RAW_MATERIAL","خامة"],["COMPONENT","مكوّن"],["FINISHED_GOOD","منتج تام"],["SERVICE","خدمة"],["CONSUMABLE","مستهلك"]];

export default function MasterDataPage() {
  const [tab,setTab]=useState("organization");
  const [departments,setDepartments]=useState<Department[]>([]);
  const [jobs,setJobs]=useState<Job[]>([]);
  const [groups,setGroups]=useState<RateGroup[]>([]);
  const [shifts,setShifts]=useState<Shift[]>([]);
  const [units,setUnits]=useState<Unit[]>([]);
  const [stages,setStages]=useState<Stage[]>([]);
  const [wageTypes,setWageTypes]=useState<WageType[]>([]);
  const [products,setProducts]=useState<Product[]>([]);
  const [error,setError]=useState("");
  const [saving,setSaving]=useState("");

  const [deptCode,setDeptCode]=useState(""); const [deptName,setDeptName]=useState("");
  const [jobCode,setJobCode]=useState(""); const [jobName,setJobName]=useState(""); const [jobDept,setJobDept]=useState("");
  const [groupName,setGroupName]=useState(""); const [stageName,setStageName]=useState("");
  const [productName,setProductName]=useState(""); const [productType,setProductType]=useState("FINISHED_GOOD"); const [productUnit,setProductUnit]=useState("");
  const [outputStage,setOutputStage]=useState(""); const [outputProduct,setOutputProduct]=useState(""); const [stageOutputs,setStageOutputs]=useState<any[]>([]);

  async function loadAll(){
    setError("");
    try{
      const [d,j,g,s,u,st,w,p]=await Promise.all([
        api<{data:Department[]}>("/api/departments"), api<{data:Job[]}>("/api/job-titles"),
        api<{data:RateGroup[]}>("/api/rate-groups"), api<{data:Shift[]}>("/api/shifts"),
        api<{data:Unit[]}>("/api/units"), api<{data:Stage[]}>("/api/stages"),
        api<{data:WageType[]}>("/api/wage-types"), api<{data:Product[]}>("/api/products")
      ]);
      setDepartments(d.data); setJobs(j.data); setGroups(g.data); setShifts(s.data);
      setUnits(u.data); setStages(st.data); setWageTypes(w.data); setProducts(p.data);
      if(!productUnit && u.data[0]) setProductUnit(u.data[0].id);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البيانات");}
  }
  useEffect(()=>{void loadAll();},[]);
  useEffect(()=>{if(!outputStage){setStageOutputs([]);return;} api<{data:any[]}>(`/api/stages/${outputStage}/outputs`).then(x=>setStageOutputs(x.data)).catch(()=>setStageOutputs([]));},[outputStage]);

  async function addStageOutput(e:FormEvent){e.preventDefault();setError("");try{await api(`/api/stages/${outputStage}/outputs`,{method:"POST",body:JSON.stringify({productId:outputProduct,isDefault:true})});const x=await api<{data:any[]}>(`/api/stages/${outputStage}/outputs`);setStageOutputs(x.data);}catch(e){setError(e instanceof Error?e.message:"تعذر ربط المنتج بالمرحلة");}}
  async function submit(e:FormEvent, kind:string){
    e.preventDefault(); setSaving(kind); setError("");
    try{
      if(kind==="department"){await api("/api/departments",{method:"POST",body:JSON.stringify({code:deptCode,name:deptName})});setDeptCode("");setDeptName("");}
      if(kind==="job"){await api("/api/job-titles",{method:"POST",body:JSON.stringify({code:jobCode,name:jobName,departmentId:jobDept||null})});setJobCode("");setJobName("");}
      if(kind==="group"){await api("/api/rate-groups",{method:"POST",body:JSON.stringify({name:groupName})});setGroupName("");}
      if(kind==="stage"){await api("/api/stages",{method:"POST",body:JSON.stringify({name:stageName})});setStageName("");}
      if(kind==="product"){await api("/api/products",{method:"POST",body:JSON.stringify({name:productName,productType,unitId:productUnit,minimumStock:0,trackInventory:true})});setProductName("");}
      await loadAll();
    }catch(e){setError(e instanceof Error?e.message:"تعذر الحفظ");}finally{setSaving("");}
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"/><div className="brand-copy"><div className="brand-name">تذكار</div><div className="brand-sub">إدارة المصنع</div></div></div><div className="nav-title">النظام</div><nav className="nav">
      <a className="nav-item" href="/"><span className="nav-icon">⌂</span><span>الرئيسية</span></a>
      <a className="nav-item" href="/employees"><span className="nav-icon">▣</span><span>الموظفون</span></a>
      <a className="nav-item active" href="/master-data"><span className="nav-icon">⚙</span><span>البيانات الأساسية</span></a>
      {["الإنتاج","المخزن","المشتريات","الطلبات","المالية","التقارير"].map(x=><a className="nav-item" href="#" key={x}><span className="nav-icon">•</span><span>{x}</span></a>)}
    </nav></aside>
    <main className="main"><header className="topbar"><div><h1 className="page-title">البيانات الأساسية</h1><p className="page-subtitle">المعلومات المرجعية التي يعتمد عليها التشغيل وباقي وحدات النظام</p></div></header>
      <section className="content">{error&&<div className="alert error">{error}</div>}
        <div className="tabs">
          <button className={"tab "+(tab==="organization"?"active":"")} onClick={()=>setTab("organization")}>الهيكل الإداري</button>
          <button className={"tab "+(tab==="production"?"active":"")} onClick={()=>setTab("production")}>التشغيل والأجور</button>
          <button className={"tab "+(tab==="products"?"active":"")} onClick={()=>setTab("products")}>المنتجات والوحدات</button>
        </div>

        {tab==="organization"&&<div className="master-grid">
          <section className="card"><div className="card-header"><h2 className="card-title">الأقسام</h2><span className="count-badge">{departments.length}</span></div>
            <form className="inline-form" onSubmit={e=>submit(e,"department")}><input placeholder="كود القسم" value={deptCode} onChange={e=>setDeptCode(e.target.value)} required/><input placeholder="اسم القسم" value={deptName} onChange={e=>setDeptName(e.target.value)} required/><button className="primary-button">إضافة</button></form><List rows={departments.map(x=>({code:x.code,name:x.name,extra:String(x.employee_count)+" موظف"}))}/></section>
          <section className="card"><div className="card-header"><h2 className="card-title">الوظائف</h2><span className="count-badge">{jobs.length}</span></div>
            <form className="inline-form" onSubmit={e=>submit(e,"job")}><input placeholder="كود الوظيفة" value={jobCode} onChange={e=>setJobCode(e.target.value)} required/><input placeholder="اسم الوظيفة" value={jobName} onChange={e=>setJobName(e.target.value)} required/><select value={jobDept} onChange={e=>setJobDept(e.target.value)}><option value="">بدون قسم</option>{departments.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><button className="primary-button">إضافة</button></form><List rows={jobs.map(x=>({code:x.code,name:x.name,extra:x.department_name||"بدون قسم"}))}/></section>
        </div>}

        {tab==="production"&&<div className="master-grid">
          <section className="card"><div className="card-header"><h2 className="card-title">مجموعات الأجور</h2><span className="count-badge">{groups.length}</span></div><form className="inline-form" onSubmit={e=>submit(e,"group")}><input placeholder="اسم مجموعة الأجر" value={groupName} onChange={e=>setGroupName(e.target.value)} required/><button className="primary-button">إضافة</button></form><List rows={groups.map(x=>({code:x.code,name:x.name,extra:x.is_active?"نشطة":"غير نشطة"}))}/></section>
          <section className="card"><div className="card-header"><h2 className="card-title">مراحل الإنتاج</h2><span className="count-badge">{stages.length}</span></div><form className="inline-form" onSubmit={e=>submit(e,"stage")}><input placeholder="اسم المرحلة" value={stageName} onChange={e=>setStageName(e.target.value)} required/><button className="primary-button">إضافة</button></form><List rows={stages.map(x=>({code:x.code,name:x.name,extra:x.is_active?"نشطة":"غير نشطة"}))}/></section>
          <section className="card"><div className="card-header"><h2 className="card-title">الورديات</h2><span className="count-badge">{shifts.length}</span></div><List rows={shifts.map(x=>({code:x.code,name:x.name,extra:x.start_time.slice(0,5)+" — "+x.end_time.slice(0,5)+" · "+x.rate_group_name}))}/></section>
          <section className="card"><div className="card-header"><h2 className="card-title">أنواع الأجور</h2><span className="count-badge">{wageTypes.length}</span></div><List rows={wageTypes.map(x=>({code:x.code,name:x.name,extra:x.method}))}/></section>
        </div>}

          <section className="card settings-wide"><div className="card-header"><h2 className="card-title">مخرجات المراحل</h2><span className="count-badge">{stageOutputs.length}</span></div><form className="inline-form" onSubmit={addStageOutput}><select value={outputStage} onChange={e=>setOutputStage(e.target.value)} required><option value="">اختر المرحلة</option>{stages.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><select value={outputProduct} onChange={e=>setOutputProduct(e.target.value)} required><option value="">المنتج الناتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><button className="primary-button">ربط المنتج بالمرحلة</button></form><List rows={stageOutputs.map(x=>({code:x.product_code,name:x.product_name,extra:"منتج ناتج"}))}/></section>
        {tab==="products"&&<div className="master-grid">
          <section className="card"><div className="card-header"><h2 className="card-title">إضافة منتج</h2></div><form className="stack-form" onSubmit={e=>submit(e,"product")}><input placeholder="اسم المنتج" value={productName} onChange={e=>setProductName(e.target.value)} required/><select value={productType} onChange={e=>setProductType(e.target.value)}>{productTypes.map(x=><option key={x[0]} value={x[0]}>{x[1]}</option>)}</select><select value={productUnit} onChange={e=>setProductUnit(e.target.value)} required><option value="">وحدة القياس</option>{units.map(x=><option key={x.id} value={x.id}>{x.name}{x.symbol?" ("+x.symbol+")":""}</option>)}</select><button className="primary-button">حفظ المنتج</button></form></section>
          <section className="card"><div className="card-header"><h2 className="card-title">المنتجات</h2><span className="count-badge">{products.length}</span></div><List rows={products.map(x=>({code:x.code,name:x.name,extra:x.unit_name+" · "+x.product_type}))}/></section>
          <section className="card"><div className="card-header"><h2 className="card-title">وحدات القياس</h2><span className="count-badge">{units.length}</span></div><List rows={units.map(x=>({code:x.code,name:x.name,extra:x.symbol||"—"}))}/></section>
        </div>}
      </section>
    </main>
  </div>;
}

function List({rows}:{rows:{code:string;name:string;extra:string}[]}){
  if(!rows.length)return <div className="empty small-empty">لا توجد بيانات حتى الآن.</div>;
  return <div className="master-list">{rows.map(r=><div className="master-row" key={r.code}><span className="mono">{r.code}</span><strong>{r.name}</strong><span>{r.extra}</span></div>)}</div>;
}
