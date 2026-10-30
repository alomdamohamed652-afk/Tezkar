"use client";
import { useEffect,useMemo,useRef,useState,type CSSProperties,type FormEvent } from "react";
import { api } from "../../lib/api";
import { Sidebar,usePermissions } from "../../components/sidebar";
import { Code128Barcode } from "../../components/code128-barcode";

type Item={id:string;code:string;name:string};
type Group={id:string;name:string;packaging_type:string;total_quantity:number;pieces_per_code:number;code_count:number;generated_codes:number;printed_codes:number;product_name?:string|null;order_code?:string|null;created_at:string;notes?:string|null;codes?:Code[]};
type Code={id:string;code:string;quantity:number;weight_grams:string|number|null;status:string;first_printed_at:string|null;notes?:string|null;employees?:{id:string;name:string;code:string}[];print_snapshot?:any};
type Company={companyName?:string;address?:string|null;phone?:string|null;logoUrl?:string|null};
type ScanResult={value:string;result:string;code:Code&{name?:string;packaging_type?:string;product_name?:string;order_code?:string}|null};
const resultLabels:Record<string,string>={FOUND:"كود معروف",UNKNOWN:"كود غير موجود",DUPLICATE:"تم مسحه قبل كده",VOIDED:"كود غير نشط"};
const number=(v:number)=>new Intl.NumberFormat("en-US").format(v);
export default function ReverseCodingPage(){
 const {has}=usePermissions();
 const [groups,setGroups]=useState<Group[]>([]),[products,setProducts]=useState<Item[]>([]),[orders,setOrders]=useState<Item[]>([]),[employees,setEmployees]=useState<Item[]>([]);
 const [company,setCompany]=useState<Company>({}),[search,setSearch]=useState(""),[selected,setSelected]=useState<Group|null>(null);
 const [name,setName]=useState(""),[packaging,setPackaging]=useState("كرتونة"),[productId,setProductId]=useState(""),[orderId,setOrderId]=useState(""),[total,setTotal]=useState(""),[perCode,setPerCode]=useState(""),[weight,setWeight]=useState(""),[notes,setNotes]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[selectedCodes,setSelectedCodes]=useState<string[]>([]);
 const [editingCode,setEditingCode]=useState<Code|null>(null),[editNotes,setEditNotes]=useState(""),[editEmployees,setEditEmployees]=useState<string[]>([]);
 const [scanValue,setScanValue]=useState(""),[scanResults,setScanResults]=useState<ScanResult[]>([]),[scanning,setScanning]=useState(false),[cameraError,setCameraError]=useState("");
 const [companyName,setCompanyName]=useState(""),[address,setAddress]=useState(""),[phone,setPhone]=useState(""),[logoUrl,setLogoUrl]=useState("");
 const [printRows,setPrintRows]=useState<any[]>([]);
 const videoRef=useRef<HTMLVideoElement|null>(null),streamRef=useRef<MediaStream|null>(null),frameRef=useRef<number>(0),detectorRef=useRef<any>(null),scanBusyRef=useRef(false);
 async function load(){
  try{const [g,b]=await Promise.all([api<{data:Group[]}>("/api/reverse-coding/groups"),api<{data:{products:Item[];orders:Item[];employees:Item[];company:Company}}>("/api/reverse-coding/bootstrap")]);
   setGroups(g.data);setProducts(b.data.products);setOrders(b.data.orders);setEmployees(b.data.employees);setCompany(b.data.company??{});
   setCompanyName(b.data.company?.companyName??"");setAddress(b.data.company?.address??"");setPhone(b.data.company?.phone??"");setLogoUrl(b.data.company?.logoUrl??"");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل نظام التكويد العكسي");}
 }
 useEffect(()=>{if(has("reverse_coding.view"))void load();},[has]);
 const filtered=useMemo(()=>groups.filter(g=>(g.name+" "+g.packaging_type+" "+(g.order_code??"")).toLowerCase().includes(search.toLowerCase())),[groups,search]);
 async function createGroup(e:FormEvent){
  e.preventDefault();setBusy(true);setError("");
  try{const r=await api<{data:Group}>("/api/reverse-coding/groups",{method:"POST",body:JSON.stringify({name,packagingType:packaging,productId:productId||null,orderId:orderId||null,totalQuantity:Number(total),piecesPerCode:Number(perCode),weightGrams:weight===""?null:Number(weight),notes:notes||null})});
   setGroups(x=>[r.data,...x]);setSelected(r.data);setSelectedCodes([]);setName("");setTotal("");setPerCode("");setWeight("");setNotes("");
  }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء الأكواد");}finally{setBusy(false);}
 }
 async function openGroup(g:Group){try{const r=await api<{data:Group}>("/api/reverse-coding/groups/"+g.id);setSelected(r.data);setSelectedCodes([]);}catch(e){setError(e instanceof Error?e.message:"تعذر فتح المجموعة");}}
 function toggleCode(id:string){setSelectedCodes(x=>x.includes(id)?x.filter(v=>v!==id):[...x,id]);}
 async function printCodes(ids:string[]){
  if(!ids.length)return;setBusy(true);setError("");
  try{const r=await api<{data:{id:string;snapshot:any}[]}>("/api/reverse-coding/print",{method:"POST",body:JSON.stringify({codeIds:ids})});
   setPrintRows(r.data);window.setTimeout(()=>window.print(),250);await load();if(selected)await openGroup(selected);
  }catch(e){setError(e instanceof Error?e.message:"تعذرت الطباعة");}finally{setBusy(false);}
 }
 async function saveCodeMetadata(){
  if(!editingCode)return;setBusy(true);try{await api("/api/reverse-coding/codes/"+editingCode.id+"/metadata",{method:"PATCH",body:JSON.stringify({notes:editNotes||null,employeeIds:editEmployees})});if(selected)await openGroup(selected);setEditingCode(null);}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بيانات الكود");}finally{setBusy(false);}
 }
 async function saveCompany(){
  setBusy(true);try{const r=await api<{data:Company}>("/api/reverse-coding/company-settings",{method:"PUT",body:JSON.stringify({companyName,address:address||null,phone:phone||null,logoUrl:logoUrl||null})});setCompany(r.data);setError("");}
  catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بيانات الشركة");}finally{setBusy(false);}
 }
 async function submitScan(value:string){
  const clean=value.trim();if(!clean)return;
  try{const r=await api<{data:ScanResult[]}>("/api/reverse-coding/scan",{method:"POST",body:JSON.stringify({values:[clean],sessionId:scanSession})});setScanResults(x=>[...r.data,...x]);setScanValue("");}
  catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المسح");}
 }
 const scanSession=useMemo(()=>typeof crypto!=="undefined"&&"randomUUID"in crypto?crypto.randomUUID():"session-"+Date.now(),[]);
 async function startCamera(){
  setCameraError("");
  try{
   const Detector=(window as any).BarcodeDetector;
   if(!Detector)throw new Error("المتصفح لا يدعم قراءة الباركود بالكاميرا. استخدم ماسح الباركود أو خانة الإدخال.");
   detectorRef.current=new Detector({formats:["code_128","qr_code","ean_13","code_39"]});
   const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
   streamRef.current=stream;setScanning(true);
   window.setTimeout(()=>{if(videoRef.current){videoRef.current.srcObject=stream;void videoRef.current.play();}},100);
  }catch(e){setCameraError(e instanceof Error?e.message:"تعذر تشغيل الكاميرا");}
 }
 useEffect(()=>{
  if(!scanning)return;
  let active=true;
  const tick=async()=>{if(!active)return;const video=videoRef.current;
   if(video&&video.readyState>=2&&detectorRef.current&&!scanBusyRef.current){scanBusyRef.current=true;try{const found=await detectorRef.current.detect(video);if(found?.[0]?.rawValue)await submitScan(found[0].rawValue);}catch{}finally{scanBusyRef.current=false;}}
   if(active)frameRef.current=window.requestAnimationFrame(tick);
  };
  frameRef.current=window.requestAnimationFrame(tick);
  return()=>{active=false;window.cancelAnimationFrame(frameRef.current);};
 },[scanning]);
 function stopCamera(){setScanning(false);if(streamRef.current){streamRef.current.getTracks().forEach(t=>t.stop());streamRef.current=null;}if(videoRef.current)videoRef.current.srcObject=null;}
 useEffect(()=>()=>{if(streamRef.current)streamRef.current.getTracks().forEach(t=>t.stop());window.cancelAnimationFrame(frameRef.current);},[]);
 if(!has("reverse_coding.view"))return <div className="app-shell"><Sidebar active="/reverse-coding"/><main className="main"><div className="card">ليس لديك صلاحية عرض نظام التكويد العكسي.</div></main></div>;
 const panel:CSSProperties={background:"var(--card,#fff)",border:"1px solid var(--border,#e5e7eb)",borderRadius:14,padding:18,marginBottom:16};
 const field:CSSProperties={display:"grid",gap:6,fontSize:13,fontWeight:650};
 const input:CSSProperties={width:"100%",minHeight:42,border:"1px solid var(--border,#d1d5db)",borderRadius:9,padding:"8px 11px",background:"var(--input,#fff)",color:"inherit"};
 const btn:React.CSSProperties={border:0,borderRadius:9,padding:"10px 16px",fontWeight:750,cursor:"pointer",background:"#1d4ed8",color:"#fff"};
 return <><div className="app-shell"><Sidebar active="/reverse-coding"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">نظام التكويد العكسي</h1><p className="page-subtitle">إنشاء مجموعات أكواد مستقلة، وطباعة الملصقات، ومسح الأكواد وتتبعها.</p></div></header>
  <section className="content">
   {error&&<div role="alert" style={{...panel,color:"#b91c1c",borderColor:"#fecaca"}}>{error}</div>}
   <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:12,marginBottom:16}}>
    {[["مجموعات الأكواد",groups.length],["إجمالي الأكواد",groups.reduce((s,g)=>s+Number(g.generated_codes??g.code_count),0)],["أكواد مطبوعة",groups.reduce((s,g)=>s+Number(g.printed_codes??0),0)],["إجمالي القطع",groups.reduce((s,g)=>s+Number(g.total_quantity),0)]].map(([label,value])=><div key={String(label)} style={{...panel,margin:0}}><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{label}</div><div style={{fontSize:26,fontWeight:850,marginTop:7}}>{number(Number(value))}</div></div>)}
   </div>
   {has("reverse_coding.manage")&&<form onSubmit={createGroup} style={panel}>
    <h2 style={{fontSize:17,fontWeight:800,margin:"0 0 14px"}}>إنشاء مجموعة أكواد جديدة</h2>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12}}>
     <label style={field}>اسم المجموعة<input style={input} value={name} onChange={e=>setName(e.target.value)} placeholder="مثال: دفعة أكياس الطلبية" required minLength={2}/></label>
     <label style={field}>نوع العبوة<input style={input} value={packaging} onChange={e=>setPackaging(e.target.value)} placeholder="كرتونة / كيس / شيكارة" required/></label>
     <label style={field}>المنتج (اختياري)<select style={input} value={productId} onChange={e=>setProductId(e.target.value)}><option value="">بدون ربط</option>{products.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
     <label style={field}>الطلبية (اختياري)<select style={input} value={orderId} onChange={e=>setOrderId(e.target.value)}><option value="">بدون ربط</option>{orders.map(x=><option key={x.id} value={x.id}>{x.code} — {x.order_name}</option>)}</select></label>
     <label style={field}>إجمالي القطع<input style={input} type="number" min="1" step="1" value={total} onChange={e=>setTotal(e.target.value)} required placeholder="مثال: 600"/></label>
     <label style={field}>عدد القطع في كل كود<input style={input} type="number" min="1" step="1" value={perCode} onChange={e=>setPerCode(e.target.value)} required placeholder="مثال: 50"/></label>
     <label style={field}>وزن العبوة بالجرام<input style={input} type="number" min="0" step="0.001" value={weight} onChange={e=>setWeight(e.target.value)} placeholder="اختياري"/></label>
     <label style={field}>ملاحظات<textarea style={{...input,minHeight:42}} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="ملاحظات المجموعة"/></label>
    </div>
    {total&&perCode&&Number(total)>0&&Number(perCode)>0&&<p style={{fontSize:13,color:"var(--muted,#64748b)",marginTop:12}}>سيتم إنشاء {number(Math.ceil(Number(total)/Number(perCode)))} كود، وآخر كود سيحمل الكمية المتبقية ({number(Number(total)%Number(perCode)||Number(perCode))} قطعة).</p>}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><button style={btn} disabled={busy}>{busy?"جارٍ الحفظ...":"إنشاء الأكواد"}</button></div>
   </form>}
   <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,390px),1fr))",gap:16,alignItems:"start"}}>
    <section style={panel}>
     <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center",marginBottom:12}}><h2 style={{fontSize:16,fontWeight:800,margin:0}}>مجموعات الأكواد</h2><input style={{...input,maxWidth:190}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="بحث..."/></div>
     <div style={{display:"grid",gap:8}}>{filtered.map(g=><button key={g.id} onClick={()=>void openGroup(g)} style={{textAlign:"right",padding:12,borderRadius:10,border:selected?.id===g.id?"2px solid #2563eb":"1px solid var(--border,#e5e7eb)",background:"transparent",color:"inherit",cursor:"pointer"}}>
      <div style={{fontWeight:800}}>{g.name}</div><div style={{fontSize:12,color:"var(--muted,#64748b)",marginTop:4}}>{g.packaging_type} · {g.order_code??"بدون طلبية"} · {new Date(g.created_at).toLocaleDateString("ar-EG")}</div>
      <div style={{display:"flex",gap:12,fontSize:12,marginTop:8}}><span>{number(g.total_quantity)} قطعة</span><span>{number(g.generated_codes??g.code_count)} كود</span><span>{number(g.printed_codes??0)} مطبوع</span></div>
     </button>)}{!filtered.length&&<p style={{color:"var(--muted,#64748b)"}}>لا توجد مجموعات حتى الآن.</p>}</div>
    </section>
    <section style={panel}>
     <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>تفاصيل المجموعة</h2>
     {!selected?<p style={{color:"var(--muted,#64748b)"}}>اختر مجموعة لعرض أكوادها وإدارة الطباعة.</p>:<>
      <div style={{display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}><div><strong>{selected.name}</strong><div style={{fontSize:12,color:"var(--muted,#64748b)",marginTop:4}}>{selected.packaging_type} · {selected.product_name??"بدون منتج"} · {selected.order_code??"بدون طلبية"}</div></div>
       <button style={{...btn,opacity:busy?.6:1}} disabled={busy||!has("reverse_coding.print")} onClick={()=>void printCodes(selected.codes?.map(c=>c.id)??[])}>طباعة المجموعة</button>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",margin:"14px 0"}}><button style={{...btn,background:"#334155"}} onClick={()=>setSelectedCodes(selected.codes?.map(c=>c.id)??[])}>تحديد الكل</button><button style={{...btn,background:"#334155"}} onClick={()=>setSelectedCodes([])}>إلغاء التحديد</button><button style={btn} disabled={!selectedCodes.length||busy||!has("reverse_coding.print")} onClick={()=>void printCodes(selectedCodes)}>طباعة المحدد ({selectedCodes.length})</button></div>
      <div style={{display:"grid",gap:8,maxHeight:450,overflow:"auto"}}>{selected.codes?.map(c=><div key={c.id} style={{display:"flex",alignItems:"center",gap:10,border:"1px solid var(--border,#e5e7eb)",borderRadius:9,padding:10}}>
       <input type="checkbox" checked={selectedCodes.includes(c.id)} onChange={()=>toggleCode(c.id)}/>
       <div style={{minWidth:0,flex:1}}><div style={{fontWeight:800,fontFamily:"monospace"}}>{c.code}</div><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{number(c.quantity)} قطعة · {c.weight_grams??"—"} جم · {c.first_printed_at?"تمت الطباعة":"لم يطبع بعد"}</div></div>
       <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,color:c.status==="ACTIVE"?"#15803d":"#b91c1c"}}>{c.status==="ACTIVE"?"نشط":"غير نشط"}</span><button type="button" style={{...btn,background:"#475569",padding:"6px 9px",fontSize:11}} onClick={()=>{setEditingCode(c);setEditNotes(c.notes??"");setEditEmployees((c.employees??[]).map(e=>e.id));}}>بيانات العمال</button></div>
      </div>)}</div>
      {editingCode&&<div style={{marginTop:14,padding:12,border:"1px solid var(--border,#e5e7eb)",borderRadius:10}}><strong>تعديل بيانات {editingCode.code}</strong><label style={{...field,marginTop:10}}>ملاحظات الكود<textarea style={{...input,minHeight:65}} value={editNotes} onChange={e=>setEditNotes(e.target.value)}/></label><div style={{fontSize:12,fontWeight:700,margin:"12px 0 7px"}}>العمال المشاركون</div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:6,maxHeight:160,overflow:"auto"}}>{employees.map(emp=><label key={emp.id} style={{display:"flex",alignItems:"center",gap:7,fontSize:12}}><input type="checkbox" checked={editEmployees.includes(emp.id)} onChange={e=>setEditEmployees(x=>e.target.checked?[...x,emp.id]:x.filter(id=>id!==emp.id))}/>{emp.name}</label>)}</div><div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}><button type="button" style={{...btn,background:"#475569"}} onClick={()=>setEditingCode(null)}>إلغاء</button><button type="button" style={btn} disabled={busy} onClick={()=>void saveCodeMetadata()}>حفظ التعديلات</button></div></div>}
     </>}
    </section>
   </div>
   <section style={panel}>
    <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>مسح الأكواد</h2>
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><input style={{...input,flex:1,minWidth:180}} value={scanValue} onChange={e=>setScanValue(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void submitScan(scanValue);}}} placeholder="امسح الباركود هنا أو اكتب الكود"/>
     <button style={btn} onClick={()=>void submitScan(scanValue)} disabled={!scanValue.trim()||!has("reverse_coding.scan")}>تسجيل المسح</button><button style={{...btn,background:scanning?"#b91c1c":"#0f766e"}} onClick={()=>scanning?stopCamera():void startCamera()}>{scanning?"إيقاف الكاميرا":"فتح الكاميرا"}</button></div>
    {cameraError&&<p style={{fontSize:12,color:"#b91c1c"}}>{cameraError}</p>}
    {scanning&&<div style={{marginTop:12}}><video ref={videoRef} playsInline muted style={{width:"100%",maxHeight:330,background:"#111",borderRadius:12,objectFit:"cover"}}/><p style={{fontSize:12,color:"var(--muted,#64748b)"}}>وجّه الكاميرا نحو الباركود أو QR. المسح يسجل النتيجة فقط ولا يغيّر حالة الكود أو المخزون.</p></div>}
    {!!scanResults.length&&<div style={{display:"grid",gap:7,marginTop:12}}>{scanResults.slice(0,20).map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,padding:10,borderRadius:9,background:"var(--surface,#f8fafc)"}}><div><strong style={{fontFamily:"monospace"}}>{r.value}</strong><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{r.code?.name??"—"} · {r.code?.quantity?number(r.code.quantity)+" قطعة":""}</div></div><strong style={{fontSize:12,color:r.result==="FOUND"?"#15803d":r.result==="UNKNOWN"?"#b91c1c":"#b45309"}}>{resultLabels[r.result]??r.result}</strong></div>)}</div>}
   </section>
   {has("reverse_coding.manage")&&<section style={panel}>
    <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>بيانات الشركة على الملصق</h2>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12}}>
     <label style={field}>اسم الشركة<input style={input} value={companyName} onChange={e=>setCompanyName(e.target.value)} placeholder="اسم الشركة"/></label>
     <label style={field}>العنوان<input style={input} value={address} onChange={e=>setAddress(e.target.value)} placeholder="عنوان الشركة"/></label>
     <label style={field}>رقم التواصل<input style={input} value={phone} onChange={e=>setPhone(e.target.value)} placeholder="رقم التواصل"/></label>
     <label style={field}>رابط الشعار<input style={input} value={logoUrl} onChange={e=>setLogoUrl(e.target.value)} placeholder="رابط صورة الشعار"/></label>
    </div><div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}><button style={btn} onClick={()=>void saveCompany()} disabled={busy}>حفظ بيانات الشركة</button></div>
   </section>}
  </section>
 </main></div>
 <div className="reverse-print-area">{printRows.map((r,i)=>{const s=r.snapshot;return <article className="reverse-label" key={r.id??i}>
  <header>{s.company?.logoUrl&&<img src={s.company.logoUrl} alt="" className="reverse-logo"/>}<div><strong>{s.company?.companyName||"TEZKAR"}</strong><small>{s.company?.address||""}</small><small>{s.company?.phone||""}</small></div></header>
  <div className="reverse-label-title">{s.packagingType} · {s.name}</div><div className="reverse-label-code">{s.code}</div><div className="reverse-barcode"><Code128Barcode value={s.code} height={48}/></div>
  <div className="reverse-label-meta"><span>الكمية: <b>{number(s.quantity)} قطعة</b></span><span>الوزن: <b>{s.weightGrams??"—"} جم</b></span></div>
  <div className="reverse-label-meta"><span>الطلبية: <b>{s.orderCode||"—"}</b></span><span>المنتج: <b>{s.productName||"—"}</b></span></div>
  <footer>TEZKAR · {new Date().toLocaleDateString("en-GB")}</footer>
 </article>})}</div>
 <style jsx global>{`
 .reverse-print-area{display:none}
 @media print{
  @page{margin:3mm}
  body *{visibility:hidden!important}
  .reverse-print-area,.reverse-print-area *{visibility:visible!important}
  .reverse-print-area{display:flex!important;flex-wrap:wrap;gap:3mm;position:absolute;inset:0;width:100%}
  .reverse-label{width:80mm;min-height:50mm;border:1px solid #222;padding:3mm;box-sizing:border-box;page-break-inside:avoid;color:#111;font-family:Arial,sans-serif}
  .reverse-label header{display:flex;align-items:center;gap:7px;border-bottom:1px solid #aaa;padding-bottom:2mm}
  .reverse-label header div{display:grid;gap:1px}.reverse-label header strong{font-size:12px}.reverse-label header small{font-size:7px}
  .reverse-logo{width:15mm;height:10mm;object-fit:contain}
  .reverse-label-title{text-align:center;font-size:9px;font-weight:bold;margin-top:2mm}
  .reverse-label-code{text-align:center;font-family:monospace;font-weight:bold;font-size:12px;margin-top:1mm}
  .reverse-barcode{height:14mm;overflow:hidden}.reverse-barcode svg{height:14mm!important}
  .reverse-label-meta{display:flex;justify-content:space-between;font-size:8px;margin-top:1mm;gap:4px}
  .reverse-label footer{text-align:center;font-size:7px;border-top:1px solid #aaa;margin-top:2mm;padding-top:1mm}
 }
 `}</style>
 </>;
}
