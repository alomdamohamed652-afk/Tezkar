"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";

export type Session = {
  permissions: string[];
  username?: string;
  fullName?: string | null;
  employeeId?: string | null;
  roleCodes?: string[];
  activeRecords?: { custody?: boolean; advance?: boolean };
};

type SessionContextValue = {
  session: Session | null;
  permissions: string[] | null;
  has: (code: string) => boolean;
  ensureSession: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const lastRefreshAt = useRef(0);
  const requestGeneration = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refreshSession = useCallback((force = false): Promise<void> => {
    if (inFlight.current && !force) return inFlight.current;

    const generation = ++requestGeneration.current;
    const request = (async () => {
      try {
        const result = await api<{ data: Session }>("/api/auth/me");
        if (generation === requestGeneration.current) setSession(result.data);
      } catch {
        if (generation === requestGeneration.current) setSession(null);
      } finally {
        if (generation === requestGeneration.current) {
          lastRefreshAt.current = Date.now();
          inFlight.current = null;
          setReady(true);
        }
      }
    })();

    inFlight.current = request;
    return request;
  }, []);

  const ensureSession = useCallback((): Promise<void> => {
    if (!ready) return refreshSession();
    if (Date.now() - lastRefreshAt.current >= 120_000) return refreshSession();
    return Promise.resolve();
  }, [ready, refreshSession]);

  useEffect(() => {
    const handleSessionChanged = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === "logout") {
        requestGeneration.current += 1;
        inFlight.current = null;
        lastRefreshAt.current = Date.now();
        setSession(null);
        setReady(true);
        return;
      }
      setReady(false);
      void refreshSession(true);
    };

    const handleSessionExpired = () => {
      requestGeneration.current += 1;
      inFlight.current = null;
      lastRefreshAt.current = Date.now();
      setSession(null);
      setReady(true);
    };

    const refreshIfStale = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastRefreshAt.current >= 120_000
      ) {
        void refreshSession();
      }
    };

    window.addEventListener("tezkar:session-changed", handleSessionChanged);
    window.addEventListener("tezkar:session-expired", handleSessionExpired);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);

    return () => {
      window.removeEventListener("tezkar:session-changed", handleSessionChanged);
      window.removeEventListener("tezkar:session-expired", handleSessionExpired);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [refreshSession]);

  const permissions = session?.permissions ?? null;
  const has = useCallback(
    (code: string) => permissions?.includes(code) ?? false,
    [permissions],
  );
  const value = useMemo(
    () => ({ session, permissions, has, ensureSession }),
    [session, permissions, has, ensureSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function usePermissions() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("usePermissions must be used inside SessionProvider");

  useEffect(() => {
    void value.ensureSession();
  }, [value.ensureSession]);

  return { permissions: value.permissions, session: value.session, has: value.has };
}
