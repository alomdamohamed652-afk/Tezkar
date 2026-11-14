export function getApiCacheTtl(path: string): number;
export function createGetCacheKey(path: string, headers?: HeadersInit, generation?: number): string;
export interface MemoryGetCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs: number): void;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}
export function createMemoryGetCache(options?: { maxEntries?: number; now?: () => number }): MemoryGetCache;
export interface PendingGetRegistry {
  get(key: string): Promise<unknown> | undefined;
  set(key: string, promise: Promise<unknown>): void;
  delete(key: string): boolean;
  clear(): void;
}
export function createPendingGetRegistry(): PendingGetRegistry;
