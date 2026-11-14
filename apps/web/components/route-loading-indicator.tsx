"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const LOGO = "https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png";

export function RouteLoadingIndicator() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const previousPath = useRef(pathname);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      setPending(false);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = null;
    }
  }, [pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      setPending(true);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setPending(false), 12_000);
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, []);

  if (!pending) return null;
  return (
    <div className="tezkar-route-loader" role="status" aria-live="polite" aria-label="جارٍ تحميل الصفحة">
      <div className="tezkar-route-loader-card">
        <img className="tezkar-route-loader-logo" src={LOGO} alt="شعار تذكار" />
        <div className="tezkar-route-loader-title">تذكار</div>
        <div className="tezkar-route-loader-spinner" aria-hidden="true" />
        <div className="tezkar-route-loader-dhikr">اذكر الله</div>
      </div>
    </div>
  );
}
