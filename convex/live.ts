import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import { RUNNER_LEASE_MS } from "./constants";
import { toClientRound } from "./rounds";
import {
  getEngineState,
  getOrCreateEngineState,
  getOrCreateRunnerLeaseState,
  normalizeScoreRecord,
} from "./state";
import {
  ensureModelCatalogSeededImpl,
  getEnabledModelIds,
  listModelCatalog,
} from "./models";
import { ensureViewerCountSummary, readTotalViewerCount } from "./viewerCount";

async function buildGameStatePayload(ctx: any) {
  const state = await getEngineState(ctx as any);
  const models = await listModelCatalog(ctx as any);
  const enabledModelIds = getEnabledModelIds(models);
  if (!state) {
    return {
      data: {
        active: null,
        lastCompleted: null,
        scores: {},
        humanScores: {},
        humanVoteTotals: {},
        models,
        enabledModelIds,
        done: false,
        isPaused: false,
        generation: 1,
        completedRounds: 0,
      },
      totalRounds: null,
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
      models,
      enabledModelIds,
      done: state.done,
      isPaused: state.isPaused,
      generation: state.generation,
      completedRounds: state.completedRounds,
    },
    totalRounds: state.runsMode === "finite" ? (state.totalRounds ?? null) : null,
  };
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
      models: v.array(v.any()),
      enabledModelIds: v.array(v.string()),
      done: v.boolean(),
      isPaused: v.boolean(),
      generation: v.number(),
      completedRounds: v.number(),
    }),
    totalRounds: v.union(v.number(), v.null()),
    viewerCount: v.number(),
  }),
  handler: async (ctx) => {
    const snapshot = await buildGameStatePayload(ctx);
    return {
      ...snapshot,
      viewerCount: await readTotalViewerCount(ctx),
    };
  },
});

export const getGameState = query({
  args: {},
  returns: v.object({
    data: v.object({
      active: v.union(v.any(), v.null()),
      lastCompleted: v.union(v.any(), v.null()),
      scores: v.record(v.string(), v.number()),
      humanScores: v.record(v.string(), v.number()),
      humanVoteTotals: v.record(v.string(), v.number()),
      models: v.array(v.any()),
      enabledModelIds: v.array(v.string()),
      done: v.boolean(),
      isPaused: v.boolean(),
      generation: v.number(),
      completedRounds: v.number(),
    }),
    totalRounds: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    return await buildGameStatePayload(ctx);
  },
});

export const getViewerCount = query({
  args: {},
  returns: v.object({ viewerCount: v.number() }),
  handler: async (ctx) => {
    return { viewerCount: await readTotalViewerCount(ctx) };
  },
});

export const getModelCatalog = query({
  args: {},
  returns: v.object({
    models: v.array(v.any()),
    enabledModelIds: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const models = await listModelCatalog(ctx as any);
    return {
      models,
      enabledModelIds: getEnabledModelIds(models),
    };
  },
});

async function ensureStartedImpl(ctx: any) {
  const now = Date.now();
  await ensureViewerCountSummary(ctx as any);
  const catalog = await ensureModelCatalogSeededImpl(ctx as any);
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
  const enabledModelIds = getEnabledModelIds(catalog);
  if (JSON.stringify(state.enabledModelIds ?? []) !== JSON.stringify(enabledModelIds)) {
    patch.enabledModelIds = enabledModelIds;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(state._id, {
      ...patch,
      updatedAt: now,
    });
  }

  if (state.isPaused) {
    const leaseStatePaused = await getOrCreateRunnerLeaseState(ctx as any);
    if (leaseStatePaused.leaseId || leaseStatePaused.leaseUntil) {
      await ctx.db.patch(leaseStatePaused._id, {
        leaseId: undefined,
        leaseUntil: undefined,
        updatedAt: now,
      });
    }
    return;
  }

  if (state.activeRoundId) {
    await ctx.scheduler.runAfter(0, convexInternal.engine.recoverStaleActiveRound, {
      expectedGeneration: state.generation,
    });
  }

  const leaseState = await getOrCreateRunnerLeaseState(ctx as any);
  const hasValidLease = Boolean(leaseState?.leaseId && leaseState.leaseUntil && leaseState.leaseUntil > now);
  if (!hasValidLease) {
    const leaseId = crypto.randomUUID();
    await ctx.db.patch(leaseState._id, {
      leaseId,
      leaseUntil: now + RUNNER_LEASE_MS,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId });
  }

  await ctx.scheduler.runAfter(0, convexInternal.platformViewers.ensurePollingStarted, {});

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

export const getActiveReasoningProgress = query({
  args: {
    roundId: v.optional(v.id("rounds")),
  },
  returns: v.object({
    roundId: v.union(v.id("rounds"), v.null()),
    entries: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    let roundId = args.roundId;
    if (!roundId) {
      const state = await getEngineState(ctx as any);
      roundId = state?.activeRoundId ?? undefined;
    }

    if (!roundId) {
      return {
        roundId: null,
        entries: [],
      };
    }

    const entries = await ctx.db
      .query("liveReasoningProgress")
      .withIndex("by_round_type_answerIndex", (q: any) =>
        q.eq("roundId", roundId).eq("requestType", "prompt").eq("answerIndex", undefined),
      )
      .collect();
    const answerEntries = await ctx.db
      .query("liveReasoningProgress")
      .withIndex("by_round_type", (q: any) => q.eq("roundId", roundId).eq("requestType", "answer"))
      .collect();
    const allEntries = [...entries, ...answerEntries];

    return {
      roundId,
      entries: allEntries.sort((a: any, b: any) => {
        if (a.requestType !== b.requestType) return a.requestType.localeCompare(b.requestType);
        return (a.answerIndex ?? -1) - (b.answerIndex ?? -1);
      }),
    };
  },
});

