"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {API_BASE} from "../lib/api-base";

const REMINDERS=[
 {text:"اللهم صلِّ وسلم على نبينا محمد",button:"عليه أفضل الصلاة والتسليم"},
 {text:"سُبْحَانَ اللهِ وَبِحَمْدِهِ، سُبْحَانَ اللهِ الْعَظِيم",button:"تم الذكر"},
 {text:"لا إله إلا الله وحده لا شريك له، له الملك وله الحمد وهو على كل شيء قدير",button:"تم الذكر"},
 {text:"أشهد أن لا إله إلا الله، وأشهد أن محمدًا رسول الله",button:"تم الذكر"},
 {text:"أستغفر الله العظيم وأتوب إليه",button:"تم الذكر"},
 {text:"سبحان الله، والحمد لله، ولا إله إلا الله، والله أكبر",button:"تم الذكر"},
 {text:"اللهم أعنّي على ذكرك وشكرك وحسن عبادتك",button:"تم الذكر"},
 {text:"لا حول ولا قوة إلا بالله",button:"تم الذكر"},
 {text:"اللهم صلِّ وسلم وبارك على نبينا محمد",button:"عليه أفضل الصلاة والتسليم"}
];

export function DhikrNudges(){
 const [reminder,setReminder]=useState<{text:string;button:string}|null>(null);
 const userId=useRef<string|null>(null);
 const index=useRef(0);
 const lastShown=useRef(0);
 const show=useCallback(()=>{const item=REMINDERS[index.current%REMINDERS.length];index.current+=1;lastShown.current=Date.now();setReminder(item)},[]);
 useEffect(()=>{
  let alive=true;
  const check=async()=>{
   try{
    const response=await fetch(API_BASE+"/api/auth/me",{credentials:"include",cache:"no-store"});
    if(!response.ok){userId.current=null;return;}
    const body=await response.json();
    const id=String(body?.data?.userId||body?.data?.user_id||"");
    if(!id)return;
    if(userId.current!==id){userId.current=id;if(alive)show();}
   }catch{userId.current=null;}
  };
  void check();
  const authTimer=setInterval(()=>void check(),20000);
  const dhikrTimer=setInterval(()=>{if(userId.current&&Date.now()-lastShown.current>=20*60*1000)show()},30000);
  return()=>{alive=false;clearInterval(authTimer);clearInterval(dhikrTimer)};
 },[show]);
 if(!reminder)return null;
 return <aside className="dhikr-nudge" role="status" aria-live="polite" dir="rtl">
  <button type="button" className="dhikr-close" aria-label="إغلاق التذكير" onClick={()=>setReminder(null)}>×</button>
  <span className="dhikr-kicker">تذكار • تذكير لطيف</span>
  <p>{reminder.text}</p>
  <button type="button" className="dhikr-done" onClick={()=>{setReminder(null)}}>{reminder.button}</button>
  <button type="button" className="dhikr-next" onClick={show}>ذكر آخر</button>
 </aside>;
}
