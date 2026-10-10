"use client";

import {useEffect,useMemo,useRef,useState} from "react";

type Option={value:string;label:string;meta?:string};

export function SearchableMultiSelect({values,onChange,options,placeholder="اختر موظفين...",searchPlaceholder="ابحث بالاسم أو الحساب..."}:{
 values:string[];
 onChange:(values:string[])=>void;
 options:Option[];
 placeholder?:string;
 searchPlaceholder?:string;
}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState("");
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const close=(event:MouseEvent)=>{if(!ref.current?.contains(event.target as Node))setOpen(false)};document.addEventListener("mousedown",close);return()=>document.removeEventListener("mousedown",close)},[]);
 const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase("ar-EG");return q?options.filter(x=>(x.label+" "+(x.meta||"")).toLocaleLowerCase("ar-EG").includes(q)):options},[options,query]);
 const selected=options.filter(x=>values.includes(x.value));
 function toggle(value:string){onChange(values.includes(value)?values.filter(x=>x!==value):[...values,value])}
 return <div className="search-multi-select" ref={ref}>
  <button type="button" className="search-select-trigger" aria-expanded={open} onClick={()=>{setOpen(v=>!v);setQuery("")}}>
   <span className={"search-select-current"+(selected.length?"":" placeholder")}>{selected.length?"تم اختيار "+selected.length+" موظف":placeholder}</span><span className="search-select-chevron">⌄</span>
  </button>
  {selected.length>0&&<div className="search-multi-chips">{selected.map(x=><button type="button" key={x.value} className="search-multi-chip" onClick={()=>toggle(x.value)} title="إزالة الموظف">{x.label} <span aria-hidden="true">×</span></button>)}<button type="button" className="search-multi-clear" onClick={()=>onChange([])}>مسح الكل</button></div>}
  {open&&<div className="search-select-menu">
   <input autoFocus className="search-select-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={searchPlaceholder}/>
   <div className="search-multi-actions"><button type="button" onClick={()=>onChange([...new Set([...values,...filtered.map(x=>x.value)])])}>اختيار النتائج ({filtered.length})</button><button type="button" onClick={()=>onChange([])}>إلغاء الاختيار</button></div>
   <div className="search-select-list">{filtered.map(x=><label key={x.value} className={"search-multi-option"+(values.includes(x.value)?" selected":"")}><input type="checkbox" checked={values.includes(x.value)} onChange={()=>toggle(x.value)}/><span className="search-multi-copy"><strong>{x.label}</strong>{x.meta&&<small>{x.meta}</small>}</span></label>)}{!filtered.length&&<div className="search-select-empty">لا توجد نتائج</div>}</div>
   <div className="search-multi-footer"><span>تم اختيار {selected.length} موظف</span><button type="button" className="primary-button" onClick={()=>setOpen(false)}>تم</button></div>
  </div>}
 </div>
}
