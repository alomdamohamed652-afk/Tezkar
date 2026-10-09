"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Option={value:string;label:string;meta?:string};

export function SearchableSelect({value,onChange,options,placeholder="اختر...",searchPlaceholder="ابحث...",disabled=false}:{
 value:string; onChange:(value:string)=>void; options:Option[]; placeholder?:string; searchPlaceholder?:string; disabled?:boolean;
}){
 const [open,setOpen]=useState(false);
 const [query,setQuery]=useState("");
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const fn=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false)};document.addEventListener("mousedown",fn);return()=>document.removeEventListener("mousedown",fn)},[]);
 const current=options.find(x=>x.value===value);
 const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase("ar-EG");if(!q)return options;return options.filter(x=>(x.label+" "+(x.meta??"")).toLocaleLowerCase("ar-EG").includes(q))},[options,query]);
 return <div className="search-select" ref={ref}>
  <button type="button" className="search-select-trigger" disabled={disabled} onClick={()=>{setOpen(v=>!v);setQuery("")}}>
   <span className={"search-select-current"+(current?"":" placeholder")}><span className="search-select-current-label">{current?.label??placeholder}</span>{current?.meta&&<small className="search-select-current-meta">{current.meta}</small>}</span><span className="search-select-chevron">⌄</span>
  </button>
  {open&&<div className="search-select-menu">
   <input autoFocus className="search-select-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={searchPlaceholder}/>
   <div className="search-select-list">
    {filtered.map(x=><button type="button" key={x.value} className={"search-select-option"+(x.value===value?" selected":"")} onClick={()=>{onChange(x.value);setOpen(false)}}><span>{x.label}</span>{x.meta&&<small>{x.meta}</small>}</button>)}
    {!filtered.length&&<div className="search-select-empty">لا توجد نتائج</div>}
   </div>
  </div>}
 </div>;
}
