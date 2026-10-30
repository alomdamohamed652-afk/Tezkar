import assert from "node:assert/strict";
import test from "node:test";
import { classifyReverseCodeScan, splitReverseCodeQuantities } from "../src/modules/reverse-coding/reverse-coding.logic.js";

test("splits a full batch evenly into package codes", () => {
  assert.deepEqual(splitReverseCodeQuantities(600, 50), Array(12).fill(50));
});
test("keeps the final remainder in its own code", () => {
  assert.deepEqual(splitReverseCodeQuantities(123, 50), [50, 50, 23]);
});
test("supports a single package without creating extra codes", () => {
  assert.deepEqual(splitReverseCodeQuantities(7, 20), [7]);
});
test("rejects invalid quantities", () => {
  for (const [total, perCode] of [[0,1],[-1,1],[1,0],[1,-1],[1.5,1],[1,2.5],[Number.MAX_SAFE_INTEGER+1,1]]) {
    assert.throws(() => splitReverseCodeQuantities(total, perCode), RangeError);
  }
});
test("classifies repeated unknown values as duplicates within a session", () => {
  assert.equal(classifyReverseCodeScan({duplicateInRequest:false,alreadyScannedInSession:true,codeStatus:null}), "DUPLICATE");
});
test("classifies known, unknown, voided and repeated request values", () => {
  assert.equal(classifyReverseCodeScan({duplicateInRequest:false,alreadyScannedInSession:false,codeStatus:"ACTIVE"}), "FOUND");
  assert.equal(classifyReverseCodeScan({duplicateInRequest:false,alreadyScannedInSession:false,codeStatus:null}), "UNKNOWN");
  assert.equal(classifyReverseCodeScan({duplicateInRequest:false,alreadyScannedInSession:false,codeStatus:"VOIDED"}), "VOIDED");
  assert.equal(classifyReverseCodeScan({duplicateInRequest:true,alreadyScannedInSession:false,codeStatus:"ACTIVE"}), "DUPLICATE");
});
