"use client";

import { createContext, useCallback, useContext, useRef, useState, useEffect, type ReactNode } from "react";

type ToastKind = "success" | "error" | "warning" | "info";
type ToastItem = { id: number; kind: ToastKind; title: string; message?: string };
type ToastApi = {
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
};
const ToastContext = createContext<ToastApi | null>(null);
const defaults: Record<ToastKind, string> = {
  success: "تمت العملية بنجاح",
  error: "حصل خطأ",
  warning: "تنبيه",
  info: "معلومة"
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems(current => current.filter(item => item.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string, title?: string) => {
    const normalized = message.trim() || defaults[kind];
    const id = ++nextId.current;
    setItems(current => {
      if (current.some(item => item.kind === kind && item.message === normalized && item.title === (title || defaults[kind]))) return current;
      return [...current.slice(-3), { id, kind, title: title || defaults[kind], message: normalized }];
    });
    const timer = setTimeout(() => dismiss(id), kind === "error" || kind === "warning" ? 6500 : 4200);
    timers.current.set(id, timer);
  }, [dismiss]);

  useEffect(() => {
    const onMutation = (event: Event) => {
      const detail = (event as CustomEvent<{title?: string; message?: string}>).detail;
      push("success", detail?.message || "تم حفظ التغيير بنجاح.", detail?.title || "تمت العملية بنجاح");
    };
    window.addEventListener("tezkar:mutation-success", onMutation);
    return () => window.removeEventListener("tezkar:mutation-success", onMutation);
  }, [push]);

  const api: ToastApi = {
    success: (message, title) => push("success", message, title),
    error: (message, title) => push("error", message, title),
    warning: (message, title) => push("warning", message, title),
    info: (message, title) => push("info", message, title)
  };

  return <ToastContext.Provider value={api}>
    {children}
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions text">
      {items.map(item => <section key={item.id} className={"toast-item toast-" + item.kind} role={item.kind === "error" ? "alert" : "status"}>
        <span className="toast-icon" aria-hidden="true">{item.kind === "success" ? "✓" : item.kind === "error" ? "!" : item.kind === "warning" ? "⚠" : "i"}</span>
        <div className="toast-copy"><strong>{item.title}</strong><p>{item.message}</p></div>
        <button type="button" className="toast-close" aria-label="إغلاق الإشعار" onClick={() => dismiss(item.id)}>×</button>
        <span className="toast-progress" />
      </section>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used within ToastProvider");
  return value;
}
