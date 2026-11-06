const REFERENCE_DATA_CACHE_TTL_MS = 30_000;
const MAX_GET_CACHE_ENTRIES = 100;

const REFERENCE_DATA_PATHS = new Set([
  "/api/products",
  "/api/stages",
  "/api/rates",
  "/api/shifts",
  "/api/shifts/rate-groups",
  "/api/machines"
]);

const NEVER_CACHE_PATH_PREFIXES = [
  "/api/auth", "/api/payroll", "/api/accounting", "/api/finance",
  "/api/custody", "/api/advances", "/api/attendance", "/api/warehouse",
  "/api/production", "/api/notifications", "/api/tasks",
  "/api/payment-requests", "/api/orders", "/api/deliveries",
  "/api/employees", "/api/earnings"
];

export function getApiCacheTtl(path) {
  const pathname = path.split("?")[0] ?? path;
  if (NEVER_CACHE_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + "/"))) return 0;
  return REFERENCE_DATA_PATHS.has(pathname) ? REFERENCE_DATA_CACHE_TTL_MS : 0;
}

export function createGetCacheKey(path, headers, generation = 0) {
  const normalizedHeaders = new Headers(headers);
  const headerEntries = Array.from(normalizedHeaders.entries()).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([generation, path, headerEntries]);
}

export function createMemoryGetCache({ maxEntries = MAX_GET_CACHE_ENTRIES, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (ttlMs <= 0) return;
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) { return entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; }
  };
}

export function createPendingGetRegistry() {
  const pending = new Map();
  return {
    get(key) { return pending.get(key); },
    set(key, promise) { pending.set(key, promise); },
    delete(key) { return pending.delete(key); },
    clear() { pending.clear(); }
  };
}
