import {test} from "node:test";
import assert from "node:assert/strict";
import {amountUnits,centsFromUnits,signedAccountBalance,allocationResidual} from "../src/modules/payments/settlement-money.js";

test("signed account rounding preserves half-cent offsets",()=>{
  assert.equal(signedAccountBalance([
    {earned:"70.0000",paid:"69.9900"},
    {earned:"330.0000",paid:"0"},
    {earned:"196.8750",paid:"196.88"},
    {earned:"153.6750",paid:"153.68"}
  ]),330);
});
test("rounding agrees with PostgreSQL numeric on negative ties",()=>{
  assert.equal(centsFromUnits(amountUnits("-0.0050")),-1n);
  assert.equal(centsFromUnits(amountUnits("0.0050")),1n);
  assert.equal(centsFromUnits(amountUnits("-0.0049")),0n);
});
test("invalid or excessive precision is rejected rather than silently rounded",()=>{
  for(const value of ["NaN","Infinity","0.00001","1e3",""]){
    assert.throws(()=>amountUnits(value));
  }
});
test("settlement link without allocations does not duplicate order-paid gross",()=>{
  assert.equal(allocationResidual({gross:"4928.04",reversed:0,canonical:[],order:["4928.04"],legacy:["4928.04"]}),0);
});
test("canonical lineage takes precedence even when residual remains",()=>{
  assert.equal(allocationResidual({gross:100,reversed:0,canonical:[60],order:[100],legacy:[100]}),40);
});
test("fully reversed canonical allocation must retain its lineage",()=>{
  assert.equal(allocationResidual({gross:100,reversed:100,canonical:[0],order:[100],legacy:[]}),0);
});
test("partial reversals reduce both gross and net allocation only once",()=>{
  assert.equal(allocationResidual({gross:100,reversed:25,canonical:[],order:[50],legacy:[]}),25);
});
