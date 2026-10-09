import { API_BASE } from "./api-base";

export const API_URL = API_BASE;

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

  return body as T;
}
