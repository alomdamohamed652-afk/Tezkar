import type { Metadata } from "next";
import "./globals.css";

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
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
