import test from "node:test";
import assert from "node:assert/strict";
import {
  createGetCacheKey,
  createMemoryGetCache,
  createPendingGetRegistry,
  getApiCacheTtl
} from "./api-cache.mjs";

test("cache miss then cache hit", () => {
  let now = 100;
  const cache = createMemoryGetCache({ now: () => now });
  assert.equal(cache.get("products"), undefined);
  cache.set("products", [{ id: 1 }], 500);
  assert.deepEqual(cache.get("products"), [{ id: 1 }]);
});

test("expired entries are not returned and are removed", () => {
  let now = 100;
  const cache = createMemoryGetCache({ now: () => now });
  cache.set("key", "value", 50);
  now = 150;
  assert.equal(cache.get("key"), undefined);
  assert.equal(cache.size, 0);
});

test("identical in-flight GETs share the same promise", async () => {
  const pending = createPendingGetRegistry();
  let resolveRequest;
  const request = new Promise(resolve => { resolveRequest = resolve; });
  pending.set("same-request", request);
  assert.equal(pending.get("same-request"), request);
  resolveRequest("ok");
  assert.equal(await pending.get("same-request"), "ok");
  pending.delete("same-request");
  assert.equal(pending.get("same-request"), undefined);
});

test("cache invalidation clears entries and pending requests", () => {
  const cache = createMemoryGetCache();
  const pending = createPendingGetRegistry();
  cache.set("a", 1, 1000);
  pending.set("a", Promise.resolve(1));
  cache.clear();
  pending.clear();
  assert.equal(cache.size, 0);
  assert.equal(pending.get("a"), undefined);
});

test("cache is bounded and evicts the least recently inserted entry", () => {
  const cache = createMemoryGetCache({ maxEntries: 2 });
  cache.set("oldest", 1, 1000);
  cache.set("middle", 2, 1000);
  cache.set("newest", 3, 1000);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("oldest"), undefined);
  assert.equal(cache.get("middle"), 2);
  assert.equal(cache.get("newest"), 3);
});

test("cache keys include query strings, request headers, and session generation", () => {
  const first = createGetCacheKey("/api/products?page=1", { "x-view": "a" }, 1);
  assert.notEqual(first, createGetCacheKey("/api/products?page=2", { "x-view": "a" }, 1));
  assert.notEqual(first, createGetCacheKey("/api/products?page=1", { "x-view": "b" }, 1));
  assert.notEqual(first, createGetCacheKey("/api/products?page=1", { "x-view": "a" }, 2));
});

test("sensitive and frequently changing endpoints bypass caching", () => {
  for (const path of [
    "/api/auth/me", "/api/payroll", "/api/accounting/ledger",
    "/api/finance/balances", "/api/custody", "/api/attendance",
    "/api/warehouse", "/api/production",
    "/api/orders", "/api/deliveries", "/api/employees", "/api/earnings"
  ]) assert.equal(getApiCacheTtl(path), 0, path);
});

test("only reviewed reference endpoints receive the 30-second TTL", () => {
  for (const path of [
    "/api/products", "/api/stages",
    "/api/shifts/rate-groups", "/api/machines"
  ]) assert.equal(getApiCacheTtl(path), 30_000, path);
  assert.equal(getApiCacheTtl("/api/products?page=2"), 30_000);
  assert.equal(getApiCacheTtl("/api/rates"), 0);
  assert.equal(getApiCacheTtl("/api/shifts"), 0);
  assert.equal(getApiCacheTtl("/api/tasks"), 0);
  assert.equal(getApiCacheTtl("/api/reports/payroll"), 0);
  assert.equal(getApiCacheTtl("/api/unknown-sensitive-area"), 0);
});

test("only navigation badge counts receive a short 15-second TTL", () => {
  for (const path of ["/api/tasks/pending-count", "/api/payment-requests/pending-count", "/api/notifications/unread-count"]) {
    assert.equal(getApiCacheTtl(path), 15_000, path);
  }
  assert.equal(getApiCacheTtl("/api/notifications"), 0);
  assert.equal(getApiCacheTtl("/api/tasks"), 0);
});
