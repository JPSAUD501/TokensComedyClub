import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { getEngineState, resolveRuntimeRoundTiming } from "./state";
import { readTotalViewerCount } from "./viewerCount";

export const USAGE_WINDOW_SIZE = 50;
export const PROJECTION_BOOTSTRAP_TARGET_SAMPLES = 5;
const DENOMINATOR_ROUND_LIMIT = 1_200;
const PROJECTION_ROUND_WINDOW_SIZE = 90;
const PROJECTION_EVENT_WINDOW_SIZE = 1_500;
const RECENCY_DECAY_FACTOR = 0.94;

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

const usageEventOriginValidator = v.union(
  v.literal("runtime"),
  v.literal("bootstrap"),
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

function weightedRecentAverage(values: number[], decay = RECENCY_DECAY_FACTOR): number | null {
  if (values.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;
  let weight = 1;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    weightedSum += value * weight;
    totalWeight += weight;
    weight *= decay;
  }

  if (totalWeight <= 0) return null;
  return weightedSum / totalWeight;
}

function getRoundVoteWindowMs(
  round: any,
  fallbackWindowMs: number,
): number {
  const explicitWindow = safeNumber(round.viewerVotingWindowMs);
  if (explicitWindow > 0) {
    return explicitWindow;
  }

  const voteStarts = (round.votes ?? [])
    .map((vote: any) => safeNumber(vote?.startedAt))
    .filter((value: number) => value > 0);
  const voteStart = voteStarts.length > 0 ? Math.min(...voteStarts) : 0;
  const voteEndsAt = safeNumber(round.viewerVotingEndsAt);
  if (voteStart > 0 && voteEndsAt > 0) {
    return Math.max(0, voteEndsAt - voteStart);
  }

  return fallbackWindowMs;
}

function resolveRoundVotingMode(
  round: any,
  voteWindowMs: number,
  timing: {
    viewerVoteWindowActiveMs: number;
    viewerVoteWindowIdleMs: number;
  },
): "active" | "idle" {
  if (round.viewerVotingMode === "active" || round.viewerVotingMode === "idle") {
    return round.viewerVotingMode;
  }

  const viewerVotesA = safeNumber(round.viewerVotesA);
  const viewerVotesB = safeNumber(round.viewerVotesB);
  if (viewerVotesA + viewerVotesB > 0) {
    return "active";
  }

  const activeDiff = Math.abs(voteWindowMs - timing.viewerVoteWindowActiveMs);
  const idleDiff = Math.abs(voteWindowMs - timing.viewerVoteWindowIdleMs);
  if (activeDiff < idleDiff) return "active";
  if (idleDiff < activeDiff) return "idle";

  const pivot = (timing.viewerVoteWindowActiveMs + timing.viewerVoteWindowIdleMs) / 2;
  return voteWindowMs <= pivot ? "active" : "idle";
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
    roundId: v.optional(v.id("rounds")),
    roundNum: v.optional(v.number()),
    origin: v.optional(usageEventOriginValidator),
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
      origin: args.origin ?? "runtime",
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
    const resolvedTiming = resolveRuntimeRoundTiming(state);

    if (!state) {
      return {
        usageByModel: {},
        usageHourlyByModel: {},
        usageWindowSize: windowSize,
        activeModelsAvgCostPerHourUsd: null,
        activeModelsHourlyShareByModel: {},
        projectionBootstrap: {
          status: "ready",
          running: false,
          runId: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          requiredSamplesPerAction: PROJECTION_BOOTSTRAP_TARGET_SAMPLES,
          missingSamplesByModelAction: {},
        },
        projection: {
          timing: resolvedTiming,
          samples: {
            rounds: 0,
            events: 0,
            roundCosts: 0,
            gaps: 0,
          },
          roleCounts: {
            promptCapable: 0,
            answerCapable: 0,
            voteCapable: 0,
          },
          expectedRequestsPerRound: {
            prompt: 0,
            answer: 0,
            vote: 0,
            total: 0,
          },
          viewerRoundShare: 0,
          confidencePercent: 0,
          costs: {
            perRequestUsd: {
              prompt: 0,
              answer: 0,
              vote: 0,
            },
            perRoundUsd: {
              prompt: 0,
              answer: 0,
              vote: 0,
              total: 0,
              modeledTotal: 0,
              historicalTotal: null,
            },
          },
          timingsMs: {
            nonVoting: null,
            voteWindowEffective: null,
            postRoundDelayEffective: null,
            extraInterRound: null,
            roundCycle: null,
          },
          rates: {
            roundsPerHour: null,
            hourlyCostUsd: null,
            promptHourlyUsd: null,
            answerHourlyUsd: null,
            voteHourlyUsd: null,
          },
        },
      };
    }

    const generation = state.generation;
    const models = await ctx.db.query("models").collect();
    const modelEpochById = new Map<string, number>();
    for (const model of models) {
      modelEpochById.set(model.modelId, safeEpoch(model.metricsEpoch));
    }

    const denominators: Record<string, Record<string, number>> = {};
    const denominatorRounds = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_num", (q: any) => q.eq("generation", generation))
      .order("desc")
      .take(Math.max(DENOMINATOR_ROUND_LIMIT, windowSize * 8));

    for (const round of denominatorRounds) {
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
    const activeModels = models.filter((model) => model.enabled && !model.archivedAt);
    const activeModelIdSet = new Set(activeModels.map((model) => model.modelId));
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

    const activeModelIds = activeModels.map((model) => model.modelId);
    const activeModelsAvgCostPerHourUsd = sum(
      activeModelIds.map((modelId) => safeNumber(usageHourlyByModel[modelId]?.avgCostPerHourUsd)),
    );
    const activeModelsHourlyShareByModel: Record<string, number> = {};
    for (const modelId of activeModelIds) {
      const modelHourly = safeNumber(usageHourlyByModel[modelId]?.avgCostPerHourUsd);
      activeModelsHourlyShareByModel[modelId] =
        activeModelsAvgCostPerHourUsd > 0 ? (modelHourly / activeModelsAvgCostPerHourUsd) * 100 : 0;
    }

    const missingSamplesByModelAction: Record<string, { prompt: number; answer: number; vote: number }> = {};
    for (const activeModel of activeModels) {
      const modelId = activeModel.modelId;
      const modelEpoch = safeEpoch(activeModel.metricsEpoch);
      const [promptSampleEvents, answerSampleEvents, voteSampleEvents] = await Promise.all([
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
          .take(PROJECTION_BOOTSTRAP_TARGET_SAMPLES),
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
          .take(PROJECTION_BOOTSTRAP_TARGET_SAMPLES),
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
          .take(PROJECTION_BOOTSTRAP_TARGET_SAMPLES),
      ]);

      const promptMissing = Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - promptSampleEvents.length);
      const answerMissing = Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - answerSampleEvents.length);
      const voteMissing = Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - voteSampleEvents.length);
      if (promptMissing > 0 || answerMissing > 0 || voteMissing > 0) {
        missingSamplesByModelAction[modelId] = {
          prompt: promptMissing,
          answer: answerMissing,
          vote: voteMissing,
        };
      }
    }

    const bootstrapRunning = state.projectionBootstrapRunning === true;
    const hasMissingSamples = Object.keys(missingSamplesByModelAction).length > 0;
    const bootstrapStatus: "ready" | "running" | "failed" =
      !hasMissingSamples
        ? "ready"
        : bootstrapRunning
          ? "running"
          : state.projectionBootstrapError
            ? "failed"
            : "running";
    const bootstrapRunningEffective = bootstrapRunning && hasMissingSamples;

    const projectionEvents = await ctx.db
      .query("llmUsageEvents")
      .withIndex("by_generation", (q: any) => q.eq("generation", generation))
      .order("desc")
      .take(PROJECTION_EVENT_WINDOW_SIZE);

    const recentProjectionEvents = projectionEvents.filter((event: any) => {
      if (!activeModelIdSet.has(event.modelId)) return false;
      const expectedEpoch = modelEpochById.get(event.modelId);
      if (expectedEpoch === undefined) return false;
      return safeEpoch(event.modelMetricsEpoch) === expectedEpoch;
    });

    const promptCostSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "prompt")
      .map((event: any) => safeNumber(event.costUsd));
    const answerCostSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "answer")
      .map((event: any) => safeNumber(event.costUsd));
    const voteCostSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "vote")
      .map((event: any) => safeNumber(event.costUsd));

    const promptDurationSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "prompt")
      .map((event: any) => Math.max(0, safeNumber(event.durationMsFinal)));
    const answerDurationSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "answer")
      .map((event: any) => Math.max(0, safeNumber(event.durationMsFinal)));
    const voteDurationSamples = recentProjectionEvents
      .filter((event: any) => event.requestType === "vote")
      .map((event: any) => Math.max(0, safeNumber(event.durationMsFinal)));

    const promptCostPerRequestUsd = weightedRecentAverage(promptCostSamples) ?? 0;
    const answerCostPerRequestUsd = weightedRecentAverage(answerCostSamples) ?? 0;
    const voteCostPerRequestUsd = weightedRecentAverage(voteCostSamples) ?? 0;

    const promptDurationAvgMs = weightedRecentAverage(promptDurationSamples);
    const answerDurationAvgMs = weightedRecentAverage(answerDurationSamples);
    const voteDurationAvgMs = weightedRecentAverage(voteDurationSamples);

    const promptCapableCount = activeModels.filter((model) => model.canPrompt !== false).length;
    const answerCapableCount = activeModels.filter((model) => model.canAnswer !== false).length;
    const voteCapableCount = activeModels.filter((model) => model.canVote !== false).length;
    const answerAndVoteCount = activeModels.filter(
      (model) => model.canAnswer !== false && model.canVote !== false,
    ).length;

    const expectedPromptRequestsPerRound = promptCapableCount > 0 ? 1 : 0;
    const expectedAnswerRequestsPerRound = answerCapableCount >= 2 ? 2 : 0;
    const expectedContestantVoteOverlap =
      answerCapableCount > 0 ? (2 * answerAndVoteCount) / answerCapableCount : 0;
    const expectedVoteRequestsPerRound = Math.max(0, voteCapableCount - expectedContestantVoteOverlap);

    const modeledPromptRoundCostUsd = promptCostPerRequestUsd * expectedPromptRequestsPerRound;
    const modeledAnswerRoundCostUsd = answerCostPerRequestUsd * expectedAnswerRequestsPerRound;
    const modeledVoteRoundCostUsd = voteCostPerRequestUsd * expectedVoteRequestsPerRound;
    const modeledRoundCostUsd = modeledPromptRoundCostUsd + modeledAnswerRoundCostUsd + modeledVoteRoundCostUsd;

    const recentDoneRoundsDesc = await ctx.db
      .query("rounds")
      .withIndex("by_generation_and_phase", (q: any) =>
        q.eq("generation", generation).eq("phase", "done"),
      )
      .order("desc")
      .take(PROJECTION_ROUND_WINDOW_SIZE + 1);

    const roundModeById = new Map<string, "active" | "idle">();
    const nonVotingSamplesMs: number[] = [];
    let activeModeSamples = 0;
    for (const round of recentDoneRoundsDesc) {
      const roundCreatedAt = safeNumber(round.createdAt);
      const roundCompletedAt = safeNumber(round.completedAt);
      if (roundCreatedAt <= 0 || roundCompletedAt <= roundCreatedAt) continue;

      const voteWindowMs = getRoundVoteWindowMs(round, resolvedTiming.viewerVoteWindowActiveMs);
      const mode = resolveRoundVotingMode(round, voteWindowMs, resolvedTiming);
      roundModeById.set(String(round._id), mode);
      if (mode === "active") activeModeSamples += 1;

      const roundDurationMs = Math.max(0, roundCompletedAt - roundCreatedAt);
      nonVotingSamplesMs.push(Math.max(0, roundDurationMs - voteWindowMs));
    }

    let viewerRoundShare =
      nonVotingSamplesMs.length > 0 ? activeModeSamples / nonVotingSamplesMs.length : 0;
    if (nonVotingSamplesMs.length === 0) {
      const viewerCount = await readTotalViewerCount(ctx as any);
      viewerRoundShare = viewerCount > 0 ? 1 : 0;
    }
    viewerRoundShare = Math.max(0, Math.min(1, viewerRoundShare));

    const roundCostById = new Map<string, { prompt: number; answer: number; vote: number; total: number }>();
    for (const event of recentProjectionEvents) {
      const key = String(event.roundId);
      const current = roundCostById.get(key) ?? { prompt: 0, answer: 0, vote: 0, total: 0 };
      const costUsd = Math.max(0, safeNumber(event.costUsd));
      if (event.requestType === "prompt") current.prompt += costUsd;
      if (event.requestType === "answer") current.answer += costUsd;
      if (event.requestType === "vote") current.vote += costUsd;
      current.total += costUsd;
      roundCostById.set(key, current);
    }

    const historyRoundCosts: number[] = [];
    for (const round of recentDoneRoundsDesc) {
      const costs = roundCostById.get(String(round._id));
      if (!costs) continue;
      historyRoundCosts.push(costs.total);
    }

    const projectedPromptRoundCostUsd = modeledPromptRoundCostUsd;
    const projectedAnswerRoundCostUsd = modeledAnswerRoundCostUsd;
    const projectedVoteRoundCostUsd = modeledVoteRoundCostUsd;
    const projectedRoundCostUsd = modeledRoundCostUsd;

    const recentDoneRoundsAsc = [...recentDoneRoundsDesc].sort(
      (a: any, b: any) => safeNumber(a.num) - safeNumber(b.num),
    );
    const interRoundGapSamplesMs: number[] = [];
    const extraInterRoundSamplesMs: number[] = [];
    for (let i = 0; i < recentDoneRoundsAsc.length - 1; i += 1) {
      const currentRound = recentDoneRoundsAsc[i];
      const nextRound = recentDoneRoundsAsc[i + 1];
      if (!currentRound || !nextRound) continue;

      const completedAt = safeNumber(currentRound.completedAt) || safeNumber(currentRound.updatedAt);
      const nextCreatedAt = safeNumber(nextRound.createdAt);
      if (completedAt <= 0 || nextCreatedAt <= completedAt) continue;

      const gapMs = Math.max(0, nextCreatedAt - completedAt);
      const mode = roundModeById.get(String(currentRound._id)) ?? "idle";
      const configuredGapMs =
        mode === "active" ? resolvedTiming.postRoundDelayActiveMs : resolvedTiming.postRoundDelayIdleMs;
      const extraGapMs = Math.max(0, gapMs - configuredGapMs);

      interRoundGapSamplesMs.push(gapMs);
      extraInterRoundSamplesMs.push(extraGapMs);
    }

    const interRoundGapSamplesDesc = [...interRoundGapSamplesMs].reverse();
    const extraInterRoundSamplesDesc = [...extraInterRoundSamplesMs].reverse();

    const fallbackNonVotingMs = Math.max(
      12_000,
      (promptDurationAvgMs ?? 6_000) +
        (answerDurationAvgMs ?? 10_000) +
        Math.max(0, (voteDurationAvgMs ?? 0) - resolvedTiming.viewerVoteWindowActiveMs),
    );
    const avgNonVotingMs = weightedRecentAverage(nonVotingSamplesMs) ?? fallbackNonVotingMs;
    const avgExtraInterRoundMs = weightedRecentAverage(extraInterRoundSamplesDesc) ?? 0;

    const voteWindowEffectiveMs =
      viewerRoundShare * resolvedTiming.viewerVoteWindowActiveMs +
      (1 - viewerRoundShare) * resolvedTiming.viewerVoteWindowIdleMs;
    const postRoundDelayEffectiveMs =
      viewerRoundShare * resolvedTiming.postRoundDelayActiveMs +
      (1 - viewerRoundShare) * resolvedTiming.postRoundDelayIdleMs +
      avgExtraInterRoundMs;

    const roundCycleMs = Math.max(1, avgNonVotingMs + voteWindowEffectiveMs + postRoundDelayEffectiveMs);
    const roundsPerHour = roundCycleMs > 0 ? 3_600_000 / roundCycleMs : null;

    const projectedHourlyCostUsd = roundsPerHour !== null ? projectedRoundCostUsd * roundsPerHour : null;
    const promptHourlyUsd = roundsPerHour !== null ? projectedPromptRoundCostUsd * roundsPerHour : null;
    const answerHourlyUsd = roundsPerHour !== null ? projectedAnswerRoundCostUsd * roundsPerHour : null;
    const voteHourlyUsd = roundsPerHour !== null ? projectedVoteRoundCostUsd * roundsPerHour : null;

    const confidenceRounds = Math.min(1, nonVotingSamplesMs.length / 40);
    const confidenceEvents = Math.min(1, recentProjectionEvents.length / 600);
    const confidencePercent = Math.round((confidenceRounds * 0.6 + confidenceEvents * 0.4) * 100);

    return {
      usageByModel,
      usageHourlyByModel,
      usageWindowSize: windowSize,
      activeModelsAvgCostPerHourUsd: activeModelsAvgCostPerHourUsd > 0
        ? activeModelsAvgCostPerHourUsd
        : null,
      activeModelsHourlyShareByModel,
      projectionBootstrap: {
        status: bootstrapStatus,
        running: bootstrapRunningEffective,
        runId: state.projectionBootstrapRunId ?? null,
        startedAt: state.projectionBootstrapStartedAt ?? null,
        finishedAt: state.projectionBootstrapFinishedAt ?? null,
        error: state.projectionBootstrapError ?? null,
        requiredSamplesPerAction: PROJECTION_BOOTSTRAP_TARGET_SAMPLES,
        missingSamplesByModelAction,
      },
      projection: {
        timing: resolvedTiming,
        samples: {
          rounds: nonVotingSamplesMs.length,
          events: recentProjectionEvents.length,
          roundCosts: historyRoundCosts.length,
          gaps: interRoundGapSamplesMs.length,
        },
        roleCounts: {
          promptCapable: promptCapableCount,
          answerCapable: answerCapableCount,
          voteCapable: voteCapableCount,
        },
        expectedRequestsPerRound: {
          prompt: expectedPromptRequestsPerRound,
          answer: expectedAnswerRequestsPerRound,
          vote: expectedVoteRequestsPerRound,
          total: expectedPromptRequestsPerRound + expectedAnswerRequestsPerRound + expectedVoteRequestsPerRound,
        },
        viewerRoundShare,
        confidencePercent,
        costs: {
          perRequestUsd: {
            prompt: promptCostPerRequestUsd,
            answer: answerCostPerRequestUsd,
            vote: voteCostPerRequestUsd,
          },
          perRoundUsd: {
            prompt: projectedPromptRoundCostUsd,
            answer: projectedAnswerRoundCostUsd,
            vote: projectedVoteRoundCostUsd,
            total: projectedRoundCostUsd,
            modeledTotal: modeledRoundCostUsd,
            historicalTotal: null,
          },
        },
        timingsMs: {
          nonVoting: avgNonVotingMs,
          voteWindowEffective: voteWindowEffectiveMs,
          postRoundDelayEffective: postRoundDelayEffectiveMs,
          extraInterRound: avgExtraInterRoundMs,
          roundCycle: roundCycleMs,
        },
        rates: {
          roundsPerHour,
          hourlyCostUsd: projectedHourlyCostUsd,
          promptHourlyUsd,
          answerHourlyUsd,
          voteHourlyUsd,
        },
      },
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
