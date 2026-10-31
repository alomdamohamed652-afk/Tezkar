"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "../lib/api";

type Session={permissions:string[];username?:string;fullName?:string|null;employeeId?:string|null;roleCodes?:string[];activeRecords?:{custody?:boolean;advance?:boolean}};
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
  {icon:"▰",label:"إنتاج الماكينات",href:"/machine-production",permissions:["machine_production.view"]},
  {icon:"▧",label:"مكتبة تصميمات الليزر",href:"/laser-designs",permissions:["laser_designs.view"]},
  {icon:"▦",label:"خطة تصميمات الطلبيات",href:"/order-design-plan",permissions:["laser_designs.order_plan.view"]},
  {icon:"◷",label:"متابعة تشغيل الماكينات",href:"/machine-operations",permissions:["machine_production.live.view"]}
 ]},
 {label:"المخزون والتسليم",items:[
  {icon:"▥",label:"المخزن",href:"/warehouse",permissions:["warehouse.view"]},
  {icon:"⇤",label:"الاستلامات",href:"/receipts",permissions:["warehouse.view"]},
  {icon:"↓",label:"مسحوبات الوردية",href:"/shift-withdrawals",permissions:["warehouse.view"]},
  {icon:"⇥",label:"التسليمات",href:"/deliveries",permissions:["deliveries.view"]},
  {icon:"▰",label:"نظام التكويد",href:"/coding",permissions:["cartons.view"]},
  {icon:"▣",label:"التكويد العكسي",href:"/reverse-coding",permissions:["reverse_coding.view"]}
 ]},
 {label:"المالية",items:[
  {icon:"₤",label:"المالية",href:"/accounting",permissions:["finance.profitability.view","finance.expenses.view"]},
  {icon:"⇄",label:"تصحيح مصروفات الطلبيات القديمة",href:"/finance/worker-settlements",permissions:["finance.expenses.create"]},
  {icon:"⚠",label:"مراجعة الحالات المالية",href:"/finance/review",permissions:["worker_payments.pay"]},
  {icon:"◍",label:"القبض ومستحقات العمال",href:"/payments",permissions:["payment_requests.view","worker_payments.view","worker_payments.pay"]},
  {icon:"₤",label:"مرتبات الموظفين",href:"/payroll",permissions:["payroll.view","payroll.view_own"]},
  {icon:"↔",label:"السلف",href:"/advances",permissions:["advances.view","advances.view_own"],conditional:"advance"},
  {icon:"◍",label:"العهدة النقدية",href:"/custody",permissions:["cash_custody.view","cash_custody.view_own","cash_custody.create","cash_custody.create_own","cash_custody.transfer","cash_custody.order_collection","cash_custody.order_collection_own","cash_custody.order_expense","cash_custody.order_expense_own"]},
  {icon:"▣",label:"العهد العينية وتسويتها",href:"/custody/assets",permissions:["custody.view","custody.view_own","custody.create","custody.settle","custody.transfer"]},
  {icon:"₤",label:"مستحقاتي",href:"/earnings",permissions:["earnings.view_own"]}
 ]},
 {label:"الإدارة",items:[
  {icon:"⌕",label:"البحث المركزي",href:"/search",permissions:["orders.view","products.view","warehouse.view","payment_requests.view","cash_custody.view","cash_custody.view_own","employees.view","deliveries.view","payroll.view","advances.view","advances.view_own","tasks.view","tasks.view_own","cartons.view","finance.expenses.view","finance.revenues.view","finance.period_close.view"]},
  {icon:"▦",label:"التقارير",href:"/reports",permissions:["reports.view"]},
  {icon:"▣",label:"الموظفون",href:"/employees",permissions:["employees.view"]},
  {icon:"◷",label:"الحضور والبصمة",href:"/attendance",permissions:["attendance.view","attendance.import","attendance.manage","attendance.review"]},
  {icon:"♙",label:"طلبات الحسابات",href:"/registration-requests",permissions:["users.create"]},
  {icon:"↻",label:"طلبات إعادة تعيين كلمة المرور",href:"/password-reset-requests",permissions:["users.create"]},
  {icon:"◈",label:"البيانات الأساسية",href:"/master-data",permissions:["products.view","rates.view","stages.view"]},
  {icon:"⚙",label:"الإعدادات",href:"/settings",permissions:["users.view","payment_methods.manage"]},
  {icon:"◉",label:"أمان الحسابات وسجل النشاط",href:"/admin/security",permissions:["users.view"]}
 ]}
];

