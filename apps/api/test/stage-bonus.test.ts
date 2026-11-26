import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {resolveAutoStageBonus,AUTO_BONUS_REASON_PREFIX} from "../src/modules/production/stage-bonus.js";

// Fake client that applies the same rule as the SQL: highest target <= quantity.
function fake(tiers:{t:number;b:number}[]){
 return {query:async(_sql:string,params:unknown[])=>{
  const qty=Number(params[1]);
  const hit=tiers.filter(x=>x.t<=qty).sort((a,b)=>b.t-a.t)[0];
  return hit?{rowCount:1,rows:[{target_qty:String(hit.t),bonus_amount:String(hit.b)}]}:{rowCount:0,rows:[]};
 }} as unknown as PoolClient;
}

test("highest reached tier only, never both",async()=>{
 const c=fake([{t:1500,b:50},{t:2000,b:100}]);
 assert.equal(await resolveAutoStageBonus(c,"s",1000),null);
 assert.deepEqual(await resolveAutoStageBonus(c,"s",1500),{amount:50,reason:AUTO_BONUS_REASON_PREFIX+"1500"});
 assert.deepEqual(await resolveAutoStageBonus(c,"s",1999),{amount:50,reason:AUTO_BONUS_REASON_PREFIX+"1500"});
 assert.deepEqual(await resolveAutoStageBonus(c,"s",2500),{amount:100,reason:AUTO_BONUS_REASON_PREFIX+"2000"});
});

test("no stage or bad quantity gives no bonus",async()=>{
 const c=fake([{t:1,b:5}]);
 assert.equal(await resolveAutoStageBonus(c,null,10),null);
 assert.equal(await resolveAutoStageBonus(c,"s",0),null);
 assert.equal(await resolveAutoStageBonus(c,"s",Number.NaN),null);
});
