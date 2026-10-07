"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Session={permissions:string[];username?:string;roleCodes?:string[]};
type NavItem={icon:string;label:string;href:string;permissions?:string[]};

const nav:NavItem[]=[
 {icon:"⌂",label:"الرئيسية",href:"/",permissions:["dashboard.view"]},
 {icon:"▣",label:"الموظفون",href:"/employees",permissions:["employees.view"]},
 {icon:"▤",label:"الطلبات",href:"/orders",permissions:["orders.view"]},
 {icon:"◈",label:"البيانات الأساسية",href:"/master-data",permissions:["products.view","rates.view","stages.view"]},
 {icon:"◌",label:"رؤساء الورديات",href:"/shift-leaders",permissions:["shifts.view"]},
 {icon:"◫",label:"إنتاج العمال",href:"/production",permissions:["production.view"]},
 {icon:"◉",label:"إنتاجي",href:"/my-production",permissions:["production.view_own"]},
 {icon:"▥",label:"المخزن",href:"/warehouse",permissions:["warehouse.view"]},
 {icon:"▰",label:"الكرتونات",href:"/cartons",permissions:["cartons.view"]},
 {icon:"⇥",label:"التسليمات",href:"/deliveries",permissions:["deliveries.view"]},
 {icon:"₤",label:"مستحقاتي",href:"/earnings",permissions:["earnings.view_own"]},
 {icon:"↔",label:"السلف",href:"/advances",permissions:["advances.view","advances.view_own"]},
 {icon:"◍",label:"القبض",href:"/payments",permissions:["payment_requests.view","worker_payments.view"]},
 {icon:"▰",label:"إنتاج الماكينات",href:"/machine-production",permissions:["machine_production.view"]},
 {icon:"⚙",label:"الإعدادات",href:"/settings",permissions:["users.view","payment_methods.manage"]},
 {icon:"▦",label:"التقارير",href:"/reports",permissions:["reports.view"]}
];

export function usePermissions(){
 const [permissions,setPermissions]=useState<string[]|null>(null);
 useEffect(()=>{api<{data:Session}>("/api/auth/me").then(r=>setPermissions(r.data.permissions)).catch(()=>setPermissions([]));},[]);
 return {permissions,has:(code:string)=>permissions?.includes(code)??false};
}

export function Sidebar({active}:{active:string}){
 const {permissions}=usePermissions();
 const visible=nav.filter(item=>permissions!==null&&item.permissions?.some(p=>permissions.includes(p)));
 async function logout(){await api("/api/auth/logout",{method:"POST"}).catch(()=>{});window.location.replace("/login");}
 return <aside className="sidebar">
   <div className="brand">
    <div className="brand-mark"><span>ت</span></div>
    <div className="brand-copy"><div className="brand-name">تذكار</div><div className="brand-sub">إدارة وتشغيل المصنع</div></div>
   </div>
   <div className="sidebar-scroll">
    <div className="nav-title">الرئيسية والنظام</div>
    <nav className="nav">{visible.map(item=><a className={"nav-item"+(active===item.href?" active":"")} href={item.href} key={item.href}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></a>)}</nav>
   </div>
   <div className="sidebar-footer">
    <a className={"nav-item"+(active==="/account"?" active":"")} href="/account"><span className="nav-icon">◉</span><span>حسابي</span></a>
    <button className="nav-item logout-item" onClick={logout}><span className="nav-icon">↪</span><span>تسجيل الخروج</span></button>
   </div>
 </aside>;
}
