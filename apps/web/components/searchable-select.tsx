"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Option={value:string;label:string;meta?:string};

export function SearchableSelect({value,onChange,options,placeholder="اختر...",searchPlaceholder="ابحث...",disabled=false}:{
 value:string; onChange:(value:string)=>void; options:Option[]; placeholder?:string; searchPlaceholder?:string; disabled?:boolean;
}){
 const [open,setOpen]=useState(false);
 const [query,setQuery]=useState("");
 const [mounted,setMounted]=useState(false);
 const [position,setPosition]=useState<{top:number;left:number;width:number;maxHeight:number}>({top:0,left:0,width:320,maxHeight:360});
 const ref=useRef<HTMLDivElement>(null);
 const triggerRef=useRef<HTMLButtonElement>(null);
 const menuRef=useRef<HTMLDivElement>(null);
 useEffect(()=>setMounted(true),[]);
 useEffect(()=>{
  const fn=(e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node)&&!menuRef.current?.contains(e.target as Node))setOpen(false)};
  document.addEventListener("mousedown",fn);
  return()=>document.removeEventListener("mousedown",fn);
 },[]);
 const current=options.find(x=>x.value===value);
 const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase("ar-EG");if(!q)return options;return options.filter(x=>(x.label+" "+(x.meta??"")).toLocaleLowerCase("ar-EG").includes(q))},[options,query]);
 useEffect(()=>{
  if(!open)return;
  const place=()=>{
   const rect=triggerRef.current?.getBoundingClientRect();
   if(!rect)return;
   const margin=12;
   const width=Math.min(Math.max(rect.width,280),window.innerWidth-margin*2);
   const left=Math.max(margin,Math.min(rect.left,window.innerWidth-width-margin));
   const below=window.innerHeight-rect.bottom-margin;
   const above=rect.top-margin;
   const showBelow=below>=Math.min(300,above)||below>=above;
   const maxHeight=Math.max(140,Math.min(420,(showBelow?below:above)-8));
   setPosition({top:showBelow?rect.bottom+6:Math.max(margin,rect.top-maxHeight-6),left,width,maxHeight});
  };
  place();
  window.addEventListener("resize",place);
  window.addEventListener("scroll",place,true);
  return()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true)};
 },[open]);
 const menu= open&&mounted ? createPortal(<div ref={menuRef} className="search-select-menu" style={{top:position.top,left:position.left,width:position.width,maxHeight:position.maxHeight,zIndex:99999}}>
   <input autoFocus className="search-select-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={searchPlaceholder}/>
   <div className="search-select-list" style={{maxHeight:position.maxHeight-56,overflowY:"auto"}}>
    {filtered.map(x=><button type="button" key={x.value} className={"search-select-option"+(x.value===value?" selected":"")} onClick={()=>{onChange(x.value);setOpen(false)}}><span>{x.label}</span>{x.meta&&<small>{x.meta}</small>}</button>)}
    {!filtered.length&&<div className="search-select-empty">لا توجد نتائج</div>}
   </div>
  </div>,document.body):null;
 return <div className="search-select" ref={ref}>
  <button ref={triggerRef} type="button" className="search-select-trigger" disabled={disabled} aria-expanded={open} onClick={()=>{setOpen(v=>!v);setQuery("")}}>
   <span className={"search-select-current"+(current?"":" placeholder")}><span className="search-select-current-label">{current?.label??placeholder}</span>{current?.meta&&<small className="search-select-current-meta">{current.meta}</small>}</span><span className="search-select-chevron">⌄</span>
  </button>
  {menu}
 </div>;
}
