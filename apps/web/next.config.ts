import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
];

function resolveProxyTarget(): string {
  const explicit = process.env.API_PROXY_TARGET?.trim().replace(/\\/+$/, "");
  if (explicit) return explicit;
  if (process.env.NODE_ENV !== "production") return "http://localhost:4000";
  throw new Error("API_PROXY_TARGET is required for production builds.");
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async rewrites() {
    const target = resolveProxyTarget();
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  }
};

export default nextConfig;
