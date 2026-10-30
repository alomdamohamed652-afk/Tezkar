"use client";
import { useEffect,useMemo,useRef,useState,type CSSProperties,type FormEvent } from "react";
import { api } from "../../lib/api";
import { Sidebar,usePermissions } from "../../components/sidebar";
import { Code128Barcode } from "../../components/code128-barcode";

type Item={id:string;code:string;name:string};
type Group={id:string;name:string;packaging_type:string;total_quantity:number;pieces_per_code:number;code_count:number;generated_codes:number;printed_codes:number;product_name?:string|null;order_code?:string|null;created_at:string;notes?:string|null;codes?:Code[]};
type Code={id:string;code:string;quantity:number;weight_grams:string|number|null;status:string;first_printed_at:string|null;notes?:string|null;employees?:{id:string;name:string;code:string}[];print_snapshot?:any};
type Company={companyName?:string;address?:string|null;phone?:string|null;logoUrl?:string|null};
type LabelLayout={width:number;height:number;margin:number};
type ScanResult={value:string;result:string;code:(Code&{id:string;product_id?:string;name?:string;packaging_type?:string;product_name?:string;display_product_name?:string|null;order_code?:string;weight_min_kg?:string|null;weight_max_kg?:string|null})|null;carton?:any};
type ScanLog={id:string;scanned_value:string;result:string;scanned_at:string;code?:string|null;group_name?:string|null;username?:string|null};
const createScanSession=()=>typeof crypto!=="undefined"&&"randomUUID"in crypto?crypto.randomUUID():"session-"+Date.now()+"-"+Math.random().toString(36).slice(2);
const resultLabels:Record<string,string>={FOUND:"كود معروف",UNKNOWN:"كود غير موجود",DUPLICATE:"تم مسحه قبل كده",VOIDED:"كود غير نشط"};
const number=(v:number)=>new Intl.NumberFormat("en-US").format(v);
export default function ReverseCodingPage(){
 const {has}=usePermissions();
 const [groups,setGroups]=useState<Group[]>([]),[products,setProducts]=useState<Item[]>([]),[employees,setEmployees]=useState<Item[]>([]);
 const [company,setCompany]=useState<Company>({}),[search,setSearch]=useState(""),[selected,setSelected]=useState<Group|null>(null);
 const [packaging,setPackaging]=useState("كرتونة"),[productId,setProductId]=useState(""),[perCode,setPerCode]=useState("600"),[codeCount,setCodeCount]=useState("1"),[weightMinKg,setWeightMinKg]=useState(""),[weightMaxKg,setWeightMaxKg]=useState(""),[displayProductName,setDisplayProductName]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[selectedCodes,setSelectedCodes]=useState<string[]>([]);
 const [editingCode,setEditingCode]=useState<Code|null>(null),[editNotes,setEditNotes]=useState(""),[editWeight,setEditWeight]=useState(""),[editEmployees,setEditEmployees]=useState<string[]>([]);
 const [scanValue,setScanValue]=useState(""),[scanResults,setScanResults]=useState<ScanResult[]>([]),[scanning,setScanning]=useState(false),[cameraError,setCameraError]=useState(""),[scannedCode,setScannedCode]=useState<ScanResult|null>(null),[cartonProductId,setCartonProductId]=useState(""),[cartonDisplayProductName,setCartonDisplayProductName]=useState(""),[productionPartnerId,setProductionPartnerId]=useState(""),[packerId,setPackerId]=useState(""),[packerPartnerId,setPackerPartnerId]=useState(""),[actualWeightKg,setActualWeightKg]=useState(""),[cartonNotes,setCartonNotes]=useState("");
 const [scanSession,setScanSession]=useState(createScanSession),[recentScans,setRecentScans]=useState<ScanLog[]>([]);
 const [companyName,setCompanyName]=useState(""),[address,setAddress]=useState(""),[phone,setPhone]=useState(""),[logoUrl,setLogoUrl]=useState("");
 const [printRows,setPrintRows]=useState<any[]>([]);
 const [labelSize,setLabelSize]=useState({width:80,height:50,margin:2});
 const [labelPreset,setLabelPreset]=useState("80x50");
 const [labelSaved,setLabelSaved]=useState(false);
 const videoRef=useRef<HTMLVideoElement|null>(null),streamRef=useRef<MediaStream|null>(null),frameRef=useRef<number>(0),detectorRef=useRef<any>(null),scanBusyRef=useRef(false),lastDetectedRef=useRef("");
 async function load(){
  try{const [g,b,logs]=await Promise.all([api<{data:Group[]}>("/api/reverse-coding/groups"),api<{data:{products:Item[];employees:Item[];company:Company;labelSettings:LabelLayout}}>("/api/reverse-coding/bootstrap"),api<{data:ScanLog[]}>("/api/reverse-coding/scans")]);
   setGroups(g.data);setRecentScans(logs.data);setProducts(b.data.products);setEmployees(b.data.employees);setCompany(b.data.company??{});
   setCompanyName(b.data.company?.companyName??"");setAddress(b.data.company?.address??"");setPhone(b.data.company?.phone??"");setLogoUrl(b.data.company?.logoUrl??"");
   const layout=b.data.labelSettings??{width:80,height:50,margin:2};setLabelSize(layout);setLabelPreset(["80x50","100x150","100x100","60x40","50x30","40x30"].includes(`${layout.width}x${layout.height}`)?`${layout.width}x${layout.height}`:"custom");
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل نظام التكويد العكسي");}
 }
 useEffect(()=>{if(has("reverse_coding.view"))void load();},[has]);
 const filtered=useMemo(()=>groups.filter(g=>(g.name+" "+g.packaging_type+" "+(g.order_code??"")).toLowerCase().includes(search.toLowerCase())),[groups,search]);
 async function createGroup(e:FormEvent){
  e.preventDefault();setBusy(true);setError("");
  try{const r=await api<{data:Group}>("/api/reverse-coding/groups",{method:"POST",body:JSON.stringify({packagingType:packaging,productId,displayProductName:displayProductName.trim()||null,codeCount:Number(codeCount),piecesPerCode:Number(perCode),weightMinKg:weightMinKg===""?null:Number(weightMinKg),weightMaxKg:weightMaxKg===""?null:Number(weightMaxKg)})});
   setGroups(x=>[r.data,...x]);setSelected(r.data);setSelectedCodes([]);setCodeCount("1");setWeightMinKg("");setWeightMaxKg("");setDisplayProductName("");
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
  if(!editingCode)return;setBusy(true);try{await api("/api/reverse-coding/codes/"+editingCode.id+"/metadata",{method:"PATCH",body:JSON.stringify({notes:editNotes||null,...(!editingCode.first_printed_at?{weightGrams:editWeight===""?null:Number(editWeight)}:{}),employeeIds:editEmployees})});if(selected)await openGroup(selected);setEditingCode(null);}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بيانات الكود");}finally{setBusy(false);}
 }
 async function saveCompany(){
  setBusy(true);try{const r=await api<{data:Company}>("/api/reverse-coding/company-settings",{method:"PUT",body:JSON.stringify({companyName,address:address||null,phone:phone||null,logoUrl:logoUrl||null})});setCompany(r.data);setError("");}
  catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بيانات الشركة");}finally{setBusy(false);}
 }
 async function saveLabelLayout(){
  setBusy(true);setLabelSaved(false);setError("");
  try{const r=await api<{data:{width:number;height:number;margin:number}}>("/api/reverse-coding/label-settings",{method:"PUT",body:JSON.stringify(labelSize)});setLabelSize(r.data);setLabelSaved(true);}
  catch(e){setError(e instanceof Error?e.message:"تعذر حفظ مقاس الملصق");}finally{setBusy(false);}
 }
 async function submitScan(value:string){
  const clean=value.trim();if(!clean)return;
  try{const r=await api<{data:ScanResult[]}>("/api/reverse-coding/scan",{method:"POST",body:JSON.stringify({values:[clean],sessionId:scanSession})});const hit=r.data[0];setScanResults(x=>[...r.data,...x]);setScanValue("");if(hit?.result==="FOUND"&&hit.code){setScannedCode(hit);setCartonProductId(hit.code.product_id??"");setCartonDisplayProductName(hit.carton?.display_product_name??hit.code.display_product_name??hit.code.product_name??"");setProductionPartnerId(hit.carton?.production_partner_employee_id??"");setPackerId(hit.carton?.packer_employee_id??"");setPackerPartnerId(hit.carton?.packer_partner_employee_id??"");setActualWeightKg(hit.carton?.actual_weight_kg==null?"":String(hit.carton.actual_weight_kg));setCartonNotes(hit.carton?.notes??"");}const logs=await api<{data:ScanLog[]}>("/api/reverse-coding/scans");setRecentScans(logs.data);}
  catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المسح");}
 }
 
 async function startCamera(){
  setCameraError("");
  try{
   const Detector=(window as any).BarcodeDetector;
   if(!Detector)throw new Error("المتصفح لا يدعم قراءة الباركود بالكاميرا. استخدم ماسح الباركود أو خانة الإدخال.");
   detectorRef.current=new Detector({formats:["code_128","qr_code"]});
   const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
   streamRef.current=stream;setScanning(true);
   window.setTimeout(()=>{if(videoRef.current){videoRef.current.srcObject=stream;void videoRef.current.play();}},100);
  }catch(e){setCameraError(e instanceof Error?e.message:"تعذر تشغيل الكاميرا");}
 }
 useEffect(()=>{
  if(!scanning)return;
  let active=true;
  const tick=async()=>{if(!active)return;const video=videoRef.current;
   if(video&&video.readyState>=2&&detectorRef.current&&!scanBusyRef.current){scanBusyRef.current=true;try{const found=await detectorRef.current.detect(video);if(found?.[0]?.rawValue&&found[0].rawValue!==lastDetectedRef.current){lastDetectedRef.current=found[0].rawValue;await submitScan(found[0].rawValue);}}catch{}finally{scanBusyRef.current=false;}}
   if(active)frameRef.current=window.requestAnimationFrame(tick);
  };
  frameRef.current=window.requestAnimationFrame(tick);
  return()=>{active=false;window.cancelAnimationFrame(frameRef.current);};
 },[scanning,scanSession]);
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
    {[["عدد الأكواد المجهزة",groups.reduce((s,g)=>s+Number(g.generated_codes??g.code_count),0)],["أكواد مطبوعة",groups.reduce((s,g)=>s+Number(g.printed_codes??0),0)]].map(([label,value])=><div key={String(label)} style={{...panel,margin:0}}><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{label}</div><div style={{fontSize:26,fontWeight:850,marginTop:7}}>{number(Number(value))}</div></div>)}
   </div>
   {has("reverse_coding.manage")&&<form onSubmit={createGroup} style={panel}>
    <h2 style={{fontSize:20,fontWeight:900,margin:"0 0 14px"}}>تجهيز أكواد الكراتين</h2>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))",gap:14}}>
     <label style={field}>نوع العبوة<input style={input} value={packaging} onChange={e=>setPackaging(e.target.value)} required/></label>
     <label style={field}>المنتج الرئيسي<select style={input} value={productId} onChange={e=>{setProductId(e.target.value);setDisplayProductName("");}} required><option value="">اختر المنتج</option>{products.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
     <label style={field}>اسم المنتج الظاهر على الملصق<input style={input} value={displayProductName} onChange={e=>setDisplayProductName(e.target.value)} placeholder={products.find(x=>x.id===productId)?.name??"يظهر الاسم الأصلي تلقائيًا"} disabled={!has("reverse_coding.rename_product_label")}/><span style={{fontSize:11,color:"var(--muted,#64748b)"}}>تغيير الاسم لا يغيّر المنتج الرئيسي المرتبط.</span></label>
     <label style={field}>عدد الأكواد المطلوب تجهيزها<input style={input} type="number" min="1" max="5000" value={codeCount} onChange={e=>setCodeCount(e.target.value)} required/></label>
     <label style={field}>عدد القطع في كل كود<input style={input} type="number" min="1" value={perCode} onChange={e=>setPerCode(e.target.value)} required/></label>
     <label style={field}>أقل وزن بالكيلو<input style={input} type="number" min="0" step="0.001" value={weightMinKg} onChange={e=>setWeightMinKg(e.target.value)} placeholder="اختياري"/></label>
     <label style={field}>أعلى وزن بالكيلو<input style={input} type="number" min="0" step="0.001" value={weightMaxKg} onChange={e=>setWeightMaxKg(e.target.value)} placeholder="اختياري"/></label>
    </div>
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}><button style={btn} disabled={busy||!productId||Number(codeCount)<1||Number(perCode)<1||(weightMinKg!==""&&weightMaxKg!==""&&Number(weightMinKg)>Number(weightMaxKg))}>{busy?"جارٍ التجهيز...":"إنشاء الأكواد"}</button></div>
   </form>}   <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,390px),1fr))",gap:16,alignItems:"start"}}>
    <section style={panel}>
     <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center",marginBottom:12}}><h2 style={{fontSize:16,fontWeight:800,margin:0}}>الأكواد المجهزة</h2><input style={{...input,maxWidth:190}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="بحث..."/></div>
     <div style={{display:"grid",gap:8}}>{filtered.map(g=><button key={g.id} onClick={()=>void openGroup(g)} style={{textAlign:"right",padding:12,borderRadius:10,border:selected?.id===g.id?"2px solid #2563eb":"1px solid var(--border,#e5e7eb)",background:"transparent",color:"inherit",cursor:"pointer"}}>
      <div style={{fontWeight:800}}>{g.product_name??"أكواد كراتين"}</div><div style={{fontSize:12,color:"var(--muted,#64748b)",marginTop:4}}>{g.packaging_type} · {new Date(g.created_at).toLocaleDateString("ar-EG")}</div>
      <div style={{display:"flex",gap:12,fontSize:12,marginTop:8}}><span>{number(g.generated_codes??g.code_count)} كود</span><span>{number(g.printed_codes??0)} مطبوع</span></div>
     </button>)}{!filtered.length&&<p style={{color:"var(--muted,#64748b)"}}>لا توجد مجموعات حتى الآن.</p>}</div>
    </section>
    <section style={panel}>
     <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>تفاصيل الأكواد</h2>
     {!selected?<p style={{color:"var(--muted,#64748b)"}}>اختر مجموعة لعرض أكوادها وإدارة الطباعة.</p>:<>
      <div style={{display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}><div><strong>{selected.product_name??"تفاصيل الأكواد"}</strong><div style={{fontSize:12,color:"var(--muted,#64748b)",marginTop:4}}>{selected.packaging_type} · {selected.product_name??"—"}</div></div>
       <button style={{...btn,opacity:busy?.6:1}} disabled={busy||!has("reverse_coding.print")} onClick={()=>void printCodes(selected.codes?.map(c=>c.id)??[])}>طباعة الأكواد</button>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",margin:"14px 0"}}><button style={{...btn,background:"#334155"}} onClick={()=>setSelectedCodes(selected.codes?.map(c=>c.id)??[])}>تحديد الكل</button><button style={{...btn,background:"#334155"}} onClick={()=>setSelectedCodes([])}>إلغاء التحديد</button><button style={btn} disabled={!selectedCodes.length||busy||!has("reverse_coding.print")} onClick={()=>void printCodes(selectedCodes)}>طباعة المحدد ({selectedCodes.length})</button></div>
      <div style={{display:"grid",gap:8,maxHeight:450,overflow:"auto"}}>{selected.codes?.map(c=><div key={c.id} style={{display:"flex",alignItems:"center",gap:10,border:"1px solid var(--border,#e5e7eb)",borderRadius:9,padding:10}}>
       <input type="checkbox" checked={selectedCodes.includes(c.id)} onChange={()=>toggleCode(c.id)}/>
       <div style={{minWidth:0,flex:1}}><div style={{fontWeight:800,fontFamily:"monospace"}}>{c.code}</div><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{number(c.quantity)} قطعة · {c.first_printed_at?"تمت الطباعة":"لم يطبع بعد"}</div></div>
       <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,color:c.status==="ACTIVE"?"#15803d":"#b91c1c"}}>{c.status==="ACTIVE"?"نشط":"غير نشط"}</span></div>
      </div>)}</div>
      {editingCode&&<div style={{marginTop:14,padding:12,border:"1px solid var(--border,#e5e7eb)",borderRadius:10}}><strong>تعديل بيانات {editingCode.code}</strong><label style={{...field,marginTop:10}}>ملاحظات الكود<textarea style={{...input,minHeight:65}} value={editNotes} onChange={e=>setEditNotes(e.target.value)}/></label><label style={{...field,marginTop:10}}>وزن العبوة بالجرام<input style={input} type="number" min="0" step="0.001" value={editWeight} disabled={Boolean(editingCode.first_printed_at)} onChange={e=>setEditWeight(e.target.value)}/>{editingCode.first_printed_at&&<span style={{fontSize:11,color:"#b45309"}}>الوزن مقفول لأن الكود تمت طباعته</span>}</label><div style={{fontSize:12,fontWeight:700,margin:"12px 0 7px"}}>العمال المشاركون</div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:6,maxHeight:160,overflow:"auto"}}>{employees.map(emp=><label key={emp.id} style={{display:"flex",alignItems:"center",gap:7,fontSize:12}}><input type="checkbox" checked={editEmployees.includes(emp.id)} onChange={e=>setEditEmployees(x=>e.target.checked?[...x,emp.id]:x.filter(id=>id!==emp.id))}/>{emp.name}</label>)}</div><div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}><button type="button" style={{...btn,background:"#475569"}} onClick={()=>setEditingCode(null)}>إلغاء</button><button type="button" style={btn} disabled={busy} onClick={()=>void saveCodeMetadata()}>حفظ التعديلات</button></div></div>}
     </>}
    </section>
   </div>
   <section style={panel}>
    <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>مسح الأكواد</h2>
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><input style={{...input,flex:1,minWidth:180}} value={scanValue} onChange={e=>setScanValue(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void submitScan(scanValue);}}} placeholder="امسح الباركود هنا أو اكتب الكود"/>
     <button style={btn} onClick={()=>void submitScan(scanValue)} disabled={!scanValue.trim()||!has("reverse_coding.scan")}>تسجيل المسح</button><button style={{...btn,background:scanning?"#b91c1c":"#0f766e"}} onClick={()=>scanning?stopCamera():void startCamera()} disabled={!has("reverse_coding.scan")}>{scanning?"إيقاف الكاميرا":"فتح الكاميرا"}</button><button style={{...btn,background:"#475569"}} onClick={()=>{setScanSession(createScanSession());setScanResults([]);lastDetectedRef.current="";}}>جلسة مسح جديدة</button></div>
    {scannedCode?.code&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api("/api/reverse-coding/codes/"+scannedCode.code!.id+"/carton",{method:"POST",body:JSON.stringify({productId:cartonProductId,displayProductName:has("reverse_coding.rename_product_label")?(cartonDisplayProductName.trim()||null):null,productionPartnerEmployeeId:productionPartnerId||null,packerEmployeeId:packerId||null,packerPartnerEmployeeId:packerPartnerId||null,actualWeightKg:actualWeightKg===""?null:Number(actualWeightKg),notes:cartonNotes||null})});setScannedCode(null);setError("");}catch(err){setError(err instanceof Error?err.message:"تعذر حفظ بيانات الكرتونة");}finally{setBusy(false);}}} style={{marginTop:16,padding:14,border:"2px solid #2563eb",borderRadius:12,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12}}>
     <div style={{gridColumn:"1/-1"}}><strong style={{fontSize:23,fontWeight:950}}>{scannedCode.code.code}</strong><div>{number(scannedCode.code.quantity)} قطعة · الوزن المتوقع {scannedCode.code.weight_min_kg??"—"} إلى {scannedCode.code.weight_max_kg??"—"} كجم</div></div>
     <label style={field}>المنتج الرئيسي<select style={input} value={cartonProductId} disabled required>{products.map(p=><option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></label>
     <label style={field}>اسم المنتج الظاهر على الملصق<input style={input} value={cartonDisplayProductName} onChange={e=>setCartonDisplayProductName(e.target.value)} disabled={!has("reverse_coding.rename_product_label")} placeholder="اسم المنتج على الملصق"/></label>
     <label style={field}>شريك الإنتاج (اختياري)<select style={input} value={productionPartnerId} onChange={e=>setProductionPartnerId(e.target.value)}><option value="">بدون شريك</option>{employees.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
     <label style={field}>القائم بالتقفيل<select style={input} value={packerId} onChange={e=>setPackerId(e.target.value)} required><option value="">اختر المسؤول</option>{employees.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
     <label style={field}>شريك التقفيل (اختياري)<select style={input} value={packerPartnerId} onChange={e=>setPackerPartnerId(e.target.value)}><option value="">بدون شريك</option>{employees.map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label>
     <label style={field}>الوزن الفعلي (كجم)<input style={input} type="number" min="0" step="0.001" value={actualWeightKg} onChange={e=>setActualWeightKg(e.target.value)} placeholder="وزن الكرتونة بعد التقفيل"/></label>
     <label style={{...field,gridColumn:"1/-1"}}>ملاحظات<textarea style={{...input,minHeight:65}} value={cartonNotes} onChange={e=>setCartonNotes(e.target.value)}/></label>
     <div style={{gridColumn:"1/-1",display:"flex",justifyContent:"flex-end",gap:8}}><button type="button" style={{...btn,background:"#64748b"}} onClick={()=>setScannedCode(null)}>إلغاء</button><button style={btn} disabled={busy||!cartonProductId||!packerId}>{busy?"جارٍ الحفظ...":"حفظ بيانات الكرتونة"}</button></div>
    </form>}
    {cameraError&&<p style={{fontSize:12,color:"#b91c1c"}}>{cameraError}</p>}
    {scanning&&<div style={{marginTop:12}}><video ref={videoRef} playsInline muted style={{width:"100%",maxHeight:330,background:"#111",borderRadius:12,objectFit:"cover"}}/><p style={{fontSize:12,color:"var(--muted,#64748b)"}}>وجّه الكاميرا نحو الباركود أو QR. المسح يسجل النتيجة فقط ولا يغيّر حالة الكود أو المخزون.</p></div>}
    {!!scanResults.length&&<div style={{display:"grid",gap:7,marginTop:12}}>{scanResults.slice(0,20).map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,padding:10,borderRadius:9,background:"var(--surface,#f8fafc)"}}><div><strong style={{fontFamily:"monospace"}}>{r.value}</strong><div style={{fontSize:12,color:"var(--muted,#64748b)"}}>{r.code?.product_name??"—"} · {r.code?.packaging_type??""} · {r.code?.quantity?number(r.code.quantity)+" قطعة":""} · الوزن {r.code?.weight_min_kg??"—"} – {r.code?.weight_max_kg??"—"} كجم</div></div><strong style={{fontSize:12,color:r.result==="FOUND"?"#15803d":r.result==="UNKNOWN"?"#b91c1c":"#b45309"}}>{resultLabels[r.result]??r.result}</strong></div>)}</div>}
   </section>
   <section style={panel}><h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>سجل المسح الأخير</h2><div style={{display:"grid",gap:7}}>{recentScans.slice(0,12).map(log=><div key={log.id} style={{display:"flex",justifyContent:"space-between",gap:10,padding:9,borderRadius:8,background:"var(--surface,#f8fafc)",fontSize:12}}><div><strong style={{fontFamily:"monospace"}}>{log.scanned_value}</strong><div style={{color:"var(--muted,#64748b)"}}>{log.username??"—"} · {new Date(log.scanned_at).toLocaleString("ar-EG")}</div></div><strong>{resultLabels[log.result]??log.result}</strong></div>)}{!recentScans.length&&<p style={{color:"var(--muted,#64748b)"}}>لا توجد عمليات مسح مسجلة.</p>}</div></section>
   {has("reverse_coding.manage")&&<section style={panel}>
    <h2 style={{fontSize:16,fontWeight:800,margin:"0 0 12px"}}>مقاس الملصق والطباعة</h2>
    <p style={{fontSize:12,color:"var(--muted,#64748b)",margin:"-4px 0 14px"}}>اختار مقاس جاهز أو خصص العرض والارتفاع والهامش. الإعدادات محفوظة على مستوى النظام.</p>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12}}>
     <label style={field}>المقاسات الجاهزة<select style={input} value={labelPreset} onChange={e=>{const v=e.target.value;setLabelPreset(v);if(v!=="custom"){const [w,h]=v.split("x").map(Number);setLabelSize(x=>({...x,width:w,height:h}));}}}><option value="80x50">80 × 50 مم</option><option value="100x150">100 × 150 مم</option><option value="100x100">100 × 100 مم</option><option value="60x40">60 × 40 مم</option><option value="50x30">50 × 30 مم</option><option value="40x30">40 × 30 مم</option><option value="custom">مقاس مخصص</option></select></label>
     <label style={field}>العرض (مم)<input style={input} type="number" min="20" max="300" value={labelSize.width} onChange={e=>{setLabelPreset("custom");setLabelSize(x=>({...x,width:Number(e.target.value)}));}}/></label>
     <label style={field}>الارتفاع (مم)<input style={input} type="number" min="15" max="300" value={labelSize.height} onChange={e=>{setLabelPreset("custom");setLabelSize(x=>({...x,height:Number(e.target.value)}));}}/></label>
     <label style={field}>هامش الطباعة (مم)<input style={input} type="number" min="0" max="10" step=".5" value={labelSize.margin} onChange={e=>setLabelSize(x=>({...x,margin:Number(e.target.value)}))}/></label>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",marginTop:14}}>
     <div style={{width:Math.min(220,labelSize.width*1.5),height:Math.min(150,labelSize.height*1.5),minWidth:45,minHeight:30,maxWidth:"100%",border:"1px dashed var(--muted,#94a3b8)",borderRadius:5,background:"var(--surface,#f8fafc)",display:"grid",placeItems:"center",padding:6,boxSizing:"border-box",fontSize:11,overflow:"hidden"}}><div style={{textAlign:"center"}}><strong style={{display:"block"}}>TEZKAR</strong><span>RVC-YY-00000001</span><div style={{borderTop:"3px solid #334155",margin:"5px 0"}}/><span>{labelSize.width} × {labelSize.height} مم</span></div></div>
     <span style={{fontSize:12,color:"var(--muted,#64748b)"}}>معاينة تقريبية للتناسب؛ النتيجة النهائية تتأثر بإعدادات الطابعة.</span>
     <button type="button" style={btn} disabled={busy||labelSize.width<20||labelSize.height<15||labelSize.width>300||labelSize.height>300||labelSize.margin<0||labelSize.margin>10} onClick={()=>void saveLabelLayout()}>{busy?"جارٍ الحفظ...":"حفظ مقاس الملصق"}</button>
     {labelSaved&&<span style={{fontSize:12,color:"#15803d",fontWeight:700}}>تم حفظ المقاس</span>}
    </div>
   </section>}
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
  <div className="reverse-label-title">{s.productName||""}</div><div className="reverse-label-code">{s.code}</div><div className="reverse-barcode"><Code128Barcode value={s.code} height={48}/></div>
  <div className="reverse-label-meta"><span>الكمية: <b>{number(s.quantity)} قطعة</b></span><span>الوزن: <b>{s.weightMinKg??"—"} – {s.weightMaxKg??"—"} كجم</b></span></div>
  <footer>TEZKAR · {s.createdAt?new Date(s.createdAt).toLocaleDateString("en-GB"):""}</footer>
 </article>})}</div>
 <style jsx global>{`
 .reverse-print-area{display:none}
 @media print{
  @page{size:${labelSize.width}mm ${labelSize.height}mm;margin:0}
  html,body{margin:0!important;padding:0!important}
  body *{visibility:hidden!important}
  .reverse-print-area,.reverse-print-area *{visibility:visible!important}
  .reverse-print-area{display:block!important;position:absolute!important;top:0!important;left:0!important;width:${labelSize.width}mm;margin:0!important;padding:0!important}
  .reverse-label{display:flex;flex-direction:column;justify-content:space-between;width:${labelSize.width}mm;height:${labelSize.height}mm;min-height:${labelSize.height}mm;max-height:${labelSize.height}mm;margin:0;padding:${labelSize.margin}mm;overflow:hidden;border:0;box-sizing:border-box;page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid;color:#111;background:#fff;font-family:Arial,sans-serif}
  .reverse-label:last-child{page-break-after:auto;break-after:auto}
  .reverse-label header{display:flex;align-items:center;gap:1.5mm;border-bottom:.2mm solid #aaa;padding-bottom:1mm;min-height:7mm;overflow:hidden}
  .reverse-label header div{display:grid;gap:.3mm;min-width:0}.reverse-label header strong{font-size:clamp(8px,2.8mm,12px)}.reverse-label header small{font-size:clamp(6px,1.7mm,8px);overflow-wrap:anywhere}
  .reverse-logo{width:12mm;height:8mm;object-fit:contain;flex:0 0 auto}
  .reverse-label-title{text-align:center;font-size:clamp(7px,2.2mm,10px);font-weight:bold;margin-top:1mm;overflow:hidden}
  .reverse-label-code{text-align:center;font-family:Arial,sans-serif;font-weight:900;font-size:clamp(12px,4mm,18px);margin-top:.5mm;overflow-wrap:anywhere}
  .reverse-barcode{height:${Math.max(7,Math.min(18,labelSize.height*.25))}mm;overflow:hidden;text-align:center}.reverse-barcode svg{height:100%!important;max-width:100%}
  .reverse-label-meta{display:flex;justify-content:space-between;font-size:clamp(6px,1.9mm,9px);margin-top:.6mm;gap:1mm;overflow:hidden}
  .reverse-label footer{text-align:center;font-size:clamp(6px,1.6mm,8px);border-top:.2mm solid #aaa;margin-top:1mm;padding-top:.6mm}
 }
 `}</style>
 </>;
}
