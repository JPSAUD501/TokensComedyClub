import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import {
  DEFAULT_SCORES,
  ROUND_PURGE_BATCH_SIZE,
  RUNNER_LEASE_MS,
} from "./constants";
import {
  getEngineState,
  getOrCreateEngineState,
  getOrCreateRunnerLeaseState,
  normalizeScoreRecord,
  resolveRuntimeRoundTiming,
} from "./state";
import {
  computeRunStatus,
  ensureModelCatalogSeededImpl,
  getEnabledModelIds,
  listModelCatalog,
} from "./models";
import { toClientRound } from "./rounds";
import { readTotalViewerCount, rebuildViewerCountSummary } from "./viewerCount";

function normalizeViewerTarget(platform: "twitch" | "youtube", target: string): string {
  const trimmed = target.trim();
  return platform === "twitch" ? trimmed.toLowerCase() : trimmed;
}

function isValidTwitchTarget(target: string): boolean {
  return /^[a-z0-9_]{3,25}$/i.test(target);
}

function isValidYouTubeTarget(target: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(target);
}

function normalizeTelegramChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTelegramBotToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function maskTelegramToken(token: string): string | null {
  if (!token) return null;
  if (token.length <= 8) return `${token.slice(0, 1)}***${token.slice(-1)}`;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const projectionTimingValidator = v.object({
  viewerVoteWindowActiveMs: v.number(),
  viewerVoteWindowIdleMs: v.number(),
  postRoundDelayActiveMs: v.number(),
  postRoundDelayIdleMs: v.number(),
});

const telegramConfigValidator = v.object({
  enabled: v.boolean(),
  channelId: v.string(),
  hasBotToken: v.boolean(),
  tokenPreview: v.union(v.string(), v.null()),
  lastPolledAt: v.union(v.number(), v.null()),
  lastError: v.union(v.string(), v.null()),
});

function toTelegramConfigPayload(state: any, pollingState?: any) {
  const token = normalizeTelegramBotToken(state?.telegramBotToken);
  const channelId = normalizeTelegramChannelId(state?.telegramChannelId);
  const lastPolledAtRaw = pollingState?.lastPolledAt;
  const lastErrorRaw = pollingState?.lastError;
  return {
    enabled: state?.telegramEnabled === true,
    channelId,
    hasBotToken: Boolean(token),
    tokenPreview: maskTelegramToken(token),
    lastPolledAt:
      typeof lastPolledAtRaw === "number" && Number.isFinite(lastPolledAtRaw)
        ? lastPolledAtRaw
        : null,
    lastError: typeof lastErrorRaw === "string" && lastErrorRaw.trim()
      ? lastErrorRaw
      : null,
  };
}

export const getSnapshot = internalMutation({
  args: {},
  returns: v.object({
    isPaused: v.boolean(),
    isRunningRound: v.boolean(),
    done: v.boolean(),
    completedInMemory: v.number(),
    persistedRounds: v.number(),
    viewerCount: v.number(),
    activeModelCount: v.number(),
    canRunRounds: v.boolean(),
    runBlockedReason: v.union(
      v.literal("insufficient_active_models"),
      v.literal("insufficient_role_coverage"),
      v.null(),
    ),
    enabledModelIds: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    const models = await ensureModelCatalogSeededImpl(ctx as any);
    const status = computeRunStatus(models);
    const enabledModelIds = getEnabledModelIds(models);

    if (
      state &&
      JSON.stringify(state.enabledModelIds ?? []) !== JSON.stringify(enabledModelIds)
    ) {
      await ctx.db.patch(state._id, {
        enabledModelIds,
        updatedAt: Date.now(),
      });
    }

    if (!state) {
      return {
        isPaused: false,
        isRunningRound: false,
        done: false,
        completedInMemory: 0,
        persistedRounds: 0,
        viewerCount: 0,
        activeModelCount: status.activeModelCount,
        canRunRounds: status.canRunRounds,
        runBlockedReason: status.runBlockedReason,
        enabledModelIds,
      };
    }

    return {
      isPaused: state.isPaused,
      isRunningRound: Boolean(state.activeRoundId),
      done: state.done,
      completedInMemory: state.completedRounds,
      persistedRounds: state.completedRounds,
      viewerCount: await readTotalViewerCount(ctx),
      activeModelCount: status.activeModelCount,
      canRunRounds: status.canRunRounds,
      runBlockedReason: status.runBlockedReason,
      enabledModelIds,
    };
  },
});

export const listViewerTargets = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const rows = await ctx.db.query("viewerTargets").collect();
    return rows.sort((a: any, b: any) => a.platform.localeCompare(b.platform) || a.target.localeCompare(b.target));
  },
});

