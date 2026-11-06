import { API_BASE } from "./api-base";
import { createGetCacheKey, createMemoryGetCache, createPendingGetRegistry, getApiCacheTtl } from "./api-cache.mjs";

export const API_URL = API_BASE;

const getCache = createMemoryGetCache({ maxEntries: 100 });
const pendingGets = createPendingGetRegistry();
let cacheGeneration = 0;

export function clearApiCache(): void {
  cacheGeneration += 1;
  getCache.clear();
  pendingGets.clear();
}

// Call after a successful login/account switch and before logout navigation.
// Broadcast only a lifecycle signal; never put identity or session data in it.
export function notifyApiSessionChanged(): void {
  clearApiCache();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("tezkar:session-changed"));
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel("tezkar-session-lifecycle");
      channel.postMessage({ type: "session-changed" });
      channel.close();
    }
  } catch {
    // Cross-tab notification is best-effort; same-tab cache clearing is immediate.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("tezkar:session-changed", clearApiCache);
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel("tezkar-session-lifecycle");
      channel.onmessage = event => {
        if (event.data?.type === "session-changed") clearApiCache();
      };
    }
  } catch {
    // Browsers without BroadcastChannel still get same-tab lifecycle protection.
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
      const cached = getCache.get(key);
      if (cached !== undefined) return cached as T;
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
      if (response.status === 401) clearApiCache();
      const message = body?.error?.message ?? "حدث خطأ أثناء الاتصال بالنظام";
      throw new ApiError(body?.error?.code ?? "HTTP_ERROR", message, response.status);
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
