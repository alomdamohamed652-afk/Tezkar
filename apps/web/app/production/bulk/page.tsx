"use client";

import {useEffect,useMemo,useState} from "react";
import {api} from "../../../lib/api";
import {Sidebar} from "../../../components/sidebar";
import {SearchableSelect} from "../../../components/searchable-select";

type Cand={id:string;label:string;score:number};
type Draft={line:number;raw:string;quantity:number|null;employeeId:string|null;orderId:string|null;orderStageId:string|null;stageId:string|null;outputProductId:string|null;problems:string[];employeeCandidates:Cand[];orderCandidates:Cand[];stageCandidates:Cand[];workerText:string;stageText:string;orderText:string};
type Parsed={workDate:string|null;supervisorText:string|null;shiftId:string|null;shiftName:string|null;shiftLeaderEmployeeId:string|null;shiftLeaderName:string|null;rows:Draft[];problems:string[]};
type Lookup={employees:{id:string;full_name:string;code?:string}[];orders:{id:string;order_name:string;code?:string}[];shifts:{id:string;name:string}[];orderStages:{id:string;order_id:string;stage_id:string;stage_name:string;output_product_id?:string|null}[]};
type Row={key:number;line:number;employeeId:string;orderId:string;orderStageId:string;quantity:string;problems:string[];status:"draft"|"saving"|"done"|"failed";error:string};

const SAMPLE="26/11/2026\nمسؤول الوردية: اسم المسؤول\nاسم العامل - المرحلة - 1500 - الطلبية";

