import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }
];

function resolveProxyTarget(): string {
  const explicit = process.env.API_PROXY_TARGET?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  if (process.env.NODE_ENV !== "production") return "http://localhost:4000";
  throw new Error("API_PROXY_TARGET is required for production builds.");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Shared invoices are private: never cached by browsers or proxies, never indexed, and the token never leaks through the Referer header.
      { source: "/r/:token*", headers: [
        { key: "Cache-Control", value: "no-store, private, max-age=0" },
        { key: "Pragma", value: "no-cache" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }
      ] }
    ];
  },
  async rewrites() {
    const target = resolveProxyTarget();
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  }
};

export default nextConfig;
