"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Session = { permissions: string[] };

type NavItem = {
  icon: string;
  label: string;
  href: string;
  permissions: string[];
};

const nav: NavItem[] = [
  { icon: "⌂", label: "الرئيسية", href: "/", permissions: ["dashboard.view"] },
  { icon: "▣", label: "الموظفون", href: "/employees", permissions: ["employees.view"] },
  { icon: "▤", label: "الإنتاج", href: "/production", permissions: ["production.view"] },
  { icon: "▥", label: "المخزن", href: "/warehouse", permissions: ["warehouse.view"] },
  { icon: "↔", label: "السلف", href: "/advances", permissions: ["advances.view", "advances.view_own"] },
  { icon: "₤", label: "القبض", href: "/payments", permissions: ["payment_requests.view", "worker_payments.view"] },
  { icon: "⚙", label: "الإعدادات", href: "/settings", permissions: ["users.view", "payment_methods.manage"] },
  { icon: "▦", label: "التقارير", href: "/reports", permissions: ["reports.view"] }
];

export function usePermissions() {\n  const [permissions, setPermissions] = useState<string[] | null>(null);\n  useEffect(() => {\n    api<{ data: Session }>("/api/auth/me")\n      .then((result) => setPermissions(result.data.permissions))\n      .catch(() => setPermissions([]));\n  }, []);\n  return { permissions, has: (code: string) => permissions?.includes(code) ?? false };\n}\n\nexport function Sidebar({ active }: { active: string }) {
  const [permissions, setPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    api<{ data: Session }>("/api/auth/me")
      .then((result) => setPermissions(result.data.permissions))
      .catch(() => setPermissions([]));
  }, []);

  const visible = nav.filter((item) =>
    permissions !== null && item.permissions.some((permission) => permissions.includes(permission))
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-copy">
          <div className="brand-name">تيزكار</div>
          <div className="brand-sub">إدارة المصنع</div>
        </div>
      </div>
      <div className="nav-title">النظام</div>
      <nav className="nav">
        {visible.map((item) => (
          <a className={"nav-item" + (active === item.href ? " active" : "")} href={item.href} key={item.href}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
