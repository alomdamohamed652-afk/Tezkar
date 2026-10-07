export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    cache: "no-store"
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.error?.message ?? "حدث خطأ أثناء الاتصال بالنظام";
    throw new Error(message);
  }

  return body as T;
}
