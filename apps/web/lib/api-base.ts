/**
 * Base URL used by the browser for API calls.
 * Empty by default: the browser calls /api/* on the web host and Next.js rewrites it to the API.
 */
export function resolveApiBase(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return value === "" ? "" : value.replace(/\/+$/, "");
}

export const API_BASE = resolveApiBase(process.env.NEXT_PUBLIC_API_URL);
