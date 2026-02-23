const FALLBACK_VIEWER_ID_KEY = "tokenscomedyclub.viewerId";

export function getConvexUrl(): string {
  const value = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_CONVEX_URL;
  if (!value) {
    throw new Error("VITE_CONVEX_URL is not set");
  }
  return value.replace(/\/$/, "");
}

export function getAdminPasscodeStorageKey(): string {
  return "tokenscomedyclub.adminPasscode";
}

export function getOrCreateViewerId(key = FALLBACK_VIEWER_ID_KEY): string {
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(key, generated);
  return generated;
}

export function hashToShard(input: string, shards = 64): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % shards;
}
