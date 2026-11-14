"use client";
import {FormEvent,useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";

type Profile={username:string;code:string;full_name:string|null;employee_code:string|null;roles:string[];must_change_password:boolean};
type Session={id:string;device_id:string|null;device_name:string|null;device_type:string|null;browser_name:string|null;os_name:string|null;ip_address:string|null;last_seen_at:string|null;expires_at:string;is_current:boolean};

export default function AccountPage(){
 const router=useRouter();
 const [profile,setProfile]=useState<Profile|null>(null);
 const [sessions,setSessions]=useState<Session[]>([]);
 const [current,setCurrent]=useState(""),[next,setNext]=useState(""),[confirm,setConfirm]=useState("");
 const [msg,setMsg]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false),[showLogoutAll,setShowLogoutAll]=useState(false),[loggingOut,setLoggingOut]=useState(false);
 useEffect(()=>{
  Promise.all([api<{data:Profile}>("/api/account/profile"),api<{data:Session[]}>("/api/auth/sessions")])
   .then(([p,s])=>{setProfile(p.data);setSessions(s.data);})
   .catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل بيانات الحساب"));
 },[]);
 async function submit(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");setMsg("");
  try{await api("/api/account/change-password",{method:"POST",body:JSON.stringify({currentPassword:current,newPassword:next,confirmPassword:confirm})});setMsg("تم تغيير كلمة المرور. سجل الدخول مرة أخرى.");setCurrent("");setNext("");setConfirm("");setTimeout(()=>window.location.replace("/login"),800)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تغيير كلمة المرور")}finally{setSaving(false)}
 }
 async function logoutAll(){
  setLoggingOut(true);setError("");
  try{await api("/api/auth/logout-all",{method:"POST"});window.localStorage.removeItem("tezkar_device_id");router.replace("/login");}
  catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الخروج من الأجهزة")}finally{setLoggingOut(false);setShowLogoutAll(false)}
 }
 return <div className="app-shell"><Sidebar active="/account"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">حسابي</h1><p className="page-subtitle">بيانات الدخول والأجهزة المتصلة وأمان الحساب</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}{msg&&<div className="success-box">{msg}</div>}
   {profile?.must_change_password&&<div className="alert error">تم تعيين كلمة مرور مؤقتة لحسابك. غيّرها الآن قبل استخدام باقي أجزاء النظام.</div>}
   <section className="card"><div className="card-header"><h2 className="card-title">بيانات الحساب</h2></div><div className="form-grid"><label>اسم المستخدم<input readOnly value={profile?.username??""}/></label><label>الكود<input readOnly value={profile?.code??""}/></label><label>الموظف<input readOnly value={profile?.full_name??"حساب إداري"}/></label><label>الأدوار<input readOnly value={profile?.roles?.join("، ")??""}/></label></div></section>
   <section className="card"><div className="card-header"><h2 className="card-title">الأجهزة المسجّل دخولها</h2><span className="badge">{sessions.length} جهاز</span></div>
    <p className="muted">الأجهزة النشطة التي استخدمت الحساب، مع المتصفح ونظام التشغيل وآخر نشاط مسجل.</p>
    {sessions.length===0?<p>لا توجد جلسات نشطة مسجلة.</p>:<div className="table-wrap"><table><thead><tr><th>الجهاز</th><th>المتصفح</th><th>نظام التشغيل</th><th>عنوان الاتصال</th><th>آخر نشاط</th><th>الحالة</th></tr></thead><tbody>{sessions.map(s=><tr key={s.id}><td>{s.device_name||({mobile:"موبايل",tablet:"تابلت",desktop:"كمبيوتر"} as Record<string,string>)[s.device_type||""]||"جهاز غير معروف"}</td><td>{s.browser_name||"غير معروف"}</td><td>{s.os_name||"غير معروف"}</td><td>{s.ip_address||"—"}</td><td>{s.last_seen_at?new Date(s.last_seen_at).toLocaleString("ar-EG"):"—"}</td><td>{s.is_current?"هذا الجهاز":"نشط"}</td></tr>)}</tbody></table></div>}
    <div className="form-actions"><button type="button" className="danger-button" onClick={()=>setShowLogoutAll(true)} disabled={sessions.length===0}>تسجيل الخروج من جميع الأجهزة</button></div>
   </section>
   <form className="card form-card" onSubmit={submit}><div className="card-header"><h2 className="card-title">تغيير كلمة المرور</h2></div><div className="form-grid"><label>كلمة المرور الحالية<input type="password" value={current} onChange={e=>setCurrent(e.target.value)} required/></label><label>كلمة المرور الجديدة<input type="password" value={next} onChange={e=>setNext(e.target.value)} minLength={12} required/></label><label>تأكيد كلمة المرور<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} minLength={12} required/></label></div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الحفظ...":"تغيير كلمة المرور"}</button></div></form>
  </section>
 </main>
 {showLogoutAll&&<div className="dialog-backdrop" role="presentation"><section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="logout-all-title"><h2 id="logout-all-title">تسجيل الخروج من جميع الأجهزة؟</h2><p>سيتم إنهاء كل الجلسات، بما فيها هذا الجهاز، وستحتاج إلى تسجيل الدخول مرة أخرى.</p><div className="form-actions"><button className="secondary-button" type="button" onClick={()=>setShowLogoutAll(false)} disabled={loggingOut}>إلغاء</button><button className="danger-button" type="button" onClick={logoutAll} disabled={loggingOut}>{loggingOut?"جارٍ التنفيذ...":"تأكيد تسجيل الخروج"}</button></div></section></div>}
 </div>;
}
