import test from "node:test";
import assert from "node:assert/strict";
import { checkDataTransferRateLimit } from "../src/modules/data-transfer/data-transfer-rate-limit.js";

test("data-transfer rate limit allows the first request and blocks repeats for ten seconds", () => {
  const user = `rate-limit-test-${Date.now()}-${Math.random()}`;
  assert.equal(checkDataTransferRateLimit(user, 1_000_000), 0);
  assert.equal(checkDataTransferRateLimit(user, 1_000_001), 9_999);
  assert.equal(checkDataTransferRateLimit(user, 1_010_000), 0);
});
