export const VIEWER_SHARD_COUNT = 64;
export const VIEWER_SESSION_TTL_MS = 30_000;
export const VIEWER_REAPER_INTERVAL_MS = 5_000;
export const VIEWER_REAPER_BATCH = 500;
export const VIEWER_VOTE_WINDOW_ACTIVE_MS = 30_000;
export const VIEWER_VOTE_WINDOW_IDLE_MS = 120_000;
export const POST_ROUND_DELAY_MS = 5_000;
export const SKIPPED_ROUND_DELAY_MS = 10_000;
export const RUNNER_LEASE_MS = 60_000;
export const RUNNER_LEASE_HEARTBEAT_MS = 20_000;
export const PLATFORM_VIEWER_POLL_INTERVAL_MS = 10_000;
export const MODEL_CALL_TIMEOUT_MS = 60_000;
export const MODEL_ATTEMPTS = 3;
export const MODEL_RETRY_BACKOFF_MS = [1_000, 2_000] as const;
export const MODEL_TIMEOUT_GRACE_MS = 15_000;
export const MODEL_PHASE_DEADLINE_MS =
  MODEL_ATTEMPTS * MODEL_CALL_TIMEOUT_MS +
  MODEL_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);

export const DEFAULT_SCORES: Record<string, number> = {};

export function hashToShard(input: string, shards = VIEWER_SHARD_COUNT): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % shards;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = tmp as T;
  }
  return copy;
}