export const upsertViewerTarget = internalMutation({
  args: {
    id: v.optional(v.id("viewerTargets")),
    platform: v.union(v.literal("twitch"), v.literal("youtube")),
    target: v.string(),
    enabled: v.boolean(),
  },
  returns: v.id("viewerTargets"),
  handler: async (ctx, args) => {
    const target = normalizeViewerTarget(args.platform, args.target);
    if (!target) throw new Error("Target vazio");

    if (args.platform === "twitch" && !isValidTwitchTarget(target)) {
      throw new Error("Target Twitch invalido. Use user_login (3-25, letras/numeros/_).");
    }
    if (args.platform === "youtube" && !isValidYouTubeTarget(target)) {
      throw new Error("Target YouTube invalido. Use videoId com 11 caracteres.");
    }

    const duplicate = await ctx.db
      .query("viewerTargets")
      .withIndex("by_platform_and_target", (q: any) => q.eq("platform", args.platform).eq("target", target))
      .first();

    if (duplicate && duplicate._id !== args.id) {
      throw new Error("Target ja cadastrado para esta plataforma.");
    }

    const now = Date.now();
    let id = args.id;
    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing) throw new Error("Target nao encontrado.");
      const changed = existing.platform !== args.platform || existing.target !== target;
      await ctx.db.patch(id, {
        platform: args.platform,
        target,
        enabled: args.enabled,
        viewerCount: changed ? 0 : existing.viewerCount,
        isLive: changed ? false : existing.isLive,
        lastError: undefined,
        updatedAt: now,
      });
    } else {
      id = await ctx.db.insert("viewerTargets", {
        platform: args.platform,
        target,
        enabled: args.enabled,
        viewerCount: 0,
        isLive: false,
        updatedAt: now,
        createdAt: now,
      });
    }

    await ctx.scheduler.runAfter(0, convexInternal.platformViewers.ensurePollingStarted, {});
    await rebuildViewerCountSummary(ctx as any);

    return id!;
  },
});

export const deleteViewerTarget = internalMutation({
  args: {
    id: v.id("viewerTargets"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row) {
      await ctx.db.delete(args.id);
    }
    await rebuildViewerCountSummary(ctx as any);
    return null;
  },
});

export const pause = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const leaseState = await getOrCreateRunnerLeaseState(ctx as any);
    const now = Date.now();
    await ctx.db.patch(state._id, {
      isPaused: true,
      updatedAt: now,
    });

    await ctx.db.patch(leaseState._id, {
      leaseId: undefined,
      leaseUntil: undefined,
      updatedAt: now,
    });

    const platformPollingState = await ctx.db
      .query("platformPollingState")
      .withIndex("by_key", (q: any) => q.eq("key", "main"))
      .first();
    if (platformPollingState) {
      await ctx.db.patch(platformPollingState._id, {
        scheduledAt: undefined,
        updatedAt: now,
      });
    }

    const viewerReaperState = await ctx.db
      .query("viewerReaperState")
      .withIndex("by_key", (q: any) => q.eq("key", "main"))
      .first();
    if (viewerReaperState) {
      await ctx.db.patch(viewerReaperState._id, {
        scheduledAt: undefined,
        updatedAt: now,
      });
    }

    const presences = await ctx.db.query("viewerPresence").collect();
    for (const row of presences) {
      await ctx.db.delete(row._id);
    }

    const shards = await ctx.db.query("viewerCountShards").collect();
    for (const shard of shards) {
      if (shard.count === 0) continue;
      await ctx.db.patch(shard._id, { count: 0, updatedAt: now });
    }

    await rebuildViewerCountSummary(ctx as any);
    return null;
  },
});

