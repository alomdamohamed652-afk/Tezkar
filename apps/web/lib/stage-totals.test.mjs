import { test } from "node:test";
import assert from "node:assert/strict";
import { stageTotals } from "./stage-totals.mjs";

test("sums per stage in stage order and the stages add up to the order total", () => {
  const lines = [
    { stageSequence: 2, stageName: "كبس", amount: 100.1 },
    { stageSequence: 1, stageName: "قص", amount: 50.2 },
    { stageSequence: 2, stageName: "كبس", amount: 200.2 },
    { stageSequence: null, stageName: null, amount: 10 },
    { stageSequence: 1, stageName: "قص", amount: 0.1 },
  ];
  const out = stageTotals(lines);
  assert.deepEqual(out.map((x) => [x.label, x.total]), [["1. قص", 50.3], ["2. كبس", 300.3], ["بدون مرحلة", 10]]);
  assert.equal(Math.round(out.reduce((a, x) => a + x.total, 0) * 100), Math.round(lines.reduce((a, x) => a + x.amount, 0) * 100));
});

test("empty lines give no totals", () => assert.deepEqual(stageTotals([]), []));
