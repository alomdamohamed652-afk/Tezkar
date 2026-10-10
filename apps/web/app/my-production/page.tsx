"use client";
import {useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
import {formatMoney,formatQuantity} from "../../lib/format";
type Row={id:string;code:string;work_date:string;quantity:string;earning_amount:string;status:string;product_name:string;stage_name:string;shift_name:string;unit_name:string};
export default function MyProductionPage(){
 const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState("");
 useEffect(()=>{api<{data:Row[]}>("/api/production/my").then(x=>setRows(x.data)).catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل إنتاجك"));},[]);
 return <div className="app-shell"><Sidebar active="/my-production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاجي</h1><p className="page-subtitle">سجل إنتاجك وحالة اعتماد كل عملية</p></div></header><section className="content">{error&&<div className="alert error">{error}</div>}<section className="card"><div className="table-wrap"><table><thead><tr><th>السجل</th><th>التاريخ</th><th>المنتج</th><th>المرحلة</th><th>الوردية</th><th>الكمية</th><th>المستحق</th><th>الحالة</th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><td>{x.code}</td><td>{x.work_date}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.shift_name}</td><td>{formatQuantity(x.quantity,0)} {x.unit_name}</td><td>{formatMoney(x.earning_amount)}</td><td>{x.status==="APPROVED"?"معتمد":x.status==="PENDING"?"قيد المراجعة":x.status==="REJECTED"?"مرفوض":"ملغي"}</td></tr>)}{!rows.length&&<tr><td colSpan={8}>لا يوجد إنتاج مسجل حتى الآن.</td></tr>}</tbody></table></div></section></section></main></div>;
}