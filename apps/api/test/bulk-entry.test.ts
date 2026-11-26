import {test} from "node:test";
import assert from "node:assert/strict";
import {parseBulkMessage,normalizeOrderLabel,similarity,parseDate} from "../src/modules/production/bulk-entry.js";

const lookup={
 employees:[{id:"e1",full_name:"محمد علي حسن"},{id:"e2",full_name:"احمد سعيد"},{id:"e3",full_name:"سيد عبدالله"}],
 orders:[{id:"o1",order_name:"طلبية خالد صقر"},{id:"o2",order_name:"طلبية مكتبة النور"}],
 orderStages:[
  {id:"s1",order_id:"o1",stage_id:"g1",stage_name:"سلفنة بينبوكس",output_product_id:"p1"},
  {id:"s2",order_id:"o1",stage_id:"g2",stage_name:"طباعة"},
  {id:"s3",order_id:"o2",stage_id:"g2",stage_name:"طباعة"}
 ],
 shifts:[{id:"sh1",name:"الوردية الصباحية"}],
 shiftLeaders:[{shift_id:"sh1",employee_id:"e3",employee_name:"سيد عبدالله"}]
};

test("spelling and spacing variants match",()=>{
 assert.equal(similarity("سلفنة بين بوكس","سلفنة بينبوكس"),1);
 assert.equal(normalizeOrderLabel("أ/ خالد صقر"),normalizeOrderLabel("طلبية خالد صقر"));
});

test("date parsing, Arabic digits and day-first",()=>{
 assert.equal(parseDate("٢٦/١١/٢٠٢٦"),"2026-11-26");
 assert.equal(parseDate("2026-11-26"),"2026-11-26");
 assert.equal(parseDate("31/02/2026"),null);
});

test("full message becomes draft rows",()=>{
 const r=parseBulkMessage(`26/11/2026
مسؤول الوردية: سيد عبدالله
محمد علي حسن - سلفنة بين بوكس - 1,500 - أ/ خالد صقر
احمد سعيد - طباعة - ٢٠٠٠ - طلبية مكتبة النور
مجهول تماما - طباعة - 10 - طلبية مكتبة النور
احمد سعيد - طباعة - 5`,lookup);
 assert.equal(r.workDate,"2026-11-26");
 assert.equal(r.shiftId,"sh1");
 assert.equal(r.shiftLeaderEmployeeId,"e3");
 assert.equal(r.rows.length,4);
 assert.equal(r.rows[0].employeeId,"e1");assert.equal(r.rows[0].orderStageId,"s1");assert.equal(r.rows[0].quantity,1500);assert.deepEqual(r.rows[0].problems,[]);
 assert.equal(r.rows[1].orderStageId,"s3");assert.equal(r.rows[1].quantity,2000);
 assert.equal(r.rows[2].employeeId,null);assert.ok(r.rows[2].problems.length>0);
 assert.ok(r.rows[3].problems.length>0);
});

test("worker below 80% is not auto matched",()=>{
 const r=parseBulkMessage(`26/11/2026
سيد عبدالله
كريم عادل - طباعة - 10 - طلبية مكتبة النور`,lookup);
 assert.equal(r.rows[0].employeeId,null);
});
