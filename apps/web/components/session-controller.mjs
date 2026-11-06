export function createSessionController(loadSession, onChange, now = () => Date.now()) {
  let session = null;
  let ready = false;
  let lastRefreshAt = 0;
  let requestGeneration = 0;
  let inFlight = null;

  const snapshot = () => ({ session, ready });
  const publish = () => onChange(snapshot());

  function invalidate(nextSession, nextReady) {
    requestGeneration += 1;
    inFlight = null;
    session = nextSession;
    ready = nextReady;
    lastRefreshAt = now();
    publish();
  }

  function refresh(force = false) {
    if (inFlight && !force) return inFlight;

    const generation = ++requestGeneration;
    const request = (async () => {
      try {
        const result = await loadSession();
        if (generation === requestGeneration) session = result;
      } catch {
        if (generation === requestGeneration) session = null;
      } finally {
        if (generation === requestGeneration) {
          lastRefreshAt = now();
          inFlight = null;
          ready = true;
          publish();
        }
      }
    })();

    inFlight = request;
    return request;
  }

  function ensureSession() {
    if (!ready) return refresh();
    if (now() - lastRefreshAt >= 120_000) return refresh();
    return Promise.resolve();
  }

  function sessionChanged(action) {
    if (action === "logout") {
      invalidate(null, true);
      return Promise.resolve();
    }
    invalidate(null, false);
    return refresh(true);
  }

  function sessionExpired() {
    invalidate(null, true);
  }

  return {
    ensureSession,
    refresh,
    sessionChanged,
    sessionExpired,
    getSnapshot: snapshot,
  };
}
