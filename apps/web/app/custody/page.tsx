"use client";
import {FormEvent,useEffect,useState} from "react";
import {api,ApiError} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {formatMoney,formatQuantity} from "../../lib/format";
import {SearchableSelect} from "../../components/searchable-select";

type Custody={id:string;code:string;employee_id:string;employee_name:string;custody_type:string;description:string;quantity:number;unit_value:number;total_value:number;status:string;issued_at:string;due_date:string|null;returned_quantity:number;lost_quantity:number;remaining_quantity:number;transfer_count?:number};
type Employee={id:string;full_name:string;code:string};
type CustodyTransfer={id:string;code:string;from_employee_name:string;to_employee_name:string;remaining_quantity:number;notes:string|null;created_at:string;created_by_username:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={ACTIVE:"نشطة",PARTIAL_RETURNED:"مرتجع جزئي",RETURNED:"مُسواة",DAMAGED:"تالف",LOST:"مفقودة",CANCELLED:"ملغاة"};

export default function CustodyPage(){
 const {has,permissions}=usePermissions();
 type CashTx={id:string;code:string;employee_name:string;direction:"IN"|"OUT";amount:number;transaction_date:string;description:string;notes:string|null;balance:number;transfer_code?:string|null};
 const [items,setItems]=useState<Custody[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[employeeId,setEmployeeId]=useState(""),[cashEmployeeId,setCashEmployeeId]=useState(""),[type,setType]=useState(""),[description,setDescription]=useState(""),[quantity,setQuantity]=useState(""),[unitValue,setUnitValue]=useState(""),[dueDate,setDueDate]=useState(""),[notes,setNotes]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const [cash,setCash]=useState<CashTx[]>([]),[cashDirection,setCashDirection]=useState<"IN"|"OUT">("IN"),[cashAmount,setCashAmount]=useState(""),[cashDate,setCashDate]=useState(new Date().toISOString().slice(0,10)),[cashDescription,setCashDescription]=useState(""),[cashNotes,setCashNotes]=useState(""),[cashSaving,setCashSaving]=useState(false),[duplicateMatches,setDuplicateMatches]=useState<CashTx[]>([]),[duplicateOpen,setDuplicateOpen]=useState(false);
 const [transferCustodyId,setTransferCustodyId]=useState(""),[transferToEmployeeId,setTransferToEmployeeId]=useState(""),[transferNotes,setTransferNotes]=useState(""),[transferSaving,setTransferSaving]=useState(false);
 const [transferHistory,setTransferHistory]=useState<CustodyTransfer[]>([]),[historyCustodyCode,setHistoryCustodyCode]=useState("");
 const [cashTransferFromEmployeeId,setCashTransferFromEmployeeId]=useState(""),[cashTransferToEmployeeId,setCashTransferToEmployeeId]=useState(""),[cashTransferAmount,setCashTransferAmount]=useState(""),[cashTransferDescription,setCashTransferDescription]=useState("تحويل عهدة نقدية"),[cashTransferNotes,setCashTransferNotes]=useState(""),[cashTransferSaving,setCashTransferSaving]=useState(false);
 async function load(){try{
  try{setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data)}catch{}

  const suffix=employeeId?"?employeeId="+encodeURIComponent(employeeId):"";
  setItems((await api<{data:Custody[]}>("/api/custodies"+suffix)).data);
 }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل العهد")}
 }
 useEffect(()=>{void load()},[employeeId]);
 // Load employee options independently from the custody ledger so a ledger-view error
 // cannot block the picker. Support both all-scope and own-scope permissions.
 useEffect(()=>{
  const pickerPermissions=["custody.create","custody.create_own","custody.view","custody.view_own","cash_custody.create","cash_custody.create_own","cash_custody.view","cash_custody.view_own"];
  if(!permissions?.some(code=>pickerPermissions.includes(code)))return;
  let active=true;
  api<{data:Employee[]}>("/api/custodies/eligible-employees")
   .then(r=>{if(active)setEmployees(r.data)})
   .catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل قائمة الموظفين للعهد")});
  return()=>{active=false};
 },[permissions]);
 async function submitCash(e:FormEvent,confirmDuplicate=false){
 e.preventDefault();setCashSaving(true);setError("");
 try{
  const payload={employeeId:cashEmployeeId||undefined,direction:cashDirection,amount:Number(normalizeNumber(cashAmount)),transactionDate:cashDate,description:cashDescription.trim(),notes:cashNotes.trim()||null,confirmDuplicate};
  if(!confirmDuplicate){
   const check=await api<{data:{duplicate:boolean;matches:CashTx[]}}>("/api/cash-custody/check-duplicate",{method:"POST",body:JSON.stringify(payload)});
   if(check.data.duplicate){setDuplicateMatches(check.data.matches);setDuplicateOpen(true);setCashSaving(false);return}
  }
  await api("/api/cash-custody",{method:"POST",body:JSON.stringify(payload)});
  setCashAmount("");setCashDescription("");setCashNotes("");setDuplicateOpen(false);setDuplicateMatches([]);
  if(has("cash_custody.view")||has("cash_custody.view_own"))setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data);
 }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل حركة العهدة النقدية")}finally{setCashSaving(false)}
}
 async function openTransferHistory(x:Custody){try{setError("");setHistoryCustodyCode(x.code);setTransferHistory((await api<{data:CustodyTransfer[]}>("/api/custodies/"+x.id+"/transfers")).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل التحويلات")}}
 async function submitCustodyTransfer(e:FormEvent){e.preventDefault();if(!transferCustodyId||!transferToEmployeeId){setError("اختر العهدة والموظف المستلم");return}setTransferSaving(true);setError("");try{await api("/api/custodies/"+transferCustodyId+"/transfer",{method:"POST",body:JSON.stringify({toEmployeeId:transferToEmployeeId,notes:transferNotes.trim()||null})});setTransferCustodyId("");setTransferToEmployeeId("");setTransferNotes("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تحويل العهدة")}finally{setTransferSaving(false)}}
 async function submitCashTransfer(e:FormEvent){e.preventDefault();setCashTransferSaving(true);setError("");try{await api("/api/cash-custody/transfers",{method:"POST",body:JSON.stringify({fromEmployeeId:cashTransferFromEmployeeId,toEmployeeId:cashTransferToEmployeeId,amount:Number(normalizeNumber(cashTransferAmount)),transactionDate:cashDate,description:cashTransferDescription.trim(),notes:cashTransferNotes.trim()||null})});setCashTransferAmount("");setCashTransferNotes("");setCashTransferDescription("تحويل عهدة نقدية");setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحويل العهدة النقدية")}finally{setCashTransferSaving(false)}}
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{
  await api("/api/custodies",{method:"POST",body:JSON.stringify({employeeId,custodyType:type,description,quantity:Number(normalizeNumber(quantity)),unitValue:Number(normalizeNumber(unitValue||"0")),dueDate:dueDate||null,notes:notes||null})});
  setEmployeeId("");setType("");setDescription("");setQuantity("");setUnitValue("");setDueDate("");setNotes("");await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل العهدة")}finally{setSaving(false)}}
 async function settle(x:Custody){
  const raw=window.prompt("الكمية المرتجعة — المتبقي "+x.remaining_quantity,"0");if(raw===null)return;
  const q=Number(normalizeNumber(raw));
  const lostRaw=window.prompt("الكمية المفقودة إن وجدت","0");if(lostRaw===null)return;
  const lost=Number(normalizeNumber(lostRaw));
  if(!Number.isFinite(q)||q<0||!Number.isFinite(lost)||lost<0||q+lost<=0||q+lost>x.remaining_quantity){setError("راجع الكمية المرتجعة والمفقودة؛ يجب أن تكونا صحيحتين ومجموعهما لا يتجاوز المتبقي");return}
  const damageRaw=window.prompt("قيمة التلف إن وجدت","0");if(damageRaw===null)return;
  const shortageRaw=window.prompt("قيمة العجز المالي إن وجد","0");if(shortageRaw===null)return;
  const damage=Number(normalizeNumber(damageRaw)),shortage=Number(normalizeNumber(shortageRaw));
  if(!Number.isFinite(damage)||damage<0||!Number.isFinite(shortage)||shortage<0){setError("قيمة التلف أو العجز غير صحيحة");return}
  try{await api("/api/custodies/"+x.id+"/settlements",{method:"POST",body:JSON.stringify({returnedQuantity:q,lostQuantity:lost,damageValue:damage,shortageValue:shortage})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسوية العهدة")}
 }
 return <div className="app-shell"><Sidebar active="/custody"/><main className="main"><header className="topbar"><div><h1 className="page-title">عهد الموظفين</h1><p className="page-subtitle">تسجيل العهدة على الموظف، متابعة المتبقي، ثم تسويتها بسجل مستقل.</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 {has("custody.create")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل عهدة</h2><div className="form-hint">كل عهدة تحصل على رقم CUS مستقل ولا تتغير قيمتها القديمة بعد التسوية.</div></div></div>
  <div className="form-grid">
   <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>
   <label>نوع العهدة<input value={type} onChange={e=>setType(e.target.value)} placeholder="مثال: هاتف / أدوات / خامات" required/></label>
   <label>الوصف<input value={description} onChange={e=>setDescription(e.target.value)} placeholder="تفاصيل العهدة" required/></label>
   <label>الكمية<input type="text" inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
   <label>قيمة الوحدة<input type="text" inputMode="decimal" value={unitValue} onChange={e=>setUnitValue(e.target.value)} placeholder="0"/></label>
   <label>تاريخ الاستحقاق<input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
   <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)}/></label>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={saving||!employeeId}>{saving?"جارٍ الحفظ...":"تسجيل العهدة"}</button></div>
 </form>}
 <section className="card"><div className="card-header"><div><h2 className="card-title">سجل العهد</h2><div className="form-hint">العهدة تظهر لصاحبها تلقائيًا حتى إغلاقها وتسويتها، ويمكن للإدارة تحويلها لموظف آخر مع حفظ سجل التحويل.</div></div><span className="count-badge">{items.length}</span></div>
  <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>نوع العهدة</th><th>الوصف</th><th>الأصل</th><th>المرتجع</th><th>المفقود</th><th>المتبقي</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
  {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td>{x.custody_type}</td><td>{x.description}</td><td>{formatQuantity(x.quantity,0)}</td><td>{formatQuantity(x.returned_quantity||0,0)}</td><td>{formatQuantity(x.lost_quantity||0,0)}</td><td>{formatQuantity(x.remaining_quantity||0,0)}</td><td><span className="status">{labels[x.status]||x.status}</span></td><td>{x.remaining_quantity>0&&has("custody.settle")&&<button className="secondary-btn" onClick={()=>settle(x)}>تسوية / مرتجع</button>} {x.remaining_quantity>0&&has("custody.transfer")&&<button className="secondary-btn" onClick={()=>{setTransferCustodyId(x.id);setTransferToEmployeeId("")}}>تحويل</button>} {(has("custody.view")||has("custody.view_own"))&&Number(x.transfer_count||0)>0&&<button className="secondary-btn" onClick={()=>void openTransferHistory(x)}>سجل التحويل</button>}</td></tr>)}
  {!items.length&&<tr><td colSpan={10}>لا توجد عهد مسجلة.</td></tr>}</tbody></table></div>
  {transferCustodyId&&has("custody.transfer")&&<form className="form-grid" onSubmit={submitCustodyTransfer} style={{padding:16,borderTop:"1px solid var(--border)"}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تحويل عهدة {items.find(x=>x.id===transferCustodyId)?.code||""}</h3><label>الموظف المستلم<SearchableSelect value={transferToEmployeeId} onChange={setTransferToEmployeeId} options={employees.filter(x=>x.id!==items.find(i=>i.id===transferCustodyId)?.employee_id).map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المستلم"/></label><label>ملاحظات التحويل<input value={transferNotes} onChange={e=>setTransferNotes(e.target.value)} placeholder="سبب التحويل أو تفاصيل التسليم"/></label><div className="form-actions"><button className="secondary-btn" type="button" onClick={()=>setTransferCustodyId("")}>إلغاء</button><button className="primary-button" disabled={transferSaving||!transferToEmployeeId}>{transferSaving?"جارٍ التحويل...":"تأكيد تحويل العهدة"}</button></div></form>}
 </section>

 <section className="card" style={{marginTop:16}}>
  <div className="card-header"><div><h2 className="card-title">العهدة النقدية</h2><div className="form-hint">الداخل والخارج يسجلان كحركات مستقلة، والرصيد يحسب تلقائيًا. المحاسب/الأدمن يستطيعان إدارة عهد الجميع، وصاحب العهدة يدير عهدته فقط.</div></div><span className="count-badge">{cash.length}</span></div>
  {(has("cash_custody.create")||has("cash_custody.create_own"))&&<form className="form-grid" onSubmit={submitCash}>
   <label>اتجاه الحركة<select value={cashDirection} onChange={e=>setCashDirection(e.target.value as "IN"|"OUT")}><option value="IN">داخل إلى العهدة</option><option value="OUT">صرف من العهدة</option></select></label>
   {(has("cash_custody.create")||has("cash_custody.view")||has("custody.create")||has("custody.view"))?<label>صاحب العهدة<SearchableSelect value={cashEmployeeId} onChange={setCashEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>:<div className="form-hint">الحركة هتتسجل على عهدتك الشخصية حسب صلاحيات حسابك.</div>}
   <label>المبلغ<input inputMode="decimal" value={cashAmount} onChange={e=>setCashAmount(e.target.value)} required/></label>
   <label>التاريخ<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label>
   <label style={{gridColumn:"1/-1"}}>البيان<input value={cashDescription} onChange={e=>setCashDescription(e.target.value)} placeholder="مثال: إضافة عهدة نقدية / صرف مشتريات" required/></label>
   <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={cashNotes} onChange={e=>setCashNotes(e.target.value)}/></label>
   <div className="form-actions"><button className="primary-button" disabled={cashSaving||!cashAmount||!cashDescription.trim()}>{cashSaving?"جارٍ التسجيل...":"تسجيل الحركة"}</button></div>
  </form>}
  {has("cash_custody.transfer")&&<form className="form-grid" onSubmit={submitCashTransfer} style={{padding:16,borderTop:"1px solid var(--border)"}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تحويل رصيد بين العهد النقدية</h3><label>من عهدة الموظف<SearchableSelect value={cashTransferFromEmployeeId} onChange={setCashTransferFromEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المحول"/></label><label>إلى عهدة الموظف<SearchableSelect value={cashTransferToEmployeeId} onChange={setCashTransferToEmployeeId} options={employees.filter(x=>x.id!==cashTransferFromEmployeeId).map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المستلم"/></label><label>المبلغ<input inputMode="decimal" value={cashTransferAmount} onChange={e=>setCashTransferAmount(e.target.value)} required/></label><label>تاريخ التحويل<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label><label>البيان<input value={cashTransferDescription} onChange={e=>setCashTransferDescription(e.target.value)} required/></label><label>ملاحظات<input value={cashTransferNotes} onChange={e=>setCashTransferNotes(e.target.value)}/></label><div className="form-actions"><button className="primary-button" disabled={cashTransferSaving||!cashTransferFromEmployeeId||!cashTransferToEmployeeId||cashTransferFromEmployeeId===cashTransferToEmployeeId||!cashTransferAmount||Number(normalizeNumber(cashTransferAmount))<=0}>{cashTransferSaving?"جارٍ التحويل...":"تأكيد تحويل الرصيد"}</button></div><p className="form-hint" style={{gridColumn:"1/-1"}}>التحويل ينشئ حركة خروج على العهدة الأولى وحركة دخول مساوية على الثانية في معاملة واحدة، ولا يسمح بتجاوز الرصيد المتاح.</p></form>}
  {(has("cash_custody.view")||has("cash_custody.view_own"))&&<div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>النوع</th><th>المبلغ</th><th>التاريخ</th><th>البيان</th><th>مرجع التحويل</th><th>الرصيد بعد الحركة</th></tr></thead><tbody>{cash.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.employee_name}</td><td>{x.direction==="IN"?"داخل":"خارج"}</td><td className="money">{formatMoney(x.amount)}</td><td>{x.transaction_date}</td><td>{x.description}</td><td className="mono">{x.transfer_code||"—"}</td><td className="money">{formatMoney(x.balance)}</td></tr>)}{!cash.length&&<tr><td colSpan={8}>لا توجد حركات نقدية.</td></tr>}</tbody></table></div>}
 </section>
 {historyCustodyCode&&<div className="modal-backdrop" onClick={()=>setHistoryCustodyCode("")}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">سجل تحويلات العهدة {historyCustodyCode}</h2><div className="form-hint">كل تحويل محفوظ باسم المحول والمستلم وتاريخه.</div></div><button type="button" className="secondary-btn" onClick={()=>setHistoryCustodyCode("")}>إغلاق</button></div><div className="table-wrap"><table><thead><tr><th>رقم التحويل</th><th>من</th><th>إلى</th><th>الكمية عند التحويل</th><th>التاريخ</th><th>بواسطة</th><th>ملاحظات</th></tr></thead><tbody>{transferHistory.map(t=><tr key={t.id}><td className="mono">{t.code}</td><td>{t.from_employee_name}</td><td>{t.to_employee_name}</td><td>{formatQuantity(t.remaining_quantity,0)}</td><td>{new Date(t.created_at).toLocaleString("ar-EG")}</td><td>{t.created_by_username}</td><td>{t.notes||"—"}</td></tr>)}{!transferHistory.length&&<tr><td colSpan={7}>لا توجد تحويلات مسجلة.</td></tr>}</tbody></table></div></div></div>}
 {duplicateOpen&&<div className="modal-backdrop" onClick={()=>setDuplicateOpen(false)}><div className="modal-card" onClick={e=>e.stopPropagation()}>
   <div className="card-header"><div><h2 className="card-title">تأكيد حركة مكررة</h2><div className="form-hint">وجد النظام حركة أو أكثر مشابهة. هل تريد تسجيل الحركة الجديدة رغم ذلك؟</div></div><button type="button" className="secondary-btn" onClick={()=>setDuplicateOpen(false)}>إغلاق</button></div>
   <div className="table-wrap"><table><thead><tr><th>الكود</th><th>المبلغ</th><th>التاريخ</th><th>البيان</th></tr></thead><tbody>{duplicateMatches.map(x=><tr key={x.id}><td>{x.code}</td><td>{formatMoney(x.amount)}</td><td>{x.transaction_date}</td><td>{x.description}</td></tr>)}</tbody></table></div>
   <div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>setDuplicateOpen(false)}>إلغاء</button><button type="button" className="primary-button" onClick={e=>void submitCash(e as any,true)}>تأكيد وتسجيل العملية</button></div>
 </div></div>} </section></main></div>
}
