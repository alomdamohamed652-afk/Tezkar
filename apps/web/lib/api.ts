import { API_BASE } from "./api-base";
import { createGetCacheKey, createMemoryGetCache, createPendingGetRegistry, createSessionStorageGetCache, getApiCacheTtl } from "./api-cache.mjs";

export const API_URL = API_BASE;

const getCache = createMemoryGetCache({ maxEntries: 100 });
const deviceCache = createSessionStorageGetCache();
const pendingGets = createPendingGetRegistry();
let cacheGeneration = 0;

export function clearApiCache(): void {
  cacheGeneration += 1;
  getCache.clear();
  deviceCache.clear();
  pendingGets.clear();
}

// Broadcast lifecycle signals only; never include identity or session data.
let sessionChannel: BroadcastChannel | null = null;

function dispatchSessionChanged(action: "login" | "logout" | "changed"): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("tezkar:session-changed", { detail: { action } }));
  }
}

function dispatchSessionExpired(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("tezkar:session-expired"));
  }
}

if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  try {
    sessionChannel = new BroadcastChannel("tezkar-session-lifecycle");
    sessionChannel.onmessage = event => {
      if (event.data?.type === "session-changed") {
        clearApiCache();
        dispatchSessionChanged(event.data.action === "login" || event.data.action === "logout" ? event.data.action : "changed");
      } else if (event.data?.type === "session-expired") {
        clearApiCache();
        dispatchSessionExpired();
      } else if (event.data?.type === "cache-invalidated") {
        clearApiCache();
      }
    };
  } catch {
    // Same-tab lifecycle handling remains available if cross-tab messaging is unavailable.
    sessionChannel = null;
  }
}

export function notifyApiSessionChanged(action: "login" | "logout" | "changed" = "changed"): void {
  clearApiCache();
  dispatchSessionChanged(action);
  try {
    sessionChannel?.postMessage({ type: "session-changed", action });
  } catch {
    // Same-tab notification is immediate; cross-tab notification is best-effort.
  }
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const canCache = method === "GET";
  const cacheTtlMs = canCache ? getApiCacheTtl(path) : 0;
  const key = createGetCacheKey(path, options.headers, cacheGeneration);

  if (canCache) {
    if (cacheTtlMs > 0) {
      const cached = getCache.get(key) ?? deviceCache.get(key);
      if (cached !== undefined) { getCache.set(key, cached, cacheTtlMs); return cached as T; }
    }
    const pending = pendingGets.get(key);
    if (pending) return pending as Promise<T>;
  } else {
    // A write can affect any view; invalidate before issuing it.
    clearApiCache();
  }

  const requestGeneration = cacheGeneration;
  const request = (async () => {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body !== undefined && options.body !== null ? {"Content-Type": "application/json"} : {}),
        ...(options.headers ?? {})
      },
      cache: "no-store"
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      // A 401 means the browser's authentication context is no longer valid.
      // Drop all cached reads immediately so they cannot survive session expiry.
      if (response.status === 401) {
        clearApiCache();
        dispatchSessionExpired();
        try { sessionChannel?.postMessage({ type: "session-expired" }); } catch {
          // Cross-tab expiry notification is best-effort.
        }
      }
      const message = body?.error?.message ?? "حدث خطأ أثناء الاتصال بالنظام";
      throw new ApiError(body?.error?.code ?? "HTTP_ERROR", message, response.status);
    }

    if (!canCache) {
      // Invalidate again after success to cover reads that started while the write was in flight.
      clearApiCache();
      try {
        sessionChannel?.postMessage({ type: "cache-invalidated" });
      } catch {
        // Cross-tab invalidation is best-effort; same-tab invalidation is immediate.
      }
    }

    if (!canCache && typeof window !== "undefined") {
      const cleanPath = path.split("?")[0];
      const methodName = method.toLowerCase();
      let title = "تم تنفيذ العملية بنجاح";
      let message = "تم حفظ التغيير بنجاح.";
      if (cleanPath === "/api/production" && method === "POST") { title = "تم تسجيل الإنتاج"; message = "تمت إضافة سجل الإنتاج بنجاح."; }
      else if (cleanPath.includes("/reverse") || cleanPath.includes("/cancel")) { title = "تم التراجع عن العملية"; message = "تم تسجيل التراجع بنجاح."; }
      else if (cleanPath.includes("/approve")) { title = "تم الاعتماد"; message = "تم اعتماد العملية بنجاح."; }
      else if (cleanPath.includes("/reject")) { title = "تم الرفض"; message = "تم تسجيل الرفض بنجاح."; }
      else if (cleanPath.includes("machine-production") && method === "POST") { title = "تم تسجيل إنتاج الماكينة"; message = "تمت إضافة إنتاج الماكينة بنجاح."; }
      else if (cleanPath === "/api/machines" && method === "POST") { title = "تمت إضافة الماكينة"; message = "تمت إضافة الماكينة إلى قائمة الماكينات."; }
      else if (cleanPath.startsWith("/api/machines/") && method === "DELETE") { title = "تم تعطيل الماكينة"; message = "تم تعطيل الماكينة مع الاحتفاظ بسجلاتها السابقة."; }
      else if (cleanPath.includes("/production") && method === "PATCH") { title = "تم تعديل الإنتاج"; message = "تم حفظ تعديلات سجل الإنتاج."; }
      else if (cleanPath === "/api/orders" && method === "POST") { title = "تمت إضافة الطلبية"; message = "تم حفظ بيانات الطلبية بنجاح."; }
      else if (cleanPath === "/api/employees" && method === "POST") { title = "تمت إضافة الموظف"; message = "تم حفظ بيانات الموظف بنجاح."; }
      else if (cleanPath.includes("/production/scrap") && method === "POST") { title = "تم تسجيل الهالك"; message = "تم حفظ سجل الهالك بنجاح."; }
      else if (cleanPath.includes("/accounting/expenses") && method === "POST") { title = "تم تسجيل المصروف"; message = "تم حفظ المصروف وربطه بالقيد المحدد."; }
      else if (cleanPath.includes("/api/payroll/items/") && cleanPath.includes("/adjustments/") && method === "DELETE") { title = "تم إلغاء بند المرتب"; message = "تم الاحتفاظ بالبند وسبب الإلغاء في سجل المراجعة."; }
      else if (cleanPath === "/api/tasks" && method === "POST") { title = "تمت إضافة المهمة"; message = "تم حفظ المهمة بنجاح."; }
      else if (cleanPath === "/api/custody" && method === "POST") { title = "تم تسجيل حركة العهدة"; message = "تم حفظ حركة العهدة بنجاح."; }
      else if (method === "POST") { title = "تمت الإضافة بنجاح"; message = "تم تنفيذ الإضافة المطلوبة."; }
      else if (method === "PATCH" || method === "PUT") { title = "تم التعديل بنجاح"; message = "تم حفظ التعديلات."; }
      else if (method === "DELETE") { title = "تم الحذف بنجاح"; message = "تم حذف السجل المطلوب."; }
      else if (methodName === "post") { message = "تم تنفيذ العملية بنجاح."; }
      window.dispatchEvent(new CustomEvent("tezkar:mutation-success", { detail: { title, message } }));
    }

    if (canCache && cacheTtlMs > 0 && requestGeneration === cacheGeneration) {
      getCache.set(key, body, cacheTtlMs);
      deviceCache.set(key, body, cacheTtlMs);
    }
    return body as T;
  })();

  if (canCache) pendingGets.set(key, request);
  try {
    return await request;
  } finally {
    if (canCache && pendingGets.get(key) === request) pendingGets.delete(key);
  }
}
