import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { DEFAULT_SCORES } from "./constants";

export const DEFAULT_VIEWER_VOTE_WINDOW_ACTIVE_MS = 30_000;
export const DEFAULT_VIEWER_VOTE_WINDOW_IDLE_MS = 120_000;
export const DEFAULT_POST_ROUND_DELAY_ACTIVE_MS = 5_000;
export const DEFAULT_POST_ROUND_DELAY_IDLE_MS = 5_000;

export const MIN_VIEWER_VOTE_WINDOW_MS = 5_000;
export const MAX_VIEWER_VOTE_WINDOW_MS = 10 * 60_000;
export const MIN_POST_ROUND_DELAY_ACTIVE_MS = 0;
export const MAX_POST_ROUND_DELAY_ACTIVE_MS = 2 * 60_000;

export type RuntimeRoundTimingSettings = {
  viewerVoteWindowActiveMs: number;
  viewerVoteWindowIdleMs: number;
  postRoundDelayActiveMs: number;
  postRoundDelayIdleMs: number;
};

function normalizeMs(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number.isFinite(value) ? Math.floor(Number(value)) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function resolveRuntimeRoundTiming(
  state?: {
    viewerVoteWindowActiveMs?: unknown;
    viewerVoteWindowIdleMs?: unknown;
    postRoundDelayActiveMs?: unknown;
    postRoundDelayIdleMs?: unknown;
  } | null,
): RuntimeRoundTimingSettings {
  return {
    viewerVoteWindowActiveMs: normalizeMs(
      state?.viewerVoteWindowActiveMs,
      DEFAULT_VIEWER_VOTE_WINDOW_ACTIVE_MS,
      MIN_VIEWER_VOTE_WINDOW_MS,
      MAX_VIEWER_VOTE_WINDOW_MS,
    ),
    viewerVoteWindowIdleMs: normalizeMs(
      state?.viewerVoteWindowIdleMs,
      DEFAULT_VIEWER_VOTE_WINDOW_IDLE_MS,
      MIN_VIEWER_VOTE_WINDOW_MS,
      MAX_VIEWER_VOTE_WINDOW_MS,
    ),
    postRoundDelayActiveMs: normalizeMs(
      state?.postRoundDelayActiveMs,
      DEFAULT_POST_ROUND_DELAY_ACTIVE_MS,
      MIN_POST_ROUND_DELAY_ACTIVE_MS,
      MAX_POST_ROUND_DELAY_ACTIVE_MS,
    ),
    postRoundDelayIdleMs: normalizeMs(
      state?.postRoundDelayIdleMs,
      DEFAULT_POST_ROUND_DELAY_IDLE_MS,
      MIN_POST_ROUND_DELAY_ACTIVE_MS,
      MAX_POST_ROUND_DELAY_ACTIVE_MS,
    ),
  };
}

type EngineReadCtx = Pick<QueryCtx, "db">;

export function normalizeScoreRecord(
  input?: Record<string, number>,
): Record<string, number> {
  const normalized: Record<string, number> = { ...DEFAULT_SCORES };
  if (!input) return normalized;
  for (const [name, score] of Object.entries(input)) {
    normalized[name] = Number.isFinite(score) ? score : 0;
  }
  return normalized;
}

export async function getEngineState(
  ctx: EngineReadCtx,
): Promise<Doc<"engineState"> | null> {
  return await ctx.db.query("engineState").withIndex("by_key", (q) => q.eq("key", "main")).first();
}

export async function getOrCreateEngineState(
  ctx: MutationCtx,
): Promise<Doc<"engineState">> {
  const existing = await getEngineState(ctx);
  if (existing) {
    const timing = resolveRuntimeRoundTiming(existing);
    const patch: Record<string, unknown> = {};

    if (existing.viewerVoteWindowActiveMs !== timing.viewerVoteWindowActiveMs) {
      patch.viewerVoteWindowActiveMs = timing.viewerVoteWindowActiveMs;
    }
    if (existing.viewerVoteWindowIdleMs !== timing.viewerVoteWindowIdleMs) {
      patch.viewerVoteWindowIdleMs = timing.viewerVoteWindowIdleMs;
    }
    if (existing.postRoundDelayActiveMs !== timing.postRoundDelayActiveMs) {
      patch.postRoundDelayActiveMs = timing.postRoundDelayActiveMs;
    }
    if (existing.postRoundDelayIdleMs !== timing.postRoundDelayIdleMs) {
      patch.postRoundDelayIdleMs = timing.postRoundDelayIdleMs;
    }
    if (typeof existing.projectionBootstrapRunning !== "boolean") {
      patch.projectionBootstrapRunning = false;
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, {
        ...patch,
        updatedAt: Date.now(),
      });
      const updated = await ctx.db.get(existing._id);
      if (!updated) throw new Error("failed to refresh engine state");
      return updated;
    }

    return existing;
  }

  const now = Date.now();
  const id = await ctx.db.insert("engineState", {
    key: "main",
    generation: 1,
    isPaused: false,
    done: false,
    runsMode: "infinite",
    nextRoundNum: 1,
    scores: { ...DEFAULT_SCORES },
    humanScores: { ...DEFAULT_SCORES },
    humanVoteTotals: { ...DEFAULT_SCORES },
    enabledModelIds: [],
    completedRounds: 0,
    updatedAt: now,
    viewerVoteWindowActiveMs: DEFAULT_VIEWER_VOTE_WINDOW_ACTIVE_MS,
    viewerVoteWindowIdleMs: DEFAULT_VIEWER_VOTE_WINDOW_IDLE_MS,
    postRoundDelayActiveMs: DEFAULT_POST_ROUND_DELAY_ACTIVE_MS,
    postRoundDelayIdleMs: DEFAULT_POST_ROUND_DELAY_IDLE_MS,
    projectionBootstrapRunning: false,
  });

  const created = await ctx.db.get(id);
  if (!created) throw new Error("failed to initialize engine state");
  return created;
}

export function isFiniteRuns(state: { runsMode: "finite" | "infinite"; totalRounds?: number }): boolean {
  return state.runsMode === "finite" && typeof state.totalRounds === "number";
}