export const resume = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const leaseState = await getOrCreateRunnerLeaseState(ctx as any);
    await ctx.db.patch(state._id, {
      isPaused: false,
      done: false,
      updatedAt: Date.now(),
    });

    const now = Date.now();
    const validLease = Boolean(leaseState.leaseId && leaseState.leaseUntil && leaseState.leaseUntil > now);
    if (!validLease) {
      const leaseId = crypto.randomUUID();
      await ctx.db.patch(leaseState._id, {
        leaseId,
        leaseUntil: now + RUNNER_LEASE_MS,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId });
    }

    await ctx.scheduler.runAfter(0, convexInternal.platformViewers.ensurePollingStarted, {});

    return null;
  },
});

export const reset = internalMutation({
  args: {},
  returns: v.object({ generation: v.number() }),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const models = await listModelCatalog(ctx as any);
    const oldGeneration = state.generation;
    const nextGeneration = oldGeneration + 1;

    await ctx.db.patch(state._id, {
      generation: nextGeneration,
      isPaused: true,
      done: false,
      nextRoundNum: 1,
      activeRoundId: undefined,
      lastCompletedRoundId: undefined,
      completedRounds: 0,
      scores: { ...DEFAULT_SCORES },
      humanScores: { ...DEFAULT_SCORES },
      humanVoteTotals: { ...DEFAULT_SCORES },
      enabledModelIds: getEnabledModelIds(models),
      projectionBootstrapRunning: false,
      projectionBootstrapRunId: undefined,
      projectionBootstrapStartedAt: undefined,
      projectionBootstrapFinishedAt: undefined,
      projectionBootstrapError: undefined,
      updatedAt: Date.now(),
    });
    const leaseState = await getOrCreateRunnerLeaseState(ctx as any);
    await ctx.db.patch(leaseState._id, {
      leaseId: undefined,
      leaseUntil: undefined,
      updatedAt: Date.now(),
    });

    const resetNow = Date.now();
    const platformPollingState = await ctx.db
      .query("platformPollingState")
      .withIndex("by_key", (q: any) => q.eq("key", "main"))
      .first();
    if (platformPollingState) {
      await ctx.db.patch(platformPollingState._id, {
        scheduledAt: undefined,
        updatedAt: resetNow,
      });
    }

    const viewerReaperState = await ctx.db
      .query("viewerReaperState")
      .withIndex("by_key", (q: any) => q.eq("key", "main"))
      .first();
    if (viewerReaperState) {
      await ctx.db.patch(viewerReaperState._id, {
        scheduledAt: undefined,
        updatedAt: resetNow,
      });
    }

    await ctx.scheduler.runAfter(0, convexInternal.platformViewers.ensurePollingStarted, {});

    const presences = await ctx.db.query("viewerPresence").collect();
    for (const row of presences) {
      await ctx.db.delete(row._id);
    }

    const shards = await ctx.db.query("viewerCountShards").collect();
    for (const shard of shards) {
      await ctx.db.patch(shard._id, { count: 0, updatedAt: Date.now() });
    }
    await rebuildViewerCountSummary(ctx as any);

    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationRoundBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationViewerVoteBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTalliesBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTelegramRoundPollBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationUsageEventBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });
    await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationReasoningProgressBatch, {
      generation: oldGeneration,
      cursor: undefined,
      numItems: ROUND_PURGE_BATCH_SIZE,
    });

    await ctx.runMutation(convexInternal.telegram.resetPollingState, {});
    await ctx.runMutation(convexInternal.telegram.ensurePollingStarted, {});

    return { generation: nextGeneration };
  },
});

export const backfillEngineStateHumanScores = internalMutation({
  args: {},
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx) => {
    const state = await getOrCreateEngineState(ctx as any);
    const hasHumanScores = state.humanScores !== undefined;
    const hasHumanVoteTotals = state.humanVoteTotals !== undefined;
    if (hasHumanScores && hasHumanVoteTotals) {
      return { updated: false };
    }

    await ctx.db.patch(state._id, {
      humanScores: normalizeScoreRecord(state.humanScores),
      humanVoteTotals: normalizeScoreRecord(state.humanVoteTotals),
      updatedAt: Date.now(),
    });

    return { updated: true };
  },
});

