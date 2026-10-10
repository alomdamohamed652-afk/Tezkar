"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type Session={permissions:string[];username?:string;roleCodes?:string[];activeRecords?:{custody?:boolean;advance?:boolean}};
type NavItem={icon:string;label:string;href:string;permissions?:string[];conditional?:"custody"|"advance"};
type NavGroup={label:string;items:NavItem[]};

const groups:NavGroup[]=[
 {label:"التشغيل",items:[
  {icon:"⌂",label:"الرئيسية",href:"/",permissions:["dashboard.view"]},
  {icon:"▤",label:"الطلبات",href:"/orders",permissions:["orders.view"]},
  {icon:"✓",label:"المهام",href:"/tasks",permissions:["tasks.view","tasks.view_own"]},
  {icon:"◌",label:"رؤساء الورديات",href:"/shift-leaders",permissions:["shifts.view"]},
  {icon:"◫",label:"إنتاج العمال",href:"/production",permissions:["production.view"]},
  {icon:"◉",label:"إنتاجي",href:"/my-production",permissions:["production.view_own"]},
  {icon:"▰",label:"إنتاج الماكينات",href:"/machine-production",permissions:["machine_production.view"]}
 ]},
 {label:"المخزون والتسليم",items:[
  {icon:"▥",label:"المخزن",href:"/warehouse",permissions:["warehouse.view"]},
  {icon:"⇤",label:"الاستلامات",href:"/receipts",permissions:["warehouse.view"]},
  {icon:"↓",label:"مسحوبات الوردية",href:"/shift-withdrawals",permissions:["warehouse.view"]},
  {icon:"⇥",label:"التسليمات",href:"/deliveries",permissions:["deliveries.view"]},
  {icon:"▰",label:"نظام التكويد",href:"/coding",permissions:["cartons.view"]}
 ]},
 {label:"المالية",items:[
  {icon:"₤",label:"المالية",href:"/accounting",permissions:["finance.profitability.view","finance.expenses.view"]},
  {icon:"◍",label:"القبض",href:"/payments",permissions:["payment_requests.view","worker_payments.view"]},
  {icon:"₤",label:"مرتبات الموظفين",href:"/payroll",permissions:["payroll.view"]},
  {icon:"↔",label:"السلف",href:"/advances",permissions:["advances.view","advances.view_own"],conditional:"advance"},
  {icon:"◍",label:"العهد",href:"/custody",permissions:["custody.view","custody.view_own"],conditional:"custody"},
  {icon:"₤",label:"مستحقاتي",href:"/earnings",permissions:["earnings.view_own"]}
 ]},
 {label:"الإدارة",items:[
  {icon:"⌕",label:"البحث المركزي",href:"/search",permissions:["orders.view","products.view","warehouse.view","payment_requests.view","cash_custody.view","employees.view"]},
  {icon:"▦",label:"التقارير",href:"/reports",permissions:["reports.view"]},
  {icon:"▣",label:"الموظفون",href:"/employees",permissions:["employees.view"]},
  {icon:"◈",label:"البيانات الأساسية",href:"/master-data",permissions:["products.view","rates.view","stages.view"]},
  {icon:"⚙",label:"الإعدادات",href:"/settings",permissions:["users.view","payment_methods.manage"]}
 ]}
];

export function usePermissions(){
 const [session,setSession]=useState<Session|null>(null);
 useEffect(()=>{api<{data:Session}>("/api/auth/me").then(r=>setSession(r.data)).catch(()=>setSession(null));},[]);
 const permissions=session?.permissions??null;
 const has=useCallback((code:string)=>permissions?.includes(code)??false,[permissions]);
 return {permissions,session,has};
}

export function Sidebar({active}:{active:string}){
 const {permissions,session}=usePermissions();
 const [pendingTaskCount,setPendingTaskCount]=useState(0);
 const [pendingPaymentCount,setPendingPaymentCount]=useState(0);
 useEffect(()=>{let alive=true;if(permissions?.some(p=>p==="tasks.view"||p==="tasks.view_own"))api<{data:{status:string}[]}>("/api/tasks").then(r=>{if(alive)setPendingTaskCount(r.data.filter(t=>t.status!=="COMPLETED"&&t.status!=="CANCELLED").length)}).catch(()=>{if(alive)setPendingTaskCount(0)});if(permissions?.some(p=>p==="payment_requests.view"||p==="worker_payments.view"))api<{data:{status:string}[]}>("/api/payment-requests").then(r=>{if(alive)setPendingPaymentCount(r.data.filter(x=>x.status==="PENDING"||x.status==="APPROVED").length)}).catch(()=>{if(alive)setPendingPaymentCount(0)});return()=>{alive=false}},[permissions]);
 const visibleGroups=useMemo(()=>groups.map(group=>({...group,items:group.items.filter(item=>{
   if(permissions===null)return false;
   if(item.conditional==="custody"&&session?.activeRecords?.custody)return true;
   if(!item.permissions?.some(p=>permissions.includes(p)))return false;
   if(!item.conditional)return true;
   if(item.conditional==="advance"&&permissions.includes("advances.view"))return true;
   if(item.conditional==="custody"&&permissions.includes("custody.view"))return true;
   return Boolean(session?.activeRecords?.[item.conditional]);
 })})).filter(group=>group.items.length),[permissions,session]);
 async function logout(){await api("/api/auth/logout",{method:"POST"}).catch(()=>{});window.location.replace("/login");}
 return <aside className="sidebar">
   <div className="brand">
    <div className="brand-mark"><img src="https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" alt="شعار تذكار" /></div>
    <div className="brand-copy"><div className="brand-name">تذكار</div><div className="brand-sub">إدارة وتشغيل المصنع</div></div>
   </div>
   <div className="sidebar-user">
    <div className="sidebar-avatar">{(session?.username||"م").slice(0,1).toUpperCase()}</div>
    <div className="sidebar-user-copy"><strong>{session?.username||"حساب المستخدم"}</strong><span>نظام تذكار</span></div>
    <span className="sidebar-online" title="متصل"></span>
   </div>
   <div className="sidebar-scroll">
    {visibleGroups.map(group=><div className="nav-group" key={group.label}>
      <div className="nav-title">{group.label}</div>
      <nav className="nav">{group.items.map(item=><a className={"nav-item"+(active===item.href?" active":"")} href={item.href} key={item.href}><span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>{item.href==="/tasks"&&pendingTaskCount>0&&<span className="nav-count-badge" aria-label={`${pendingTaskCount} مهام غير مكتملة`}>{pendingTaskCount>99?"99+":pendingTaskCount}</span>}{item.href==="/payments"&&pendingPaymentCount>0&&<span className="nav-count-badge" aria-label={`${pendingPaymentCount} طلبات قبض مفتوحة`}>{pendingPaymentCount>99?"99+":pendingPaymentCount}</span>}{active===item.href&&<span className="nav-active-dot"/>}</a>)}</nav>
    </div>)}
   </div>
   <div className="sidebar-footer">
    <a className={"nav-item"+(active==="/account"?" active":"")} href="/account"><span className="nav-icon">◉</span><span className="nav-label">حسابي</span></a>
    <button className="nav-item logout-item" onClick={logout}><span className="nav-icon">↪</span><span className="nav-label">تسجيل الخروج</span></button>
   </div>
 </aside>;
}
