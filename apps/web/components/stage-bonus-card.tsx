"use client";

import {useEffect,useState} from "react";
import {api} from "../lib/api";
import {SearchableSelect} from "./searchable-select";

type Rule={targetQty:string;bonusAmount:string};

// Tiered fixed bonus per stage: for one production record, the highest reached target
// pays its bonus only (never two tiers). New records only; existing records are not touched.
export function StageBonusCard({stages}:{stages:{value:string;label:string;meta?:string}[]}){
 const [stageId,setStageId]=useState("");
 const [rules,setRules]=useState<Rule[]>([]);
 const [msg,setMsg]=useState("");
 const [err,setErr]=useState("");
 const [saving,setSaving]=useState(false);
 useEffect(()=>{
  setMsg("");setErr("");
  if(!stageId){setRules([]);return}
  api<{data:{targetQty:number;bonusAmount:number}[]}>("/api/stages/"+stageId+"/bonus-rules")
   .then(r=>setRules(r.data.map(x=>({targetQty:String(x.targetQty),bonusAmount:String(x.bonusAmount)}))))
   .catch(()=>{setRules([]);setErr("تعذر تحميل البونص")});
 },[stageId]);
 function setRule(i:number,patch:Partial<Rule>){setRules(rs=>rs.map((r,j)=>j===i?{...r,...patch}:r))}
 async function save(){
  setMsg("");setErr("");
  const body=rules.filter(r=>r.targetQty.trim()||r.bonusAmount.trim()).map(r=>({targetQty:Number(r.targetQty),bonusAmount:Number(r.bonusAmount)}));
  if(body.some(r=>!(r.targetQty>0)||!(r.bonusAmount>0))){setErr("اكتب هدف ومبلغ صحيحين في كل سطر");return}
  setSaving(true);
  try{
   await api("/api/stages/"+stageId+"/bonus-rules",{method:"PUT",body:JSON.stringify({rules:body})});
   setMsg("اتحفظ. بيتطبق على السجلات الجديدة بس.");
  }catch(e){setErr(e instanceof Error?e.message:"تعذر الحفظ")}
  finally{setSaving(false)}
 }
 return <section className="card settings-wide">
  <div className="card-header"><div><h2 className="card-title">بونص التارجت للمرحلة</h2><div className="form-hint">لو سجل إنتاج واحد وصل لهدف، العامل ياخد بونص أعلى هدف وصله بس (مش مجموع الأهداف). بيتطبق على السجلات الجديدة بس.</div></div></div>
  <div className="inline-form"><SearchableSelect value={stageId} onChange={setStageId} options={stages} placeholder="اختر المرحلة"/></div>
  {err&&<div className="alert error">{err}</div>}
  {msg&&<div className="alert success">{msg}</div>}
  {stageId&&<>
   <div className="master-list">
    {rules.map((r,i)=><div className="master-row" key={i}>
     <input inputMode="decimal" placeholder="الهدف (مثال 1500)" value={r.targetQty} onChange={e=>setRule(i,{targetQty:e.target.value})}/>
     <input inputMode="decimal" placeholder="البونص بالجنيه (مثال 50)" value={r.bonusAmount} onChange={e=>setRule(i,{bonusAmount:e.target.value})}/>
     <button type="button" className="danger-button" onClick={()=>setRules(rs=>rs.filter((_,j)=>j!==i))}>حذف</button>
    </div>)}
    {!rules.length&&<div className="empty small-empty">مفيش بونص تارجت على المرحلة دي.</div>}
   </div>
   <div className="form-actions">
    <button type="button" className="secondary-btn" onClick={()=>setRules(rs=>[...rs,{targetQty:"",bonusAmount:""}])}>إضافة هدف</button>
    <button type="button" className="primary-button" disabled={saving} onClick={()=>void save()}>{saving?"جارٍ الحفظ...":"حفظ"}</button>
   </div>
  </>}
 </section>;
}
