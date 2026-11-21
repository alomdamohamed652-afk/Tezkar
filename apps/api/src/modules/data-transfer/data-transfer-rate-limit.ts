const WINDOW_MS = 10_000;
const MAX_TRACKED_USERS = 2_000;
const lastAcceptedAt = new Map<string, number>();

export function checkDataTransferRateLimit(userId: string, now = Date.now()): number {
  const previous = lastAcceptedAt.get(userId);
  if (previous !== undefined && now - previous < WINDOW_MS) {
    return Math.max(1, WINDOW_MS - (now - previous));
  }

  if (previous === undefined && lastAcceptedAt.size >= MAX_TRACKED_USERS) {
    for (const [key, timestamp] of lastAcceptedAt) {
      if (now - timestamp >= WINDOW_MS) lastAcceptedAt.delete(key);
    }
    if (lastAcceptedAt.size >= MAX_TRACKED_USERS) return WINDOW_MS;
  }

  lastAcceptedAt.set(userId, now);
  return 0;
}
