"use client";
import {FormEvent,useEffect,useRef,useState} from "react";
import Link from "next/link";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {formatMoney,formatQuantity} from "../../lib/format";
import {SearchableSelect} from "../../components/searchable-select";

type Employee={id:string;full_name:string;code:string};
type CustodyOrder={id:string;code:string;order_name:string;contract_value:number;collected_amount:number;remaining_collectible:number|null};
type AdminExpense={id:string;code:string;category:string;description:string;amount:number;expense_date:string;expense_type:"DIRECT"|"ADMINISTRATIVE";paid_from_employee_id:string|null;created_by_username:string|null};

const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");

export default function CustodyPage(){
 const {has,permissions}=usePermissions();
 type CashTx={id:string;code:string;employee_id?:string;employee_name:string;direction:"IN"|"OUT";amount:number;transaction_date:string;description:string;notes:string|null;balance:number;transfer_code?:string|null};
 const [employees,setEmployees]=useState<Employee[]>([]),[cashEmployeeId,setCashEmployeeId]=useState(""),[error,setError]=useState("");
 const [unifiedOperation,setUnifiedOperation]=useState<"FUNDING"|"COLLECTION"|"ADMIN_EXPENSE"|"ORDER_EXPENSE">("FUNDING");
 useEffect(()=>{if(!permissions)return;const canFund=permissions.some(code=>["cash_custody.create","cash_custody.create_own"].includes(code)),canCollect=permissions.some(code=>["cash_custody.order_collection","cash_custody.order_collection_own"].includes(code)),canExpense=permissions.some(code=>["cash_custody.order_expense","cash_custody.order_expense_own"].includes(code));setUnifiedOperation(current=>{if(current==="FUNDING"&&!canFund)return canCollect?"COLLECTION":canExpense?"ADMIN_EXPENSE":current;if(current==="COLLECTION"&&!canCollect)return canFund?"FUNDING":canExpense?"ADMIN_EXPENSE":current;if((current==="ADMIN_EXPENSE"||current==="ORDER_EXPENSE")&&!canExpense)return canFund?"FUNDING":canCollect?"COLLECTION":current;return current;});},[permissions]);
 const [cash,setCash]=useState<CashTx[]>([]),[cashDirection,setCashDirection]=useState<"IN"|"OUT">("IN"),[cashAmount,setCashAmount]=useState(""),[cashDate,setCashDate]=useState(new Date().toISOString().slice(0,10)),[cashDescription,setCashDescription]=useState(""),[cashNotes,setCashNotes]=useState(""),[cashSaving,setCashSaving]=useState(false),[duplicateMatches,setDuplicateMatches]=useState<CashTx[]>([]),[duplicateOpen,setDuplicateOpen]=useState(false);
 const [orders,setOrders]=useState<CustodyOrder[]>([]),[collectionOrderId,setCollectionOrderId]=useState(""),[collectionAmount,setCollectionAmount]=useState(""),[collectionDescription,setCollectionDescription]=useState("تحصيل من العميل"),[collectionNotes,setCollectionNotes]=useState(""),[collectionSaving,setCollectionSaving]=useState(false);
 const collectionIdempotency=useRef<{fingerprint:string;key:string}|null>(null);
 const [expenseOrderId,setExpenseOrderId]=useState(""),[expenseAmount,setExpenseAmount]=useState(""),[expenseCategory,setExpenseCategory]=useState("مصروفات لخدمة المصنع"),[expenseDescription,setExpenseDescription]=useState(""),[expenseNotes,setExpenseNotes]=useState(""),[expenseSaving,setExpenseSaving]=useState(false);
 const expenseIdempotency=useRef<{fingerprint:string;key:string}|null>(null);
 const [adminExpenseAmount,setAdminExpenseAmount]=useState(""),[adminExpenseCategory,setAdminExpenseCategory]=useState("مصاريف لخدمة المصنع"),[adminExpenseSubcategory,setAdminExpenseSubcategory]=useState("مستلزمات عامة"),[adminExpenseDescription,setAdminExpenseDescription]=useState(""),[adminExpenseNotes,setAdminExpenseNotes]=useState(""),[adminExpenseSaving,setAdminExpenseSaving]=useState(false),[message,setMessage]=useState("");
 const adminExpenseIdempotency=useRef<{fingerprint:string;key:string}|null>(null);
 const [adminExpenses,setAdminExpenses]=useState<AdminExpense[]>([]),[adminExpenseFrom,setAdminExpenseFrom]=useState(""),[adminExpenseTo,setAdminExpenseTo]=useState(""),[adminExpenseFilterCategory,setAdminExpenseFilterCategory]=useState("ALL"),[adminExpenseSearch,setAdminExpenseSearch]=useState("");

 const [cashTransferFromEmployeeId,setCashTransferFromEmployeeId]=useState(""),[cashTransferToEmployeeId,setCashTransferToEmployeeId]=useState(""),[cashTransferAmount,setCashTransferAmount]=useState(""),[cashTransferDescription,setCashTransferDescription]=useState("تحويل عهدة نقدية"),[cashTransferNotes,setCashTransferNotes]=useState(""),[cashTransferSaving,setCashTransferSaving]=useState(false);
 async function loadAdministrativeExpenses(){
  if(!has("finance.expenses.view")){setAdminExpenses([]);return;}
  try{const result=await api<{data:AdminExpense[]}>("/api/accounting/expenses");setAdminExpenses(result.data.filter(x=>x.expense_type==="ADMINISTRATIVE"));}
  catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل المصروفات الإدارية");}
 }
 async function load(){
  setError("");
  const canReadCash=Boolean(permissions?.some(code=>["cash_custody.view","cash_custody.view_own"].includes(code)));
  if(canReadCash){
   try{setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data)}
   catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الحركات النقدية")}
  }else setCash([]);

 }
 useEffect(()=>{if(permissions!==null)void load()},[permissions]);
 useEffect(()=>{if(permissions!==null&&has("finance.expenses.view"))void loadAdministrativeExpenses()},[permissions]);
 // Load order options only for users allowed to create cash-custody postings.
 useEffect(()=>{
  if(!permissions?.some(code=>["cash_custody.order_collection","cash_custody.order_collection_own","cash_custody.order_expense","cash_custody.order_expense_own"].includes(code)))return;
  let active=true;
  api<{data:CustodyOrder[]}>("/api/cash-custody/eligible-orders").then(r=>{
   if(!active)return;
   setOrders(r.data);
   setCollectionOrderId(current=>current&&r.data.some(x=>x.id===current)?current:(r.data[0]?.id||""));
   setExpenseOrderId(current=>current&&r.data.some(x=>x.id===current)?current:(r.data[0]?.id||""));
  }).catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل الطلبيات");});
  return()=>{active=false};
 },[permissions]);
 // Load employee options independently from the custody ledger so a ledger-view error
 // cannot block the picker. Support both all-scope and own-scope permissions.
 useEffect(()=>{
  const pickerPermissions=["cash_custody.create","cash_custody.create_own","cash_custody.view","cash_custody.view_own","cash_custody.transfer","cash_custody.order_collection","cash_custody.order_collection_own","cash_custody.order_expense","cash_custody.order_expense_own"];
  if(!permissions?.some(code=>pickerPermissions.includes(code)))return;
  let active=true;
  api<{data:Employee[]}>("/api/custodies/eligible-employees")
   .then(r=>{if(active){setEmployees(r.data);setCashEmployeeId(current=>current&&r.data.some(x=>x.id===current)?current:(r.data[0]?.id||""));}})
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
  await api(cashDirection==="IN"?"/api/cash-custody/top-ups":"/api/cash-custody",{method:"POST",body:JSON.stringify(payload)});
  setCashAmount("");setCashDescription("");setCashNotes("");setDuplicateOpen(false);setDuplicateMatches([]);
  if(has("cash_custody.view")||has("cash_custody.view_own"))setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data);
 }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل حركة العهدة النقدية")}finally{setCashSaving(false)}
}
 async function submitOrderCollection(e:FormEvent){e.preventDefault();setCollectionSaving(true);setError("");const payload={employeeId:has("cash_custody.order_collection")?cashEmployeeId||undefined:undefined,orderId:collectionOrderId,amount:Number(normalizeNumber(collectionAmount)),transactionDate:cashDate,description:collectionDescription.trim(),notes:collectionNotes.trim()||null};const fingerprint=JSON.stringify(payload);const previous=collectionIdempotency.current;const operationKey=previous?.fingerprint===fingerprint?previous.key:crypto.randomUUID();collectionIdempotency.current={fingerprint,key:operationKey};try{await api("/api/cash-custody/order-collections",{method:"POST",body:JSON.stringify({...payload,idempotencyKey:operationKey})});setCollectionAmount("");setCollectionNotes("");collectionIdempotency.current=null;await load();setOrders((await api<{data:CustodyOrder[]}>("/api/cash-custody/eligible-orders")).data);}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل تحصيل الطلبية");}finally{setCollectionSaving(false)}}
 async function submitOrderExpense(e:FormEvent){e.preventDefault();setExpenseSaving(true);setError("");const payload={employeeId:has("cash_custody.order_expense")?cashEmployeeId||undefined:undefined,orderId:expenseOrderId,amount:Number(normalizeNumber(expenseAmount)),transactionDate:cashDate,category:expenseCategory,description:expenseDescription.trim(),notes:expenseNotes.trim()||null};const fingerprint=JSON.stringify(payload);const previous=expenseIdempotency.current;const operationKey=previous?.fingerprint===fingerprint?previous.key:crypto.randomUUID();expenseIdempotency.current={fingerprint,key:operationKey};try{await api("/api/cash-custody/order-expenses",{method:"POST",body:JSON.stringify({...payload,idempotencyKey:operationKey})});setExpenseAmount("");setExpenseDescription("");setExpenseNotes("");expenseIdempotency.current=null;await load();}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل مصروف الطلبية");}finally{setExpenseSaving(false)}}
 async function submitAdministrativeExpense(e:FormEvent){
 e.preventDefault();setAdminExpenseSaving(true);setError("");setMessage("");
 const payload={employeeId:has("cash_custody.order_expense")?cashEmployeeId||undefined:undefined,amount:Number(normalizeNumber(adminExpenseAmount)),transactionDate:cashDate,category:adminExpenseCategory+" — "+adminExpenseSubcategory,description:adminExpenseDescription.trim(),notes:adminExpenseNotes.trim()||null};
 const fingerprint=JSON.stringify(payload);const previous=adminExpenseIdempotency.current;const operationKey=previous?.fingerprint===fingerprint?previous.key:crypto.randomUUID();adminExpenseIdempotency.current={fingerprint,key:operationKey};
 try{await api("/api/cash-custody/administrative-expenses",{method:"POST",body:JSON.stringify({...payload,idempotencyKey:operationKey})});setAdminExpenseAmount("");setAdminExpenseDescription("");setAdminExpenseNotes("");adminExpenseIdempotency.current=null;setMessage("تم تسجيل المصروف الإداري في المالية وخصمه من العهدة. سيُوزع على الطلبيات عند تصفية الفترة.");await load();await loadAdministrativeExpenses();}
 catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المصروف الإداري من العهدة")}finally{setAdminExpenseSaving(false)}
}
 async function submitCashTransfer(e:FormEvent){e.preventDefault();setCashTransferSaving(true);setError("");try{await api("/api/cash-custody/transfers",{method:"POST",body:JSON.stringify({fromEmployeeId:cashTransferFromEmployeeId,toEmployeeId:cashTransferToEmployeeId,amount:Number(normalizeNumber(cashTransferAmount)),transactionDate:cashDate,description:cashTransferDescription.trim(),notes:cashTransferNotes.trim()||null})});setCashTransferAmount("");setCashTransferNotes("");setCashTransferDescription("تحويل عهدة نقدية");setCash((await api<{data:CashTx[]}>("/api/cash-custody")).data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحويل العهدة النقدية")}finally{setCashTransferSaving(false)}}
 const cashSummary=(()=>{
  const inflow=cash.filter(x=>x.direction==="IN").reduce((sum,x)=>sum+Number(x.amount||0),0);
  const outflow=cash.filter(x=>x.direction==="OUT").reduce((sum,x)=>sum+Number(x.amount||0),0);
  // The API returns newest transactions first; take the latest balance once per employee.
  const latestBalanceByEmployee=new Map<string,number>();
  for(const tx of cash){const employeeKey=tx.employee_id||tx.employee_name;if(!latestBalanceByEmployee.has(employeeKey))latestBalanceByEmployee.set(employeeKey,Number(tx.balance||0));}
  const balance=[...latestBalanceByEmployee.values()].reduce((sum,value)=>sum+value,0);
  return {inflow,outflow,balance,transactions:cash.length};
 })();
 const canViewCash=has("cash_custody.view")||has("cash_custody.view_own");
 return <div className="app-shell"><Sidebar active="/custody"/><main className="main"><header className="topbar"><div><h1 className="page-title">العهدة النقدية والمصروفات</h1><p className="page-subtitle">متابعة رصيد كل مسؤول وحركات التمويل والتحصيل والصرف والتحويلات النقدية. لا تُدار هنا عهد عينية أو أجهزة؛ خصومات العامل وتلفياته تُسجل يدويًا في المستحقات والمصروفات حسب الإجراء المالي المعتمد.</p></div><div className="form-actions"><Link className="secondary-btn" href="/payments">القبض ومستحقات العمال</Link><Link className="secondary-btn" href="/finance/review">مراجعة الحالات المالية</Link><Link className="secondary-btn" href="/accounting">المالية</Link></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 {message&&<div className="success-box">{message}</div>}
 {canViewCash&&<section className="card" style={{marginBottom:16}}>
  <div className="card-header"><div><h2 className="card-title">ملخص العهدة النقدية</h2><div className="form-hint">ملخص للحركات النقدية التي أعادها النظام حاليًا؛ الأرقام تتحدث بعد تسجيل الحركة أو إعادة تحميل البيانات.</div></div><button type="button" className="secondary-btn" onClick={()=>void load()}>تحديث البيانات</button></div>
  <div className="form-grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",padding:"0 16px 16px"}}>
   <div className="card" style={{margin:0,borderTop:"3px solid var(--success,#16a34a)"}}><div className="form-hint">الرصيد الحالي للعهد النقدية المعروضة</div><div className="page-title money" style={{fontSize:24,marginTop:8}}>{formatMoney(cashSummary.balance)}</div></div>
   <div className="card" style={{margin:0,borderTop:"3px solid var(--success,#16a34a)"}}><div className="form-hint">إجمالي الوارد في الحركات المعروضة</div><div className="page-title money" style={{fontSize:24,marginTop:8}}>{formatMoney(cashSummary.inflow)}</div></div>
   <div className="card" style={{margin:0,borderTop:"3px solid var(--danger,#dc2626)"}}><div className="form-hint">إجمالي الصادر في الحركات المعروضة</div><div className="page-title money" style={{fontSize:24,marginTop:8}}>{formatMoney(cashSummary.outflow)}</div></div>
   <div className="card" style={{margin:0}}><div className="form-hint">عدد الحركات النقدية المعروضة</div><div className="page-title" style={{fontSize:24,marginTop:8}}>{formatQuantity(cashSummary.transactions,0)}</div></div>
  </div>
  <div className="form-hint" style={{padding:"0 16px 16px"}}>تنبيه: إجماليات الوارد والصادر تخص الحركات المحمّلة فقط، وقد تشمل تحويلات بين العهد؛ لا تُعامل وحدها كإيراد أو مصروف محاسبي. الرصيد يجمع آخر رصيد ظاهر لكل موظف.</div>
 </section>}
 <section className="card" style={{marginTop:16}}>
  <div className="card-header"><div><h2 className="card-title">تسجيل حركة العهدة</h2><div className="form-hint">اختار اتجاه الحركة ونوعها؛ الحقول المناسبة فقط هي اللي هتظهر، وكل حركة تظل مرتبطة بسجلها المالي الأصلي.</div></div><span className="count-badge">{cash.length}</span></div>
  <div className="form-grid" style={{padding:"0 16px 16px"}}>
   <label>اتجاه الحركة<select value={cashDirection} onChange={e=>{const d=e.target.value as "IN"|"OUT";setCashDirection(d);setUnifiedOperation(d==="IN"?"FUNDING":"ADMIN_EXPENSE");}}><option value="IN">داخل العهدة</option><option value="OUT">خارج العهدة</option></select></label>
   <label>نوع الحركة<select value={unifiedOperation} onChange={e=>{const v=e.target.value as typeof unifiedOperation;setUnifiedOperation(v);setCashDirection(v==="FUNDING"||v==="COLLECTION"?"IN":"OUT");}}>{cashDirection==="IN"?<><option value="FUNDING">داخل إداري — تمويل من المدير المالي</option>{(has("cash_custody.order_collection")||has("cash_custody.order_collection_own"))&&<option value="COLLECTION">داخل — تحصيل من طلبية</option>}</>:<>{(has("cash_custody.order_expense")||has("cash_custody.order_expense_own"))&&<><option value="ADMIN_EXPENSE">خارج — مصروفات إدارية</option><option value="ORDER_EXPENSE">خارج — مصروف على طلبية</option></>}</>}</select></label>
  </div>
  {(has("cash_custody.create")||has("cash_custody.create_own"))&&unifiedOperation==="FUNDING"&&<form className="form-grid" onSubmit={submitCash}>
   <div className="form-hint" style={{gridColumn:"1/-1"}}>داخل إداري — تمويل من المدير المالي (لا يُحتسب إيراد مبيعات).</div>
   {(has("cash_custody.create")||has("cash_custody.view"))?<label>صاحب العهدة<SearchableSelect value={cashEmployeeId} onChange={setCashEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>:<div className="form-hint">الحركة هتتسجل على عهدتك الشخصية حسب صلاحيات حسابك.</div>}
   <label>المبلغ<input inputMode="decimal" value={cashAmount} onChange={e=>setCashAmount(e.target.value)} required/></label>
   <label>التاريخ<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label>
   <label style={{gridColumn:"1/-1"}}>البيان<input value={cashDescription} onChange={e=>setCashDescription(e.target.value)} placeholder="مثال: تمويل عهدة من المدير المالي" required/></label>
   <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={cashNotes} onChange={e=>setCashNotes(e.target.value)}/></label>
   <div className="form-actions"><button className="primary-button" disabled={cashSaving||!cashAmount||!cashDescription.trim()}>{cashSaving?"جارٍ التسجيل...":"تسجيل الحركة"}</button></div>
  </form>}
  <>
    {(has("cash_custody.order_collection")||has("cash_custody.order_collection_own"))&&unifiedOperation==="COLLECTION"&&<form className="form-grid" onSubmit={submitOrderCollection} style={{padding:16,borderTop:"1px solid var(--border)"}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تحصيل للطلبية وإضافة المبلغ لعهدتك</h3>
     {has("cash_custody.order_collection")&&<label>صاحب العهدة<SearchableSelect value={cashEmployeeId} onChange={setCashEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>}
     <label>الطلبية<select value={collectionOrderId} onChange={e=>setCollectionOrderId(e.target.value)} required>{orders.map(o=><option key={o.id} value={o.id}>{o.code} — {o.order_name} ({Number(o.contract_value||0)>0?"متبقي تحصيل "+formatMoney(o.remaining_collectible??0):"بدون حد تعاقد مسجل"})</option>)}</select></label>
     <label>المبلغ المحصل<input inputMode="decimal" value={collectionAmount} onChange={e=>setCollectionAmount(e.target.value)} required/></label><label>التاريخ<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label><label>البيان<input value={collectionDescription} onChange={e=>setCollectionDescription(e.target.value)} required/></label><label>ملاحظات<input value={collectionNotes} onChange={e=>setCollectionNotes(e.target.value)}/></label>
     <div className="form-actions"><button className="primary-button" disabled={collectionSaving||!collectionOrderId||!collectionAmount||Number(normalizeNumber(collectionAmount))<=0||(Number(orders.find(o=>o.id===collectionOrderId)?.contract_value||0)>0&&Number(normalizeNumber(collectionAmount))>Number(orders.find(o=>o.id===collectionOrderId)?.remaining_collectible||0))}>{collectionSaving?"جارٍ تسجيل التحصيل...":"تسجيل التحصيل وإضافته للعهدة"}</button></div><p className="form-hint" style={{gridColumn:"1/-1"}}>التحصيل يزيد إيراد الطلبية ورصيد العهدة معًا في معاملة واحدة، ويُمنع تجاوز قيمة العقد المتبقية.</p>
    </form>}
    {(has("cash_custody.order_expense")||has("cash_custody.order_expense_own"))&&unifiedOperation==="ORDER_EXPENSE"&&<form className="form-grid" onSubmit={submitOrderExpense} style={{padding:16,borderTop:"1px solid var(--border)"}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>صرف من العهدة على طلبية (مصروف مباشر)</h3>
     {has("cash_custody.order_expense")&&<label>صاحب العهدة<SearchableSelect value={cashEmployeeId} onChange={setCashEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>}
     <label>الطلبية<select value={expenseOrderId} onChange={e=>setExpenseOrderId(e.target.value)} required>{orders.map(o=><option key={o.id} value={o.id}>{o.code} — {o.order_name}</option>)}</select></label>
     <label>تصنيف المصروف<select value={expenseCategory} onChange={e=>setExpenseCategory(e.target.value)}>{["خامات","نقل","تحميل وتنزيل","صيانة","مستلزمات إنتاج","مصروفات لخدمة المصنع","أخرى"].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
     <label>المبلغ<input inputMode="decimal" value={expenseAmount} onChange={e=>setExpenseAmount(e.target.value)} required/></label><label>التاريخ<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label><label style={{gridColumn:"1/-1"}}>البيان<input value={expenseDescription} onChange={e=>setExpenseDescription(e.target.value)} required/></label><label style={{gridColumn:"1/-1"}}>ملاحظات<input value={expenseNotes} onChange={e=>setExpenseNotes(e.target.value)}/></label>
     <div className="form-actions"><button className="primary-button" disabled={expenseSaving||!expenseOrderId||!expenseAmount||Number(normalizeNumber(expenseAmount))<=0}>{expenseSaving?"جارٍ تسجيل المصروف...":"تسجيل المصروف وخصمه من العهدة"}</button></div><p className="form-hint" style={{gridColumn:"1/-1"}}>تُسجّل العملية كمصروف مباشر على الطلبية وتُخصم من رصيد العهدة في نفس المعاملة. يمكن أن يصبح الرصيد سالبًا إذا دفع الموظف من ماله الشخصي، ويُسوّى مع الوارد القادم.</p>
    </form>}
    {(has("cash_custody.order_expense")||has("cash_custody.order_expense_own"))&&unifiedOperation==="ADMIN_EXPENSE"&&<form className="form-grid" onSubmit={submitAdministrativeExpense} style={{padding:16,borderTop:"1px solid var(--border)"}}>
     <h3 className="card-title" style={{gridColumn:"1/-1"}}>مصروف إداري من العهدة</h3>
     {has("cash_custody.order_expense")&&<label>صاحب العهدة<SearchableSelect value={cashEmployeeId} onChange={setCashEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>}
     <label>التصنيف الرئيسي<select value={adminExpenseCategory} onChange={e=>{const v=e.target.value;setAdminExpenseCategory(v);const subs:Record<string,string[]>={"بوفيه":["شاي وقهوة","مشروبات ومياه شرب","مستلزمات بوفيه"],"كهرباء":["فاتورة كهرباء","مستلزمات كهرباء","إصلاحات كهربائية"],"صيانة وتكاليف ماكينات":["صيانة دورية","قطع غيار","إصلاح أعطال","زيوت ومستلزمات صيانة"],"مصاريف لخدمة المصنع":["أدوات تشغيل","مستلزمات عامة","احتياجات إدارية وتشغيلية"],"نقل — بنزين":["بنزين","سولار"],"نقل — كارتة":["كارتة طرق","رسوم مرور"],"نقل — أجرة تحميل وتنزيل":["أجرة تحميل","أجرة تنزيل","عمالة تحميل وتنزيل"],"نقل — صيانة سيارات":["صيانة","قطع غيار","زيوت"],"نقل — أخرى":["انتقالات","نقل متنوع"],"مياه":["فاتورة مياه","مياه شرب"],"إنترنت واتصالات":["إنترنت","خطوط موبايل","رصيد ومكالمات"],"نظافة":["أدوات نظافة","منظفات","خدمات نظافة"],"إيجار":["إيجار مقر","إيجار مخزن","إيجار معدات"],"أخرى":["مصروفات غير مصنفة"]};setAdminExpenseSubcategory(subs[v]?.[0]||"مصروفات غير مصنفة");}}>{["بوفيه","كهرباء","صيانة وتكاليف ماكينات","مصاريف لخدمة المصنع","نقل — بنزين","نقل — كارتة","نقل — أجرة تحميل وتنزيل","نقل — صيانة سيارات","نقل — أخرى","مياه","إنترنت واتصالات","نظافة","إيجار","أخرى"].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
     <label>التصنيف الفرعي<select value={adminExpenseSubcategory} onChange={e=>setAdminExpenseSubcategory(e.target.value)}>{({"بوفيه":["شاي وقهوة","مشروبات ومياه شرب","مستلزمات بوفيه"],"كهرباء":["فاتورة كهرباء","مستلزمات كهرباء","إصلاحات كهربائية"],"صيانة وتكاليف ماكينات":["صيانة دورية","قطع غيار","إصلاح أعطال","زيوت ومستلزمات صيانة"],"مصاريف لخدمة المصنع":["أدوات تشغيل","مستلزمات عامة","احتياجات إدارية وتشغيلية"],"نقل — بنزين":["بنزين","سولار"],"نقل — كارتة":["كارتة طرق","رسوم مرور"],"نقل — أجرة تحميل وتنزيل":["أجرة تحميل","أجرة تنزيل","عمالة تحميل وتنزيل"],"نقل — صيانة سيارات":["صيانة","قطع غيار","زيوت"],"نقل — أخرى":["انتقالات","نقل متنوع"],"مياه":["فاتورة مياه","مياه شرب"],"إنترنت واتصالات":["إنترنت","خطوط موبايل","رصيد ومكالمات"],"نظافة":["أدوات نظافة","منظفات","خدمات نظافة"],"إيجار":["إيجار مقر","إيجار مخزن","إيجار معدات"],"أخرى":["مصروفات غير مصنفة"]} as Record<string,string[]>)[adminExpenseCategory].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
     <label>المبلغ<input inputMode="decimal" value={adminExpenseAmount} onChange={e=>setAdminExpenseAmount(e.target.value)} required/></label>
     <label>التاريخ<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label>
     <label style={{gridColumn:"1/-1"}}>البيان<input value={adminExpenseDescription} onChange={e=>setAdminExpenseDescription(e.target.value)} required/></label>
     <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={adminExpenseNotes} onChange={e=>setAdminExpenseNotes(e.target.value)}/></label>
     <div className="form-actions"><button className="primary-button" disabled={adminExpenseSaving||!adminExpenseAmount||Number(normalizeNumber(adminExpenseAmount))<=0||!adminExpenseDescription.trim()}>{adminExpenseSaving?"جارٍ تسجيل المصروف...":"تسجيل المصروف الإداري وخصمه من العهدة"}</button></div>
     <p className="form-hint" style={{gridColumn:"1/-1"}}>يسجل كمصروف إداري في المالية ويُخصم من العهدة في نفس المعاملة، من غير ربطه بطلبية بعينها. توزيعه على الطلبيات يتم لاحقًا من شاشة تصفية الفترة المالية.</p>
    </form>}
    {has("finance.expenses.view")&&<section className="card" style={{margin:16}}>
     <div className="card-header"><div><h3 className="card-title">سجل المصروفات الإدارية</h3><div className="form-hint">نفس سجل المالية، مرتبط بالعهدة. المصروفات المسجلة من هنا تظهر هنا وفي صفحة المالية دون إنشاء سجل مكرر.</div></div><span className="count-badge">{adminExpenses.filter(x=>(!adminExpenseFrom||x.expense_date>=adminExpenseFrom)&&(!adminExpenseTo||x.expense_date<=adminExpenseTo)&&(adminExpenseFilterCategory==="ALL"||x.category===adminExpenseFilterCategory)&&(!adminExpenseSearch||(x.description+" "+x.code+" "+x.category).toLowerCase().includes(adminExpenseSearch.toLowerCase()))).length}</span></div>
     <div className="card-body"><div className="form-grid finance-four-grid">
       <label>من تاريخ<input type="date" value={adminExpenseFrom} onChange={e=>setAdminExpenseFrom(e.target.value)}/></label><label>إلى تاريخ<input type="date" value={adminExpenseTo} onChange={e=>setAdminExpenseTo(e.target.value)}/></label>
       <label>التصنيف<select value={adminExpenseFilterCategory} onChange={e=>setAdminExpenseFilterCategory(e.target.value)}><option value="ALL">كل التصنيفات</option>{Array.from(new Set(adminExpenses.map(x=>x.category))).sort().map(v=><option key={v} value={v}>{v}</option>)}</select></label>
       <label>بحث في البيان أو الكود<input value={adminExpenseSearch} onChange={e=>setAdminExpenseSearch(e.target.value)} placeholder="اكتب جزءًا من البيان أو الكود"/></label></div>
      <div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>{setAdminExpenseFrom("");setAdminExpenseTo("");setAdminExpenseFilterCategory("ALL");setAdminExpenseSearch("");}}>مسح الفلاتر</button><button type="button" className="secondary-btn" onClick={()=>void loadAdministrativeExpenses()}>تحديث السجل</button><strong>الإجمالي: {formatMoney(adminExpenses.filter(x=>(!adminExpenseFrom||x.expense_date>=adminExpenseFrom)&&(!adminExpenseTo||x.expense_date<=adminExpenseTo)&&(adminExpenseFilterCategory==="ALL"||x.category===adminExpenseFilterCategory)&&(!adminExpenseSearch||(x.description+" "+x.code+" "+x.category).toLowerCase().includes(adminExpenseSearch.toLowerCase()))).reduce((s,x)=>s+Number(x.amount||0),0))}</strong></div>
      <div className="table-wrap"><table><thead><tr><th>الكود</th><th>التصنيف</th><th>البيان التفصيلي</th><th>المبلغ</th><th>التاريخ</th><th>دفع من عهدة</th><th>سجل بواسطة</th></tr></thead><tbody>{adminExpenses.filter(x=>(!adminExpenseFrom||x.expense_date>=adminExpenseFrom)&&(!adminExpenseTo||x.expense_date<=adminExpenseTo)&&(adminExpenseFilterCategory==="ALL"||x.category===adminExpenseFilterCategory)&&(!adminExpenseSearch||(x.description+" "+x.code+" "+x.category).toLowerCase().includes(adminExpenseSearch.toLowerCase()))).map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.category}</td><td>{x.description}</td><td className="money">{formatMoney(x.amount)}</td><td>{x.expense_date}</td><td>{x.paid_from_employee_id?employees.find(e=>e.id===x.paid_from_employee_id)?.full_name||"موظف":"—"}</td><td>{x.created_by_username||"غير مسجل"}</td></tr>)}{!adminExpenses.length&&<tr><td colSpan={7}>لا توجد مصروفات إدارية مسجلة.</td></tr>}</tbody></table></div>
     </div></section>}
  </>
  {has("cash_custody.transfer")&&<form className="form-grid" onSubmit={submitCashTransfer} style={{padding:16,borderTop:"1px solid var(--border)"}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تحويل رصيد بين العهد النقدية</h3><label>من عهدة الموظف<SearchableSelect value={cashTransferFromEmployeeId} onChange={setCashTransferFromEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المحول"/></label><label>إلى عهدة الموظف<SearchableSelect value={cashTransferToEmployeeId} onChange={setCashTransferToEmployeeId} options={employees.filter(x=>x.id!==cashTransferFromEmployeeId).map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المستلم"/></label><label>المبلغ<input inputMode="decimal" value={cashTransferAmount} onChange={e=>setCashTransferAmount(e.target.value)} required/></label><label>تاريخ التحويل<input type="date" value={cashDate} onChange={e=>setCashDate(e.target.value)} required/></label><label>البيان<input value={cashTransferDescription} onChange={e=>setCashTransferDescription(e.target.value)} required/></label><label>ملاحظات<input value={cashTransferNotes} onChange={e=>setCashTransferNotes(e.target.value)}/></label><div className="form-actions"><button className="primary-button" disabled={cashTransferSaving||!cashTransferFromEmployeeId||!cashTransferToEmployeeId||cashTransferFromEmployeeId===cashTransferToEmployeeId||!cashTransferAmount||Number(normalizeNumber(cashTransferAmount))<=0}>{cashTransferSaving?"جارٍ التحويل...":"تأكيد تحويل الرصيد"}</button></div><p className="form-hint" style={{gridColumn:"1/-1"}}>التحويل ينشئ حركة خروج على العهدة الأولى وحركة دخول مساوية على الثانية في معاملة واحدة، ولا يسمح بتجاوز الرصيد المتاح.</p></form>}
  {(has("cash_custody.view")||has("cash_custody.view_own"))&&<div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>النوع</th><th>المبلغ</th><th>التاريخ</th><th>البيان</th><th>مرجع التحويل</th><th>الرصيد بعد الحركة</th></tr></thead><tbody>{cash.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.employee_name}</td><td>{x.direction==="IN"?"داخل":"خارج"}</td><td className="money">{formatMoney(x.amount)}</td><td>{x.transaction_date}</td><td>{x.description}</td><td className="mono">{x.transfer_code||"—"}</td><td className="money">{formatMoney(x.balance)}</td></tr>)}{!cash.length&&<tr><td colSpan={8}>لا توجد حركات نقدية.</td></tr>}</tbody></table></div>}
 </section>
 {duplicateOpen&&<div className="modal-backdrop" onClick={()=>setDuplicateOpen(false)}><div className="modal-card" onClick={e=>e.stopPropagation()}>
   <div className="card-header"><div><h2 className="card-title">تأكيد حركة مكررة</h2><div className="form-hint">وجد النظام حركة أو أكثر مشابهة. هل تريد تسجيل الحركة الجديدة رغم ذلك؟</div></div><button type="button" className="secondary-btn" onClick={()=>setDuplicateOpen(false)}>إغلاق</button></div>
   <div className="table-wrap"><table><thead><tr><th>الكود</th><th>المبلغ</th><th>التاريخ</th><th>البيان</th></tr></thead><tbody>{duplicateMatches.map(x=><tr key={x.id}><td>{x.code}</td><td>{formatMoney(x.amount)}</td><td>{x.transaction_date}</td><td>{x.description}</td></tr>)}</tbody></table></div>
   <div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>setDuplicateOpen(false)}>إلغاء</button><button type="button" className="primary-button" onClick={e=>void submitCash(e as any,true)}>تأكيد وتسجيل العملية</button></div>
 </div></div>} </section></main></div>
}
