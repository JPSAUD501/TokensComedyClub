import {
  ADMIN_PASSCODE_STORAGE_KEY,
  VIEWER_ID_STORAGE_KEY,
  VIEWER_SHARD_COUNT,
} from "../config";

const FALLBACK_VIEWER_ID_KEY = VIEWER_ID_STORAGE_KEY;

export function getConvexUrl(): string {
  const value = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_CONVEX_URL;
  if (!value) {
    throw new Error("VITE_CONVEX_URL is not set");
  }
  return value.replace(/\/$/, "");
}

export function getAdminPasscodeStorageKey(): string {
  return ADMIN_PASSCODE_STORAGE_KEY;
}

export function getOrCreateViewerId(key = FALLBACK_VIEWER_ID_KEY): string {
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(key, generated);
  return generated;
}

export function hashToShard(input: string, shards = VIEWER_SHARD_COUNT): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % shards;
}
