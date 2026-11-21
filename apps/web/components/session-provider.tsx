"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { createSessionController, type SessionControllerSnapshot } from "./session-controller.mjs";

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
  const [snapshot, setSnapshot] = useState<SessionControllerSnapshot>({
    session: null,
    ready: false,
  });
  const controllerRef = useRef<ReturnType<typeof createSessionController> | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createSessionController(
      async () => {
        const result = await api<{ data: Session }>("/api/auth/me");
        return result.data;
      },
      setSnapshot,
    );
  }
  const controller = controllerRef.current;

  useEffect(() => {
    const handleSessionChanged = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      void controller.sessionChanged(action);
    };
    const handleSessionExpired = () => controller.sessionExpired();
    const refreshIfStale = () => {
      if (
        controller.getSnapshot().ready &&
        controller.getSnapshot().session &&
        document.visibilityState === "visible"
      ) {
        void controller.ensureSession();
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
  }, [controller]);

  const permissions = snapshot.session?.permissions ?? null;
  const has = useMemo(
    () => (code: string) => permissions?.includes(code) ?? false,
    [permissions],
  );
  const value = useMemo(
    () => ({
      session: snapshot.session,
      permissions,
      has,
      ensureSession: controller.ensureSession,
    }),
    [snapshot.session, permissions, has, controller],
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
