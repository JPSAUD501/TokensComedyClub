import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import { PLATFORM_VIEWER_POLL_INTERVAL_MS, RUNNER_LEASE_MS } from "./constants";
import { toClientRound } from "./rounds";
import { getEngineState, getOrCreateEngineState, normalizeScoreRecord } from "./state";
import { readTotalViewerCount } from "./viewerCount";

function getPollIntervalMs(): number {
  const raw = Number.parseInt(process.env.PLATFORM_VIEWER_POLL_INTERVAL_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return PLATFORM_VIEWER_POLL_INTERVAL_MS;
  return raw;
}

export const getState = query({
  args: {},
  returns: v.object({
    data: v.object({
      active: v.union(v.any(), v.null()),
      lastCompleted: v.union(v.any(), v.null()),
      scores: v.record(v.string(), v.number()),
      humanScores: v.record(v.string(), v.number()),
      humanVoteTotals: v.record(v.string(), v.number()),
      done: v.boolean(),
      isPaused: v.boolean(),
      generation: v.number(),
    }),
    totalRounds: v.union(v.number(), v.null()),
    viewerCount: v.number(),
  }),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return {
        data: {
          active: null,
          lastCompleted: null,
          scores: {},
          humanScores: {},
          humanVoteTotals: {},
          done: false,
          isPaused: false,
          generation: 1,
        },
        totalRounds: null,
        viewerCount: 0,
      };
    }

    const activeRound = state.activeRoundId ? await ctx.db.get(state.activeRoundId) : null;
    const lastCompletedRound = state.lastCompletedRoundId
      ? await ctx.db.get(state.lastCompletedRoundId)
      : null;

    let activeClient = toClientRound(activeRound);
    if (activeRound?.phase === "voting") {
      const tallies = await ctx.db
        .query("viewerVoteTallies")
        .withIndex("by_round", (q: any) => q.eq("roundId", activeRound._id))
        .collect();
      const viewerVotesA = tallies
        .filter((x: any) => x.side === "A")
        .reduce((sum: number, x: any) => sum + x.count, 0);
      const viewerVotesB = tallies
        .filter((x: any) => x.side === "B")
        .reduce((sum: number, x: any) => sum + x.count, 0);
      if (activeClient) {
        activeClient = {
          ...activeClient,
          viewerVotesA,
          viewerVotesB,
        };
      }
    }

    return {
      data: {
        active: activeClient,
        lastCompleted: toClientRound(lastCompletedRound),
        scores: state.scores,
        humanScores: normalizeScoreRecord(state.humanScores),
        humanVoteTotals: normalizeScoreRecord(state.humanVoteTotals),
        done: state.done,
        isPaused: state.isPaused,
        generation: state.generation,
      },
      totalRounds: state.runsMode === "finite" ? (state.totalRounds ?? null) : null,
      viewerCount: await readTotalViewerCount(ctx),
    };
  },
});

async function ensureStartedImpl(ctx: any) {
  const now = Date.now();
  const state = await getOrCreateEngineState(ctx as any);
  const patch: Record<string, unknown> = {};

  let hasValidActiveRound = false;
  if (state.activeRoundId) {
    const activeRound = await ctx.db.get(state.activeRoundId);
    if (!activeRound) {
      patch.activeRoundId = undefined;
    } else {
      hasValidActiveRound = true;
    }
  }

  let hasValidLastCompletedRound = false;
  if (state.lastCompletedRoundId) {
    const lastCompleted = await ctx.db.get(state.lastCompletedRoundId);
    if (!lastCompleted) {
      patch.lastCompletedRoundId = undefined;
    } else {
      hasValidLastCompletedRound = true;
    }
  }

  if (!hasValidActiveRound && !hasValidLastCompletedRound) {
    const anyDoneRound = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_phase", (q: any) =>
        q.eq("generation", state.generation).eq("phase", "done"),
      )
      .first();
    if (!anyDoneRound && (state.completedRounds !== 0 || state.nextRoundNum !== 1)) {
      patch.completedRounds = 0;
      patch.nextRoundNum = 1;
    }
  }

  if (state.humanScores === undefined || state.humanVoteTotals === undefined) {
    patch.humanScores = normalizeScoreRecord(state.humanScores);
    patch.humanVoteTotals = normalizeScoreRecord(state.humanVoteTotals);
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(state._id, {
      ...patch,
      updatedAt: now,
    });
  }

  const hasValidLease = Boolean(state.runnerLeaseId && state.runnerLeaseUntil && state.runnerLeaseUntil > now);
  if (!hasValidLease) {
    const leaseId = crypto.randomUUID();
    await ctx.db.patch(state._id, {
      runnerLeaseId: leaseId,
      runnerLeaseUntil: now + RUNNER_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId });
  }

  const latestState = await getOrCreateEngineState(ctx as any);
  if (!latestState.platformPollScheduledAt || latestState.platformPollScheduledAt <= now) {
    const interval = getPollIntervalMs();
    await ctx.scheduler.runAfter(0, convexInternal.platformViewers.pollTargets, {});
    await ctx.db.patch(latestState._id, {
      platformPollScheduledAt: now + interval,
      updatedAt: now,
    });
  }
}

export const ensureStarted = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ensureStartedImpl(ctx);
    return null;
  },
});

export const ensureStartedInternal = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ensureStartedImpl(ctx);
    return null;
  },
});

