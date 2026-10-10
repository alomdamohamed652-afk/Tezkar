"use client";

import {FormEvent,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type SearchResult={id:string;code:string|null;title:string;type:string;detail:string|null;created_at:string|null;href:string};

export default function SearchPage(){
  const {has}=usePermissions();
  const [query,setQuery]=useState("");
  const [searchedTerm,setSearchedTerm]=useState("");
  const [results,setResults]=useState<SearchResult[]>([]);
  const [searching,setSearching]=useState(false);
  const [error,setError]=useState("");
  const [searched,setSearched]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const term=query.trim();
    if(term.length<2){setError("اكتب كودًا أو اسمًا من حرفين على الأقل");return;}
    setSearching(true);setError("");setSearched(true);setSearchedTerm(term);
    try{const result=await api<{data:SearchResult[]}>("/api/search/global?q="+encodeURIComponent(term));setResults(result.data);}
    catch(e){setResults([]);setError(e instanceof Error?e.message:"تعذر تنفيذ البحث");}
    finally{setSearching(false);}
  }
  const canSearch=["orders.view","products.view","warehouse.view","payment_requests.view","cash_custody.view","cash_custody.view_own","employees.view"].some(has);
  return <div className="app-shell"><Sidebar active="/search"/><main className="main"><header className="topbar"><div><h1 className="page-title">البحث المركزي</h1><p className="page-subtitle">اكتب كودًا أو اسمًا للوصول إلى السجلات المرتبطة به في الأقسام التي تسمح بها صلاحياتك.</p></div></header><section className="content">
    {!canSearch&&<div className="alert error">لا توجد صلاحية بحث في السجلات المتاحة لهذا الحساب.</div>}
    <section className="card global-search-panel"><form onSubmit={submit} className="global-search-form"><label>الكود أو الاسم أو المرجع<input autoFocus value={query} onChange={e=>setQuery(e.target.value)} minLength={2} maxLength={120} placeholder="مثال: ORD-001 أو اسم صنف أو رقم سند" /></label><button className="primary-button" disabled={!canSearch||searching||query.trim().length<2}>{searching?"جارٍ البحث...":"بحث في النظام"}</button></form><div className="form-hint">البحث يراعي صلاحيات الحساب؛ لن تظهر سجلات من أقسام غير مسموح لك بعرضها.</div></section>
    {error&&<div className="alert error">{error}</div>}
    {searched&&!searching&&<section className="card" style={{marginTop:16}}><div className="card-header"><div><h2 className="card-title">نتائج البحث عن «{searchedTerm}»</h2><div className="form-hint">تم العثور على {results.length} نتيجة ظاهرة.</div></div><span className="count-badge">{results.length}</span></div>
      {results.length?<div className="global-search-results">{results.map((item,index)=><a className="global-search-result" key={item.type+":"+item.id+":"+index} href={item.href}><div className="global-search-result-main"><span className="global-search-type">{item.type}</span><strong>{item.title}</strong><span className="form-hint">{item.detail||"—"}</span></div><div className="global-search-result-meta"><code>{item.code||item.id}</code>{item.created_at&&<span className="form-hint">{new Date(item.created_at).toLocaleDateString("ar-EG")}</span>}<span className="global-search-open">فتح القسم ←</span></div></a>)}</div>:<div className="empty">لم يتم العثور على نتائج مطابقة في السجلات المتاحة. جرّب الكود كاملًا أو جزءًا من الاسم.</div>}
    </section>}
  </section></main></div>;
}
