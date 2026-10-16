import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "../components/toast-provider";

export const metadata: Metadata = {
  title: "تذكار | إدارة وتشغيل المصنع",
  description: "نظام تذكار لإدارة وتشغيل المصنع والمخازن والإنتاج والحسابات",
  icons: { icon: "https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" }
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"
        />
      </head>
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
