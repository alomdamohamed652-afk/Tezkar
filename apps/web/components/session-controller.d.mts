import type { Session } from "./session-provider";

export type SessionControllerSnapshot = {
  session: Session | null;
  ready: boolean;
};

export function createSessionController(
  loadSession: () => Promise<Session>,
  onChange: (snapshot: SessionControllerSnapshot) => void,
  now?: () => number,
): {
  ensureSession: () => Promise<void>;
  refresh: (force?: boolean) => Promise<void>;
  sessionChanged: (action?: string) => Promise<void>;
  sessionExpired: () => void;
  getSnapshot: () => SessionControllerSnapshot;
};
