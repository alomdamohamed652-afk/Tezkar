"use client";
import { useEffect, useState } from "react";

// Theme toggle (2026-11-26 request): light/dark with system default.
// Choice saved in localStorage("tezkar-theme"); when no choice is saved the
// theme follows the OS and updates live. The pre-paint boot script in
// layout.tsx applies the theme before first render (no flash).

function currentTheme():"light"|"dark"{
 if(typeof document==="undefined")return "light";
 return document.documentElement.dataset.theme==="dark"?"dark":"light";
}

export function ThemeToggle(){
 const [theme,setTheme]=useState<"light"|"dark">("light");
 useEffect(()=>{setTheme(currentTheme())},[]);
 useEffect(()=>{
  const mq=window.matchMedia("(prefers-color-scheme: dark)");
  const onChange=()=>{
   try{if(!localStorage.getItem("tezkar-theme")){
    const t=mq.matches?"dark":"light";
    document.documentElement.dataset.theme=t;setTheme(t);
   }}catch{/* ignore */}
  };
  mq.addEventListener("change",onChange);
  return()=>mq.removeEventListener("change",onChange);
 },[]);
 const toggle=()=>{
  const next=theme==="dark"?"light":"dark";
  document.documentElement.dataset.theme=next;
  try{localStorage.setItem("tezkar-theme",next)}catch{/* ignore */}
  setTheme(next);
 };
 return <button type="button" className="nav-item theme-toggle" onClick={toggle} aria-label={theme==="dark"?"الوضع الفاتح":"الوضع الليلي"}>
  <span className="nav-icon">{theme==="dark"?"☀":"☾"}</span>
  <span className="nav-label">{theme==="dark"?"الوضع الفاتح":"الوضع الليلي"}</span>
 </button>;
}