export default function BulkProductionPage(){
 const [text,setText]=useState("");
 const [lookup,setLookup]=useState<Lookup|null>(null);
 const [parsed,setParsed]=useState<Parsed|null>(null);
 const [rows,setRows]=useState<Row[]>([]);
 const [workDate,setWorkDate]=useState("");
 const [shiftId,setShiftId]=useState("");
 const [typeId,setTypeId]=useState("");
 const [leaderId,setLeaderId]=useState("");
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  api<{data:Lookup}>("/api/production/lookup-data").then(r=>setLookup(r.data)).catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل البيانات"));
  api<{data:{id:string}[]}>("/api/production-types").then(r=>setTypeId(r.data[0]?.id||"")).catch(()=>{});
 },[]);
 const employeeOptions=useMemo(()=>(lookup?.employees??[]).map(x=>({value:x.id,label:x.full_name,meta:x.code})),[lookup]);
 const orderOptions=useMemo(()=>(lookup?.orders??[]).map(x=>({value:x.id,label:x.order_name,meta:x.code})),[lookup]);
 const shiftOptions=useMemo(()=>(lookup?.shifts??[]).map(x=>({value:x.id,label:x.name})),[lookup]);
 async function prepare(){
  setError("");setBusy(true);
  try{
   const r=await api<{data:Parsed}>("/api/production/bulk-parse",{method:"POST",body:JSON.stringify({message:text})});
   const p=r.data;setParsed(p);setWorkDate(p.workDate||"");setShiftId(p.shiftId||"");setLeaderId(p.shiftLeaderEmployeeId||"");
   setRows(p.rows.map((d,i)=>({key:i,line:d.line,employeeId:d.employeeId||"",orderId:d.orderId||"",orderStageId:d.orderStageId||"",quantity:d.quantity?String(d.quantity):"",problems:d.problems,status:"draft",error:""})));
  }catch(e){setError(e instanceof Error?e.message:"تعذر تجهيز الرسالة")}finally{setBusy(false)}
 }
 function patch(key:number,p:Partial<Row>){setRows(rs=>rs.map(r=>r.key===key?{...r,...p}:r))}
 function stageOptionsFor(orderId:string){return (lookup?.orderStages??[]).filter(s=>s.order_id===orderId).map(s=>({value:s.id,label:s.stage_name}))}
 const readyRows=rows.filter(r=>r.status!=="done");
 const invalid=(r:Row)=>!r.employeeId||!r.orderStageId||!(Number(r.quantity)>0);
 const canRegister=!!workDate&&!!shiftId&&!!typeId&&readyRows.length>0&&!readyRows.some(invalid)&&!busy;
 async function registerAll(){
  if(!canRegister)return;
  setBusy(true);setError("");
  // Sequential, and a row that is already "done" is never sent again, so pressing the
  // button twice (or retrying after a failure) cannot duplicate a registered row.
  for(const r of rows){
   if(r.status==="done")continue;
   const os=lookup?.orderStages.find(s=>s.id===r.orderStageId);
   if(!os){patch(r.key,{status:"failed",error:"المرحلة مش موجودة"});continue}
   patch(r.key,{status:"saving",error:""});
   try{
    await api("/api/production",{method:"POST",body:JSON.stringify({employeeId:r.employeeId,shiftLeaderEmployeeId:(shiftId===parsed?.shiftId&&leaderId)||null,orderStageId:r.orderStageId,productionTypeId:typeId,productId:os.output_product_id||undefined,stageId:os.stage_id,shiftId,workDate,quantity:Number(r.quantity)})});
    patch(r.key,{status:"done"});
   }catch(e){patch(r.key,{status:"failed",error:e instanceof Error?e.message:"فشل التسجيل"})}
  }
  setBusy(false);
 }
 const doneCount=rows.filter(r=>r.status==="done").length;
 return <div className="app-shell"><Sidebar active="/production"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">تسجيل إنتاج بالجملة</h1><p className="page-subtitle">الصق رسالة الإنتاج، راجع السطور وعدّلها، وبعدين سجّل. كل السجلات بتنزل معلّقة.</p></div><a className="secondary-btn" href="/production">رجوع لإنتاج العمال</a></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   <section className="card">
    <div className="card-header"><div><h2 className="card-title">رسالة الإنتاج</h2><div className="form-hint">أول سطر التاريخ، التاني مسؤول الوردية، وبعدها سطر لكل عامل: الاسم - المرحلة - العدد - الطلبية. الأسماء بتتطابق 80% على الأقل.</div></div></div>
    <textarea rows={9} value={text} onChange={e=>setText(e.target.value)} placeholder={SAMPLE} style={{width:"100%"}}/>
    <div className="form-actions"><button type="button" className="primary-button" disabled={busy||text.trim().length<5} onClick={()=>void prepare()}>{busy?"جارٍ التجهيز...":"جهّز السطور"}</button></div>
   </section>
   {parsed&&<section className="card">
    <div className="card-header"><h2 className="card-title">مراجعة السطور</h2><span className="count-badge">{rows.length}</span></div>
    {parsed.problems.map((p,i)=><div className="alert error" key={i}>{p}</div>)}
    <div className="form-grid">
     <label>التاريخ<input type="date" value={workDate} onChange={e=>setWorkDate(e.target.value)}/></label>
     <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shiftOptions} placeholder="اختر الوردية"/></label>
     <label>مسؤول الوردية<input readOnly value={parsed.shiftLeaderName||parsed.supervisorText||"غير محدد"}/></label>
    </div>
    <div className="master-list">
     {rows.map(r=><div key={r.key} className="master-row" style={{flexWrap:"wrap",gap:8,alignItems:"flex-end",opacity:r.status==="done"?0.6:1}}>
      <div style={{minWidth:200,flex:"1 1 200px"}}><SearchableSelect value={r.employeeId} onChange={v=>patch(r.key,{employeeId:v})} options={employeeOptions} placeholder="العامل"/></div>
      <div style={{minWidth:200,flex:"1 1 200px"}}><SearchableSelect value={r.orderId} onChange={v=>patch(r.key,{orderId:v,orderStageId:""})} options={orderOptions} placeholder="الطلبية"/></div>
      <div style={{minWidth:180,flex:"1 1 180px"}}><SearchableSelect value={r.orderStageId} onChange={v=>patch(r.key,{orderStageId:v})} options={stageOptionsFor(r.orderId)} placeholder="المرحلة"/></div>
      <input style={{width:110}} inputMode="decimal" value={r.quantity} onChange={e=>patch(r.key,{quantity:e.target.value})} placeholder="العدد"/>
      <span className={"status "+(r.status==="done"?"success":r.status==="failed"?"danger":invalid(r)?"warning":"muted")}>{r.status==="done"?"اتسجل":r.status==="saving"?"جارٍ...":r.status==="failed"?"فشل":invalid(r)?"محتاج مراجعة":"جاهز"}</span>
      {r.status==="draft"&&invalid(r)&&r.problems.map((p,i)=><div className="form-hint" key={i} style={{width:"100%"}}>سطر {r.line}: {p}</div>)}
      {r.status==="failed"&&<div className="form-hint" style={{width:"100%",color:"#b42318"}}>سطر {r.line}: {r.error}</div>}
      {r.status==="draft"&&<button type="button" className="danger-button" onClick={()=>setRows(rs=>rs.filter(x=>x.key!==r.key))}>حذف السطر</button>}
     </div>)}
    </div>
    <div className="form-actions">
     <button type="button" className="primary-button" disabled={!canRegister} onClick={()=>void registerAll()}>{busy?"جارٍ التسجيل...":`سجّل ${readyRows.length} سطر`}</button>
     {doneCount>0&&<span className="form-hint">اتسجل {doneCount} من {rows.length}. السطور اللي فشلت تقدر تعدلها وتسجلها تاني من غير ما المسجّل يتكرر.</span>}
    </div>
   </section>}
  </section></main></div>;
}
