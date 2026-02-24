import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { getEngineState } from "./state";

export const USAGE_WINDOW_SIZE = 50;

const requestTypeValidator = v.union(
  v.literal("prompt"),
  v.literal("answer"),
  v.literal("vote"),
);

const progressRequestTypeValidator = v.union(v.literal("prompt"), v.literal("answer"));

const durationSourceValidator = v.union(
  v.literal("openrouter_latency"),
  v.literal("openrouter_generation_time"),
  v.literal("local"),
);

function safeEpoch(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 1;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function safeNumber(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function buildHourlyCostSummary(events: any[]) {
  if (events.length === 0) {
    return {
      sampleSize: 0,
      totalCostUsd: 0,
      windowHours: null as number | null,
      avgCostPerHourUsd: null as number | null,
    };
  }

  const totalCostUsd = sum(events.map((event) => safeNumber(event.costUsd)));
  const startCandidates = events.map((event) => {
    const startedAt = safeNumber(event.startedAt);
    if (startedAt > 0) return startedAt;
    const finishedAt = safeNumber(event.finishedAt);
    const durationMs = Math.max(0, safeNumber(event.durationMsFinal));
    return finishedAt > 0 ? finishedAt - durationMs : 0;
  });
  const finishCandidates = events.map((event) => {
    const finishedAt = safeNumber(event.finishedAt);
    if (finishedAt > 0) return finishedAt;
    const startedAt = safeNumber(event.startedAt);
    const durationMs = Math.max(0, safeNumber(event.durationMsFinal));
    return startedAt > 0 ? startedAt + durationMs : 0;
  });

  const minStartedAt = Math.min(...startCandidates.filter((value) => value > 0));
  const maxFinishedAt = Math.max(...finishCandidates.filter((value) => value > 0));
  let spanMs =
    Number.isFinite(minStartedAt) &&
    Number.isFinite(maxFinishedAt) &&
    minStartedAt > 0 &&
    maxFinishedAt > 0
      ? maxFinishedAt - minStartedAt
      : 0;

  if (spanMs <= 0) {
    spanMs = sum(events.map((event) => Math.max(0, safeNumber(event.durationMsFinal))));
  }

  if (spanMs <= 0) {
    return {
      sampleSize: events.length,
      totalCostUsd,
      windowHours: null as number | null,
      avgCostPerHourUsd: null as number | null,
    };
  }

  const windowHours = spanMs / (1000 * 60 * 60);
  return {
    sampleSize: events.length,
    totalCostUsd,
    windowHours,
    avgCostPerHourUsd: windowHours > 0 ? totalCostUsd / windowHours : null,
  };
}

function usageSummary(events: any[], denominator: number) {
  const avgCostUsd = average(events.map((event) => event.costUsd));
  const avgDurationMs = average(events.map((event) => event.durationMsFinal));
  const avgReasoningTokens = average(events.map((event) => event.reasoningTokens));
  const avgTotalTokens = average(events.map((event) => event.totalTokens));
  return {
    sampleSize: events.length,
    denominator,
    avgCostUsd,
    avgDurationMs,
    avgReasoningTokens,
    avgTotalTokens,
  };
}

function pushDenominator(denominators: Record<string, Record<string, number>>, modelId: string, type: string) {
  if (!denominators[modelId]) {
    denominators[modelId] = { prompt: 0, answer: 0, vote: 0 };
  }
  denominators[modelId]![type] = (denominators[modelId]![type] ?? 0) + 1;
}

async function upsertProgressImpl(
  ctx: any,
  args: {
    generation: number;
    roundId: any;
    requestType: "prompt" | "answer";
    answerIndex?: number;
    modelId: string;
    estimatedReasoningTokens: number;
    finalized?: boolean;
  },
) {
  const rows = await ctx.db
    .query("liveReasoningProgress")
    .withIndex("by_round_type", (q: any) => q.eq("roundId", args.roundId).eq("requestType", args.requestType))
    .collect();

  const existing = rows.find((row: any) =>
    args.requestType === "prompt"
      ? row.answerIndex === undefined
      : row.answerIndex === args.answerIndex,
  );

  const patch = {
    generation: args.generation,
    roundId: args.roundId,
    requestType: args.requestType,
    answerIndex: args.answerIndex,
    modelId: args.modelId,
    estimatedReasoningTokens: Math.max(0, Math.floor(args.estimatedReasoningTokens)),
    updatedAt: Date.now(),
    finalized: Boolean(args.finalized),
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return;
  }

  await ctx.db.insert("liveReasoningProgress", patch);
}

export const upsertLiveReasoningProgress = internalMutation({
  args: {
    generation: v.number(),
    roundId: v.id("rounds"),
    requestType: progressRequestTypeValidator,
    answerIndex: v.optional(v.number()),
    modelId: v.string(),
    estimatedReasoningTokens: v.number(),
    finalized: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertProgressImpl(ctx, args);
    return null;
  },
});

export const finalizeLiveReasoningProgress = internalMutation({
  args: {
    generation: v.number(),
    roundId: v.id("rounds"),
    requestType: progressRequestTypeValidator,
    answerIndex: v.optional(v.number()),
    modelId: v.string(),
    estimatedReasoningTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertProgressImpl(ctx, {
      ...args,
      finalized: true,
    });
    return null;
  },
});

export const recordLlmUsageEvent = internalMutation({
  args: {
    generation: v.number(),
    roundId: v.id("rounds"),
    roundNum: v.number(),
    requestType: requestTypeValidator,
    answerIndex: v.optional(v.number()),
    voteIndex: v.optional(v.number()),
    modelId: v.string(),
    modelName: v.string(),
    modelMetricsEpoch: v.number(),
    generationId: v.string(),
    costUsd: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    reasoningTokens: v.number(),
    durationMsLocal: v.number(),
    durationMsFinal: v.number(),
    durationSource: durationSourceValidator,
    startedAt: v.number(),
    finishedAt: v.number(),
  },
  returns: v.id("llmUsageEvents"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("llmUsageEvents", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const getAdminModelUsageAverages = internalQuery({
  args: {
    windowSize: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const windowSize = Number.isFinite(args.windowSize) && (args.windowSize ?? 0) > 0
      ? Math.floor(args.windowSize as number)
      : USAGE_WINDOW_SIZE;

    if (!state) {
      return {
        usageByModel: {},
        usageHourlyByModel: {},
        usageWindowSize: windowSize,
        activeModelsAvgCostPerHourUsd: null,
        activeModelsHourlyShareByModel: {},
      };
    }

    const generation = state.generation;
    const models = await ctx.db.query("models").collect();
    const modelEpochById = new Map<string, number>();
    for (const model of models) {
      modelEpochById.set(model.modelId, safeEpoch(model.metricsEpoch));
    }

    const denominators: Record<string, Record<string, number>> = {};
    const rounds = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", generation))
      .collect();

    for (const round of rounds) {
      const promptModelId = round.promptTask?.model?.id;
      if (
        promptModelId &&
        round.promptTask?.finishedAt &&
        !round.promptTask?.error &&
        safeEpoch(round.promptTask?.model?.metricsEpoch) === modelEpochById.get(promptModelId)
      ) {
        pushDenominator(denominators, promptModelId, "prompt");
      }

      for (const answerTask of round.answerTasks ?? []) {
        const answerModelId = answerTask?.model?.id;
        if (
          answerModelId &&
          answerTask?.finishedAt &&
          !answerTask?.error &&
          safeEpoch(answerTask?.model?.metricsEpoch) === modelEpochById.get(answerModelId)
        ) {
          pushDenominator(denominators, answerModelId, "answer");
        }
      }

      for (const vote of round.votes ?? []) {
        const voteModelId = vote?.voter?.id;
        if (
          voteModelId &&
          vote?.finishedAt &&
          !vote?.error &&
          safeEpoch(vote?.voter?.metricsEpoch) === modelEpochById.get(voteModelId)
        ) {
          pushDenominator(denominators, voteModelId, "vote");
        }
      }
    }

    const usageByModel: Record<string, any> = {};
    const usageHourlyByModel: Record<string, any> = {};
    for (const model of models) {
      const modelId = model.modelId;
      const modelEpoch = safeEpoch(model.metricsEpoch);
      const modelDenominator = denominators[modelId] ?? { prompt: 0, answer: 0, vote: 0 };
      const promptDenominator = modelDenominator.prompt ?? 0;
      const answerDenominator = modelDenominator.answer ?? 0;
      const voteDenominator = modelDenominator.vote ?? 0;

      const [promptEvents, answerEvents, voteEvents] = await Promise.all([
        ctx.db
          .query("llmUsageEvents")
          .withIndex("by_generation_model_epoch_type_finishedAt", (q: any) =>
            q
              .eq("generation", generation)
              .eq("modelId", modelId)
              .eq("modelMetricsEpoch", modelEpoch)
              .eq("requestType", "prompt"),
          )
          .order("desc")
          .take(windowSize),
        ctx.db
          .query("llmUsageEvents")
          .withIndex("by_generation_model_epoch_type_finishedAt", (q: any) =>
            q
              .eq("generation", generation)
              .eq("modelId", modelId)
              .eq("modelMetricsEpoch", modelEpoch)
              .eq("requestType", "answer"),
          )
          .order("desc")
          .take(windowSize),
        ctx.db
          .query("llmUsageEvents")
          .withIndex("by_generation_model_epoch_type_finishedAt", (q: any) =>
            q
              .eq("generation", generation)
              .eq("modelId", modelId)
              .eq("modelMetricsEpoch", modelEpoch)
              .eq("requestType", "vote"),
          )
          .order("desc")
          .take(windowSize),
      ]);

      const allEvents = [...promptEvents, ...answerEvents, ...voteEvents];

      usageByModel[modelId] = {
        prompt: usageSummary(promptEvents, promptDenominator),
        answer: usageSummary(answerEvents, answerDenominator),
        vote: usageSummary(voteEvents, voteDenominator),
      };
      usageHourlyByModel[modelId] = buildHourlyCostSummary(allEvents);
    }

    const activeModelIds = models
      .filter((model) => model.enabled && !model.archivedAt)
      .map((model) => model.modelId);
    const activeModelsAvgCostPerHourUsd = sum(
      activeModelIds.map((modelId) => safeNumber(usageHourlyByModel[modelId]?.avgCostPerHourUsd)),
    );
    const activeModelsHourlyShareByModel: Record<string, number> = {};
    for (const modelId of activeModelIds) {
      const modelHourly = safeNumber(usageHourlyByModel[modelId]?.avgCostPerHourUsd);
      activeModelsHourlyShareByModel[modelId] =
        activeModelsAvgCostPerHourUsd > 0 ? (modelHourly / activeModelsAvgCostPerHourUsd) * 100 : 0;
    }

    return {
      usageByModel,
      usageHourlyByModel,
      usageWindowSize: windowSize,
      activeModelsAvgCostPerHourUsd: activeModelsAvgCostPerHourUsd > 0
        ? activeModelsAvgCostPerHourUsd
        : null,
      activeModelsHourlyShareByModel,
    };
  },
});

export const purgeGenerationUsageEventBatch = internalMutation({
  args: {
    generation: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    deleted: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("llmUsageEvents")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate(args.paginationOpts);

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    return {
      deleted: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const purgeGenerationReasoningProgressBatch = internalMutation({
  args: {
    generation: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    deleted: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("liveReasoningProgress")
      .withIndex("by_generation", (q: any) => q.eq("generation", args.generation))
      .paginate(args.paginationOpts);

    for (const row of result.page) {
      await ctx.db.delete(row._id);
    }

    return {
      deleted: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