export const updateProjectionTimingSettings = internalMutation({
  args: {
    viewerVoteWindowActiveMs: v.number(),
    viewerVoteWindowIdleMs: v.number(),
    postRoundDelayActiveMs: v.number(),
  },
  returns: projectionTimingValidator,
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    const timing = resolveRuntimeRoundTiming({
      ...state,
      ...args,
    });

    await ctx.db.patch(state._id, {
      viewerVoteWindowActiveMs: timing.viewerVoteWindowActiveMs,
      viewerVoteWindowIdleMs: timing.viewerVoteWindowIdleMs,
      postRoundDelayActiveMs: timing.postRoundDelayActiveMs,
      postRoundDelayIdleMs: timing.postRoundDelayIdleMs,
      updatedAt: Date.now(),
    });

    return timing;
  },
});

export const getTelegramConfig = internalQuery({
  args: {},
  returns: telegramConfigValidator,
  handler: async (ctx) => {
    const [state, pollingState] = await Promise.all([
      getEngineState(ctx as any),
      ctx.db
        .query("telegramPollingState")
        .withIndex("by_key", (q: any) => q.eq("key", "main"))
        .first(),
    ]);
    return toTelegramConfigPayload(state, pollingState);
  },
});

export const updateTelegramConfig = internalMutation({
  args: {
    enabled: v.boolean(),
    channelId: v.string(),
    botToken: v.optional(v.string()),
  },
  returns: telegramConfigValidator,
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    const now = Date.now();

    const nextEnabled = args.enabled === true;
    const nextChannelId = normalizeTelegramChannelId(args.channelId);
    const incomingToken = typeof args.botToken === "string" ? normalizeTelegramBotToken(args.botToken) : undefined;
    const existingToken = normalizeTelegramBotToken(state.telegramBotToken);
    const resolvedToken = incomingToken !== undefined ? incomingToken : existingToken;

    if (nextEnabled && !nextChannelId) {
      throw new Error("Channel ID do Telegram e obrigatorio quando integrado.");
    }
    if (nextEnabled && !resolvedToken) {
      throw new Error("Bot token do Telegram e obrigatorio quando integrado.");
    }

    const patch: Record<string, unknown> = {
      telegramEnabled: nextEnabled,
      telegramChannelId: nextChannelId,
      updatedAt: now,
    };
    if (incomingToken !== undefined) {
      patch.telegramBotToken = incomingToken || undefined;
    }

    await ctx.db.patch(state._id, patch);
    if (incomingToken !== undefined || !nextEnabled) {
      await ctx.runMutation(convexInternal.telegram.resetPollingState, {});
    }
    const updated = await getOrCreateEngineState(ctx as any);

    if (nextEnabled) {
      await ctx.runMutation(convexInternal.telegram.ensurePollingStarted, {});
    }

    const pollingState = await ctx.db
      .query("telegramPollingState")
      .withIndex("by_key", (q: any) => q.eq("key", "main"))
      .first();
    return toTelegramConfigPayload(updated, pollingState);
  },
});

export const getExportData = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return {
        exportedAt: new Date().toISOString(),
        state: null,
        models: await ctx.db.query("models").collect(),
        viewerTargets: await ctx.db.query("viewerTargets").collect(),
        telegramRoundPolls: [],
        rounds: [],
      };
    }

    const rounds = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", state.generation))
      .collect();

    return {
      exportedAt: new Date().toISOString(),
      state,
      models: await ctx.db.query("models").collect(),
      viewerTargets: await ctx.db.query("viewerTargets").collect(),
      telegramRoundPolls: await ctx.db
        .query("telegramRoundPolls")
        .withIndex("by_generation", (q: any) => q.eq("generation", state.generation))
        .collect(),
      rounds: rounds.map((round: any) => toClientRound(round)).filter(Boolean),
    };
  },
});

export const purgeGenerationRoundBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationRoundBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationViewerVoteBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("viewerVotes")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationViewerVoteBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationTalliesBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("viewerVoteTallies")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTalliesBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationTelegramRoundPollBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("telegramRoundPolls")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationTelegramRoundPollBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationUsageEventBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("llmUsageEvents")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationUsageEventBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

export const purgeGenerationReasoningProgressBatch = internalMutation({
  args: {
    generation: v.number(),
    cursor: v.optional(v.string()),
    numItems: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("liveReasoningProgress")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, convexInternal.admin.purgeGenerationReasoningProgressBatch, {
        generation: args.generation,
        cursor: result.continueCursor,
        numItems: args.numItems,
      });
    }

    return null;
  },
});

