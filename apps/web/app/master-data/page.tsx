
"use client";

import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Row={id:string;code:string;name:string;is_active:boolean};
type Department=Row&{employee_count:number};
type Job=Row&{department_name:string|null};
type Group=Row&{description:string|null};
type Shift=Row&{rate_group_name:string};
type Unit=Row&{symbol:string|null};
type Stage=Row&{description:string|null};
type Wage=Row&{method:string};
type Product=Row&{product_type:string;unit_id:string;unit_name:string;category_id:string|null;category_name:string|null};
type Category=Row&{category_type:string};
type ProdType=Row&{calculation_method:string};
type Rate={id:string;code:string;rate:number;effective_range:string;product_name:string|null;stage_name:string;production_type_name:string|null;rate_group_name:string|null;wage_type_name:string;unit_name:string};

const categoryTypes=[["PRODUCT","منتج"],["RAW_MATERIAL","خامة"],["PRODUCTION_SUPPLY","مستلزم إنتاج"],["OPERATING_SUPPLY","مستلزم تشغيل"]];
const productTypes=[["RAW_MATERIAL","خامة"],["COMPONENT","مكوّن"],["FINISHED_GOOD","منتج تام"],["SERVICE","خدمة"],["CONSUMABLE","مستهلك"]];

export default function MasterDataPage(){
 const [tab,setTab]=useState("products"),[departments,setDepartments]=useState<Department[]>([]),[jobs,setJobs]=useState<Job[]>([]),[groups,setGroups]=useState<Group[]>([]),[shifts,setShifts]=useState<Shift[]>([]),[units,setUnits]=useState<Unit[]>([]),[stages,setStages]=useState<Stage[]>([]),[wages,setWages]=useState<Wage[]>([]),[products,setProducts]=useState<Product[]>([]),[categories,setCategories]=useState<Category[]>([]),[types,setTypes]=useState<ProdType[]>([]),[rates,setRates]=useState<Rate[]>([]);
 const [error,setError]=useState("");
 const [categoryName,setCategoryName]=useState(""),[categoryType,setCategoryType]=useState("PRODUCT"),[productName,setProductName]=useState(""),[productType,setProductType]=useState("FINISHED_GOOD"),[productUnit,setProductUnit]=useState(""),[productCategory,setProductCategory]=useState("");
 const [stageName,setStageName]=useState(""),[typeCode,setTypeCode]=useState(""),[typeName,setTypeName]=useState(""),[typeMethod,setTypeMethod]=useState("PER_QUANTITY");
 const [rateProduct,setRateProduct]=useState(""),[rateStage,setRateStage]=useState(""),[rateType,setRateType]=useState(""),[rateGroup,setRateGroup]=useState(""),[rateWage,setRateWage]=useState(""),[rateUnit,setRateUnit]=useState(""),[rateValue,setRateValue]=useState(""),[rateFrom,setRateFrom]=useState(new Date().toISOString().slice(0,10)),[rateTo,setRateTo]=useState("");
 const [outStage,setOutStage]=useState(""),[outProduct,setOutProduct]=useState(""),[stageOutputs,setStageOutputs]=useState<any[]>([]);

 async function load(){
  setError("");
  try{
   const [d,j,g,s,u,st,w,p,c,t,r]=await Promise.all([
    api<{data:Department[]}>("/api/departments"),api<{data:Job[]}>("/api/job-titles"),api<{data:Group[]}>("/api/rate-groups"),api<{data:Shift[]}>("/api/shifts"),api<{data:Unit[]}>("/api/units"),api<{data:Stage[]}>("/api/stages"),api<{data:Wage[]}>("/api/wage-types"),api<{data:Product[]}>("/api/products"),api<{data:Category[]}>("/api/product-categories"),api<{data:ProdType[]}>("/api/production-types"),api<{data:Rate[]}>("/api/rates")
   ]);
   setDepartments(d.data);setJobs(j.data);setGroups(g.data);setShifts(s.data);setUnits(u.data);setStages(st.data);setWages(w.data);setProducts(p.data);setCategories(c.data);setTypes(t.data);setRates(r.data);
   if(!productUnit)setProductUnit(u.data[0]?.id||"");if(!rateUnit)setRateUnit(u.data[0]?.id||"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البيانات")}
 }
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(!outStage){setStageOutputs([]);return}api<{data:any[]}>("/api/stages/"+outStage+"/outputs").then(x=>setStageOutputs(x.data)).catch(()=>setStageOutputs([]))},[outStage]);

 async function save(path:string,body:any){setError("");try{await api(path,{method:"POST",body:JSON.stringify(body)});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر الحفظ")}}
 async function submit(e:FormEvent,kind:string){e.preventDefault();
  if(kind==="category"){await save("/api/product-categories",{name:categoryName,categoryType});setCategoryName("");return}
  if(kind==="product"){await save("/api/products",{name:productName,productType,unitId:productUnit,categoryId:productCategory||null,minimumStock:0,trackInventory:true});setProductName("");return}
  if(kind==="stage"){await save("/api/stages",{name:stageName});setStageName("");return}
  if(kind==="type"){await save("/api/production-types",{code:typeCode,name:typeName,calculationMethod:typeMethod});setTypeCode("");setTypeName("");return}
  if(kind==="rate"){await save("/api/rates",{productId:rateProduct||null,stageId:rateStage,productionTypeId:rateType||null,rateGroupId:rateGroup||null,wageTypeId:rateWage,unitId:rateUnit,rate:Number(rateValue),effectiveFrom:rateFrom,effectiveTo:rateTo||null});setRateValue("");return}
 }
 async function addOutput(e:FormEvent){e.preventDefault();try{await api("/api/stages/"+outStage+"/outputs",{method:"POST",body:JSON.stringify({productId:outProduct,isDefault:true})});const x=await api<{data:any[]}>("/api/stages/"+outStage+"/outputs");setStageOutputs(x.data)}catch(e){setError(e instanceof Error?e.message:"تعذر ربط المنتج")}}
 const productOptions=useMemo(()=>products.map(x=>({value:x.id,label:x.name})),[products]),stageOptions=useMemo(()=>stages.map(x=>({value:x.id,label:x.name})),[stages]),unitOptions=useMemo(()=>units.map(x=>({value:x.id,label:x.name})),[units]),typeOptions=useMemo(()=>types.map(x=>({value:x.id,label:x.name})),[types]);

 return <div className="app-shell"><Sidebar active="/master-data"/><main className="main"><header className="topbar"><div><h1 className="page-title">البيانات الأساسية</h1><p className="page-subtitle">تعريف المنتجات والخامات والمراحل وأنواع الإنتاج وأسعار التشغيل.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}
  <div className="tabs"><button className={"tab "+(tab==="products"?"active":"")} onClick={()=>setTab("products")}>المنتجات والتصنيفات</button><button className={"tab "+(tab==="production"?"active":"")} onClick={()=>setTab("production")}>المراحل وأنواع الإنتاج</button><button className={"tab "+(tab==="rates"?"active":"")} onClick={()=>setTab("rates")}>أسعار المراحل</button><button className={"tab "+(tab==="organization"?"active":"")} onClick={()=>setTab("organization")}>الهيكل الإداري</button></div>

  {tab==="products"&&<div className="master-grid">
   <section className="card"><div className="card-header"><h2 className="card-title">إضافة تصنيف</h2></div><form className="stack-form" onSubmit={e=>submit(e,"category")}><input value={categoryName} onChange={e=>setCategoryName(e.target.value)} placeholder="اسم التصنيف" required/><select value={categoryType} onChange={e=>setCategoryType(e.target.value)}>{categoryTypes.map(x=><option key={x[0]} value={x[0]}>{x[1]}</option>)}</select><button className="primary-button">إضافة التصنيف</button></form><List rows={categories.map(x=>({code:x.code,name:x.name,extra:categoryTypes.find(t=>t[0]===x.category_type)?.[1]||x.category_type}))}/></section>
   <section className="card"><div className="card-header"><h2 className="card-title">إضافة منتج / خامة</h2></div><form className="stack-form" onSubmit={e=>submit(e,"product")}><input value={productName} onChange={e=>setProductName(e.target.value)} placeholder="اسم المنتج" required/><SearchableSelect value={productCategory} onChange={setProductCategory} options={categories.map(x=>({value:x.id,label:x.name,meta:categoryTypes.find(t=>t[0]===x.category_type)?.[1]}))} placeholder="التصنيف"/><select value={productType} onChange={e=>setProductType(e.target.value)}>{productTypes.map(x=><option key={x[0]} value={x[0]}>{x[1]}</option>)}</select><SearchableSelect value={productUnit} onChange={setProductUnit} options={unitOptions} placeholder="وحدة القياس"/><button className="primary-button">حفظ</button></form></section>
   <section className="card settings-wide"><div className="card-header"><h2 className="card-title">المنتجات</h2><span className="count-badge">{products.length}</span></div><div className="master-list">{products.map(x=><div className="master-row" key={x.id}><strong>{x.name}</strong><span>{x.category_name||"بدون تصنيف"}</span><span>{x.unit_name}</span></div>)}</div></section>
  </div>}

  {tab==="production"&&<div className="master-grid">
   <section className="card"><div className="card-header"><h2 className="card-title">مراحل الإنتاج</h2></div><form className="inline-form" onSubmit={e=>submit(e,"stage")}><input value={stageName} onChange={e=>setStageName(e.target.value)} placeholder="مثال: طباعة المقلمة" required/><button className="primary-button">إضافة</button></form><List rows={stages.map(x=>({code:x.code,name:x.name,extra:"مرحلة"}))}/></section>
   <section className="card"><div className="card-header"><h2 className="card-title">أنواع الإنتاج</h2></div><form className="stack-form" onSubmit={e=>submit(e,"type")}><input value={typeCode} onChange={e=>setTypeCode(e.target.value)} placeholder="كود داخلي مثل PRINTING" required/><input value={typeName} onChange={e=>setTypeName(e.target.value)} placeholder="اسم النوع مثل طباعة" required/><select value={typeMethod} onChange={e=>setTypeMethod(e.target.value)}><option value="PER_QUANTITY">بالكمية</option><option value="PER_1000">لكل 1000</option><option value="PER_HOUR">بالساعة</option><option value="PER_DAY">باليومية</option><option value="PERCENTAGE">نسبة</option></select><button className="primary-button">إضافة النوع</button></form><List rows={types.map(x=>({code:x.code,name:x.name,extra:x.calculation_method}))}/></section>
   <section className="card settings-wide"><div className="card-header"><h2 className="card-title">منتج كل مرحلة</h2></div><form className="inline-form" onSubmit={addOutput}><SearchableSelect value={outStage} onChange={setOutStage} options={stageOptions} placeholder="اختر المرحلة"/><SearchableSelect value={outProduct} onChange={setOutProduct} options={productOptions} placeholder="اختر المنتج الناتج"/><button className="primary-button">ربط</button></form><List rows={stageOutputs.map(x=>({code:x.product_code,name:x.product_name,extra:"ناتج المرحلة"}))}/></section>
  </div>}

  {tab==="rates"&&<div className="master-grid">
   <section className="card settings-wide"><div className="card-header"><div><h2 className="card-title">سعر مرحلة الإنتاج</h2><div className="form-hint">مثال: طباعة المقلمة لكل 1000 قطعة = 50 جنيه. السعر يتحدد تلقائيًا وقت تسجيل الإنتاج.</div></div></div>
    <form className="production-grid" onSubmit={e=>submit(e,"rate")}>
     <label>المنتج<SearchableSelect value={rateProduct} onChange={setRateProduct} options={productOptions} placeholder="اختياري — كل المنتجات"/></label><label>المرحلة<SearchableSelect value={rateStage} onChange={setRateStage} options={stageOptions} placeholder="اختر المرحلة"/></label><label>نوع الإنتاج<SearchableSelect value={rateType} onChange={setRateType} options={typeOptions} placeholder="اختياري"/></label><label>مجموعة الأجر<select value={rateGroup} onChange={e=>setRateGroup(e.target.value)}><option value="">كل المجموعات</option>{groups.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>نوع الأجر<select value={rateWage} onChange={e=>setRateWage(e.target.value)} required><option value="">اختر</option>{wages.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>وحدة السعر<SearchableSelect value={rateUnit} onChange={setRateUnit} options={unitOptions} placeholder="اختر الوحدة"/></label><label>السعر<input inputMode="decimal" value={rateValue} onChange={e=>setRateValue(e.target.value)} required placeholder="مثال 50"/></label><label>من تاريخ<input type="date" value={rateFrom} onChange={e=>setRateFrom(e.target.value)} required/></label><label>حتى تاريخ<input type="date" value={rateTo} onChange={e=>setRateTo(e.target.value)}/></label><div className="form-actions"><button className="primary-button">حفظ سعر المرحلة</button></div>
    </form>
   </section>
   <section className="card settings-wide"><div className="card-header"><h2 className="card-title">الأسعار الحالية</h2><span className="count-badge">{rates.length}</span></div><div className="table-wrap"><table><thead><tr><th>المرحلة</th><th>المنتج</th><th>نوع الإنتاج</th><th>طريقة الأجر</th><th>السعر</th><th>الفترة</th></tr></thead><tbody>{rates.map(x=><tr key={x.id}><td>{x.stage_name}</td><td>{x.product_name||"كل المنتجات"}</td><td>{x.production_type_name||"عام"}</td><td>{x.wage_type_name}</td><td className="money">{x.rate} / {x.unit_name}</td><td>{x.effective_range}</td></tr>)}</tbody></table></div></section>
  </div>}

  {tab==="organization"&&<div className="master-grid"><section className="card"><div className="card-header"><h2 className="card-title">الأقسام</h2></div><List rows={departments.map(x=>({code:x.code,name:x.name,extra:String(x.employee_count)+" موظف"}))}/></section><section className="card"><div className="card-header"><h2 className="card-title">الوظائف</h2></div><List rows={jobs.map(x=>({code:x.code,name:x.name,extra:x.department_name||"بدون قسم"}))}/></section><section className="card"><div className="card-header"><h2 className="card-title">الورديات</h2></div><List rows={shifts.map(x=>({code:x.code,name:x.name,extra:x.rate_group_name}))}/></section></div>}
 </section></main></div>;
}

function List({rows}:{rows:{code:string;name:string;extra:string}[]}){
 if(!rows.length)return <div className="empty small-empty">لا توجد بيانات.</div>;
 return <div className="master-list">{rows.map((r,i)=><div className="master-row" key={r.code+"-"+i}><span className="mono">{r.code}</span><strong>{r.name}</strong><span>{r.extra}</span></div>)}</div>
}