export function usePermissions(){
 const [session,setSession]=useState<Session|null>(null);
 useEffect(()=>{api<{data:Session}>("/api/auth/me").then(r=>setSession(r.data)).catch(()=>setSession(null));},[]);
 const permissions=session?.permissions??null;
 const has=useCallback((code:string)=>permissions?.includes(code)??false,[permissions]);
 return {permissions,session,has};
}

type SidebarPreferences={collapsed:boolean;groups:Record<string,boolean>};
const defaultSidebarPreferences:SidebarPreferences={collapsed:false,groups:{}};

export function Sidebar({active}:{active:string}){
 const {permissions,session}=usePermissions();
 const [pendingTaskCount,setPendingTaskCount]=useState(0);
 const [pendingPaymentCount,setPendingPaymentCount]=useState(0);
 const [unreadNotificationCount,setUnreadNotificationCount]=useState(0);
 const [sidebarPreferences,setSidebarPreferences]=useState<SidebarPreferences>(defaultSidebarPreferences);
 const [preferencesReady,setPreferencesReady]=useState(false);
 const preferenceKey=session?.username
  ? `tezkar_sidebar_state_${session.username.trim().toLowerCase()}`
  : session?.employeeId
   ? `tezkar_sidebar_state_${session.employeeId}`
   : null;
 useEffect(()=>{
  if(!preferenceKey){setPreferencesReady(false);return}
  setPreferencesReady(false);
  try{
   const raw=window.localStorage.getItem(preferenceKey);
   if(raw){
    const parsed=JSON.parse(raw) as Partial<SidebarPreferences>;
    setSidebarPreferences({
     collapsed:parsed.collapsed===true,
     groups:parsed.groups&&typeof parsed.groups==="object"?parsed.groups:{}
    });
   }else setSidebarPreferences(defaultSidebarPreferences);
  }catch{setSidebarPreferences(defaultSidebarPreferences)}
  setPreferencesReady(true);
 },[preferenceKey]);
 useEffect(()=>{
  if(!preferencesReady||!preferenceKey)return;
  try{window.localStorage.setItem(preferenceKey,JSON.stringify(sidebarPreferences))}catch{}
 },[preferencesReady,preferenceKey,sidebarPreferences]);
 function toggleGroup(label:string){
  setSidebarPreferences(current=>({...current,groups:{...current.groups,[label]:!(current.groups[label]??true)}}));
 }
 function toggleSidebar(){
  setSidebarPreferences(current=>({...current,collapsed:!current.collapsed}));
 }
 useEffect(()=>{let alive=true;if(permissions?.some(p=>p==="tasks.view"||p==="tasks.view_own"))api<{data:{status:string}[]}>("/api/tasks").then(r=>{if(alive)setPendingTaskCount(r.data.filter(t=>t.status!=="COMPLETED"&&t.status!=="CANCELLED").length)}).catch(()=>{if(alive)setPendingTaskCount(0)});if(permissions?.some(p=>p==="payment_requests.view"||p==="worker_payments.view"))api<{data:{status:string}[]}>("/api/payment-requests").then(r=>{if(alive)setPendingPaymentCount(r.data.filter(x=>x.status==="PENDING"||x.status==="APPROVED").length)}).catch(()=>{if(alive)setPendingPaymentCount(0)});if(permissions!==null)api<{unreadCount:number}>("/api/notifications").then(r=>{if(alive)setUnreadNotificationCount(r.unreadCount)}).catch(()=>{if(alive)setUnreadNotificationCount(0)});return()=>{alive=false}},[permissions]);
 const visibleGroups=useMemo(()=>groups.map(group=>({...group,items:group.items.filter(item=>{
   if(permissions===null)return false;
   if(item.href==="/admin/security"&&!session?.roleCodes?.some(role=>["admin","manager","owner"].includes(role.toLowerCase())))return false;
   if(!item.permissions?.some(p=>permissions.includes(p)))return false;
   if(!item.conditional)return true;
   if(item.conditional==="advance"&&permissions.includes("advances.view"))return true;
   return Boolean(session?.activeRecords?.[item.conditional]);
 })})).filter(group=>group.items.length),[permissions,session]);
 async function logout(){await api("/api/auth/logout",{method:"POST"}).catch(()=>{});window.location.replace("/login");}
 return <aside className={"sidebar"+(sidebarPreferences.collapsed?" sidebar-collapsed":"")+(preferencesReady?" sidebar-ready":" sidebar-restoring")}>
   <div className="brand">
    <div className="brand-mark"><img src="https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" alt="شعار تذكار" /></div>
    <div className="brand-copy"><div className="brand-name">تذكار</div><div className="brand-sub">إدارة وتشغيل المصنع</div></div>
    <button type="button" className="sidebar-collapse-toggle" onClick={toggleSidebar} aria-label={sidebarPreferences.collapsed?"توسيع القائمة":"تصغير القائمة"} title={sidebarPreferences.collapsed?"توسيع القائمة":"تصغير القائمة"}>{sidebarPreferences.collapsed?"‹":"›"}</button>
   </div>
   <div className="sidebar-user">
    <div className="sidebar-avatar">{(session?.fullName||session?.username||"م").trim().slice(0,1).toUpperCase()}</div>
    <div className="sidebar-user-copy"><strong>{session?.fullName||session?.username||"حساب المستخدم"}</strong><span>{session?.fullName&&session?.username?("@"+session.username):"نظام تذكار"}</span></div>
    <span className="sidebar-online" title="متصل"></span>
   </div>
   <div className="sidebar-scroll">
    {visibleGroups.map(group=>{
     const expanded=sidebarPreferences.groups[group.label]??true;
     return <div className={"nav-group"+(!expanded?" nav-group-collapsed":"")} key={group.label}>
      <button type="button" className="nav-title" onClick={()=>toggleGroup(group.label)} aria-expanded={expanded} title={group.label}>
       <span>{group.label}</span><span className="nav-group-chevron">{expanded?"−":"+"}</span>
      </button>
      {expanded&&<nav className="nav">{group.items.map(item=><Link className={"nav-item"+(active===item.href?" active":"")} href={item.href} key={item.href} prefetch title={item.href==="/payroll"?((permissions??[]).includes("payroll.view")?"مرتبات الموظفين":"مرتباتي"):item.label}><span className="nav-icon">{item.icon}</span><span className="nav-label">{item.href==="/payroll"?((permissions??[]).includes("payroll.view")?"مرتبات الموظفين":"مرتباتي"):item.label}</span>{item.href==="/tasks"&&pendingTaskCount>0&&<span className="nav-count-badge" aria-label={`${pendingTaskCount} مهام غير مكتملة`}>{pendingTaskCount>99?"99+":pendingTaskCount}</span>}{item.href==="/payments"&&pendingPaymentCount>0&&<span className="nav-count-badge" aria-label={`${pendingPaymentCount} طلبات قبض مفتوحة`}>{pendingPaymentCount>99?"99+":pendingPaymentCount}</span>}{active===item.href&&<span className="nav-active-dot"/>}</Link>)}</nav>}
     </div>
    })}
   </div>
   <div className="sidebar-footer">
    <Link className={"nav-item"+(active==="/notifications"?" active":"")} href="/notifications" prefetch><span className="nav-icon">♧</span><span className="nav-label">الإشعارات</span>{unreadNotificationCount>0&&<span className="nav-count-badge" aria-label={`${unreadNotificationCount} إشعارات غير مقروءة`}>{unreadNotificationCount>99?"99+":unreadNotificationCount}</span>}</Link>
    <Link className={"nav-item"+(active==="/account"?" active":"")} href="/account" prefetch><span className="nav-icon">◉</span><span className="nav-label">حسابي</span></Link>
    <button className="nav-item logout-item" onClick={logout}><span className="nav-icon">↪</span><span className="nav-label">تسجيل الخروج</span></button>
   </div>
 </aside>;
}
