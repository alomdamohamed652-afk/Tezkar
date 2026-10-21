import { API_BASE } from "./api-base";

export const API_URL = API_BASE;

// A tiny in-memory cache avoids refetching the same read-only data while navigating
// between pages. Mutations invalidate it immediately; the HTTP cache stays disabled.
const GET_CACHE_TTL_MS = 1_500;
const getCache = new Map<string, { expiresAt: number; value: unknown }>();
const pendingGets = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

function invalidateGetCache() {
  cacheGeneration += 1;
  getCache.clear();
  pendingGets.clear();
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
  const key = path;
  const now = Date.now();

  if (canCache) {
    const cached = getCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value as T;
    if (cached) getCache.delete(key);
    const pending = pendingGets.get(key);
    if (pending) return pending as Promise<T>;
  } else {
    // Any write may affect any page's totals or badges, so prefer correctness.
    invalidateGetCache();
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
      else if (method === "POST") { title = "تمت الإضافة بنجاح"; message = "تم تنفيذ الإضافة المطلوبة."; }
      else if (method === "PATCH" || method === "PUT") { title = "تم التعديل بنجاح"; message = "تم حفظ التعديلات."; }
      else if (method === "DELETE") { title = "تم الحذف بنجاح"; message = "تم حذف السجل المطلوب."; }
      else if (methodName === "post") { message = "تم تنفيذ العملية بنجاح."; }
      window.dispatchEvent(new CustomEvent("tezkar:mutation-success", { detail: { title, message } }));
    }

    if (canCache && requestGeneration === cacheGeneration) {
      getCache.set(key, { value: body, expiresAt: Date.now() + GET_CACHE_TTL_MS });
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
