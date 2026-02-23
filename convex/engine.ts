import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  DEFAULT_SCORES,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_PHASE_DEADLINE_MS,
  MODEL_TIMEOUT_GRACE_MS,
  RUNNER_LEASE_MS,
  VIEWER_VOTE_WINDOW_ACTIVE_MS,
  VIEWER_VOTE_WINDOW_IDLE_MS,
} from "./constants";
import { getEngineState, getOrCreateEngineState, isFiniteRuns } from "./state";
import { readTotalViewerCount } from "./viewerCount";

const modelReasoningEffortValidator = v.union(
  v.literal("xhigh"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("minimal"),
  v.literal("none"),
);

const llmDurationSourceValidator = v.union(
  v.literal("openrouter_latency"),
  v.literal("openrouter_generation_time"),
  v.literal("local"),
);

const taskMetricsValidator = v.object({
  generationId: v.string(),
  costUsd: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  totalTokens: v.number(),
  reasoningTokens: v.number(),
  durationMsLocal: v.number(),
  durationMsFinal: v.number(),
  durationSource: llmDurationSourceValidator,
  recordedAt: v.number(),
});

function getVotingWindowMs(totalViewerCount: number): number {
  return totalViewerCount > 0 ? VIEWER_VOTE_WINDOW_ACTIVE_MS : VIEWER_VOTE_WINDOW_IDLE_MS;
}

function getModelPhaseStaleThresholdMs(): number {
  return MODEL_PHASE_DEADLINE_MS + MODEL_TIMEOUT_GRACE_MS;
}

function getAnswerPhaseStaleThresholdMs(): number {
  return MODEL_CALL_TIMEOUT_MS + MODEL_TIMEOUT_GRACE_MS;
}

async function finalizeRoundInternal(ctx: any, state: any, round: any): Promise<boolean> {
  if (state.activeRoundId !== round._id) return false;
  if (round.phase === "done") return false;
  if (round.skipped) return false;

  let votesA = 0;
  let votesB = 0;
  for (const vote of round.votes) {
    if (vote.votedForSide === "A") votesA += 1;
    else if (vote.votedForSide === "B") votesB += 1;
  }

  const tallies = await ctx.db
    .query("viewerVoteTallies")
    .withIndex("by_round", (q: any) => q.eq("roundId", round._id))
    .collect();

  const viewerVotesA = tallies
    .filter((x: any) => x.side === "A")
    .reduce((sum: number, x: any) => sum + x.count, 0);
  const viewerVotesB = tallies
    .filter((x: any) => x.side === "B")
    .reduce((sum: number, x: any) => sum + x.count, 0);

  const scoreA = votesA * 100;
  const scoreB = votesB * 100;
  const scores = { ...state.scores };
  const humanScores = { ...DEFAULT_SCORES, ...(state.humanScores ?? {}) };
  const humanVoteTotals = { ...DEFAULT_SCORES, ...(state.humanVoteTotals ?? {}) };
  const contA = round.contestants[0];
  const contB = round.contestants[1];

  if (contA && contB) {
    if (votesA > votesB) {
      scores[contA.name] = (scores[contA.name] ?? 0) + 1;
    } else if (votesB > votesA) {
      scores[contB.name] = (scores[contB.name] ?? 0) + 1;
    }

    humanVoteTotals[contA.name] = (humanVoteTotals[contA.name] ?? 0) + viewerVotesA;
    humanVoteTotals[contB.name] = (humanVoteTotals[contB.name] ?? 0) + viewerVotesB;
    if (viewerVotesA > viewerVotesB) {
      humanScores[contA.name] = (humanScores[contA.name] ?? 0) + 1;
    } else if (viewerVotesB > viewerVotesA) {
      humanScores[contB.name] = (humanScores[contB.name] ?? 0) + 1;
    }
  }

  const nextCompletedRounds = state.completedRounds + 1;
  const nextDone =
    isFiniteRuns(state) && typeof state.totalRounds === "number"
      ? nextCompletedRounds >= state.totalRounds
      : false;

  await ctx.db.patch(round._id, {
    phase: "done",
    scoreA,
    scoreB,
    viewerVotesA,
    viewerVotesB,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });

  await ctx.db.patch(state._id, {
    activeRoundId: undefined,
    lastCompletedRoundId: round._id,
    scores,
    humanScores,
    humanVoteTotals,
    completedRounds: nextCompletedRounds,
    nextRoundNum: state.nextRoundNum + 1,
    done: nextDone,
    updatedAt: Date.now(),
  });

  return true;
}

export const getRunnerState = internalQuery({
  args: {},
  returns: v.union(v.any(), v.null()),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    return state ?? null;
  },
});

export const renewLease = internalMutation({
  args: {
    leaseId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    if (state.runnerLeaseId !== args.leaseId) return false;
    await ctx.db.patch(state._id, {
      runnerLeaseUntil: Date.now() + RUNNER_LEASE_MS,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const createRound = internalMutation({
  args: {
    expectedGeneration: v.number(),
    prompter: v.object({
      id: v.string(),
      name: v.string(),
      color: v.optional(v.string()),
      logoId: v.optional(v.string()),
      reasoningEffort: v.optional(modelReasoningEffortValidator),
      metricsEpoch: v.optional(v.number()),
    }),
    contestants: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        color: v.optional(v.string()),
        logoId: v.optional(v.string()),
        reasoningEffort: v.optional(modelReasoningEffortValidator),
        metricsEpoch: v.optional(v.number()),
      }),
    ),
  },
  returns: v.union(v.object({ roundId: v.id("rounds"), num: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    if (state.generation !== args.expectedGeneration) return null;
    if (state.done) return null;

    if (state.activeRoundId) {
      const activeRound = await ctx.db.get(state.activeRoundId);
      if (activeRound) return null;
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        updatedAt: Date.now(),
      });
    }

    const now = Date.now();
    const num = state.nextRoundNum;
    const roundId = await ctx.db.insert("rounds", {
      generation: state.generation,
      num,
      phase: "prompting",
      prompter: args.prompter,
      promptTask: {
        model: args.prompter,
        startedAt: now,
      },
      contestants: args.contestants,
      answerTasks: [
        { model: args.contestants[0]!, startedAt: 0 },
        { model: args.contestants[1]!, startedAt: 0 },
      ],
      votes: [],
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(state._id, {
      activeRoundId: roundId,
      updatedAt: now,
    });

    return { roundId, num };
  },
});

export const setPromptResult = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    prompt: v.string(),
    metrics: v.optional(taskMetricsValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    await ctx.db.patch(args.roundId, {
      prompt: args.prompt,
      promptTask: {
        ...round.promptTask,
        finishedAt: Date.now(),
        result: args.prompt,
        error: undefined,
        metrics: args.metrics,
      },
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setPromptError = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    const now = Date.now();
    await ctx.db.patch(args.roundId, {
      phase: "done",
      promptTask: {
        ...round.promptTask,
        finishedAt: now,
        error: args.error,
      },
      skipped: true,
      skipReason: args.error,
      skipType: "prompt_error",
      completedAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(state._id, {
      activeRoundId: state.activeRoundId === args.roundId ? undefined : state.activeRoundId,
      lastCompletedRoundId: args.roundId,
      updatedAt: now,
    });

    return true;
  },
});

export const startAnswering = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    const firstTask = round.answerTasks[0];
    const secondTask = round.answerTasks[1];
    if (!firstTask || !secondTask) return false;

    const answerStart = Date.now();
    const tasks = [
      { ...firstTask, startedAt: answerStart },
      { ...secondTask, startedAt: answerStart },
    ];

    await ctx.db.patch(args.roundId, {
      phase: "answering",
      answerTasks: tasks,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const setAnswerResult = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    answerIndex: v.number(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    metrics: v.optional(taskMetricsValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    if (args.answerIndex !== 0 && args.answerIndex !== 1) return false;

    const task = round.answerTasks[args.answerIndex];
    if (!task) return false;
    const updatedTask = {
      ...task,
      finishedAt: Date.now(),
      result: args.result ?? task.result ?? "[no answer]",
      error: args.error,
      metrics: args.metrics,
    };

    const answerTasks = [...round.answerTasks];
    answerTasks[args.answerIndex] = updatedTask;

    await ctx.db.patch(args.roundId, {
      answerTasks,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const skipRoundForAnswerFailure = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    error: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    const now = Date.now();
    await ctx.db.patch(args.roundId, {
      phase: "done",
      skipped: true,
      skipReason: args.error,
      skipType: "answer_error",
      completedAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(state._id, {
      activeRoundId: state.activeRoundId === args.roundId ? undefined : state.activeRoundId,
      lastCompletedRoundId: args.roundId,
      updatedAt: now,
    });

    return true;
  },
});

export const startVoting = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    voters: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        color: v.optional(v.string()),
        logoId: v.optional(v.string()),
        reasoningEffort: v.optional(modelReasoningEffortValidator),
        metricsEpoch: v.optional(v.number()),
      }),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;

    const voteStart = Date.now();
    const totalViewerCount = await readTotalViewerCount(ctx as any);
    const windowMs = getVotingWindowMs(totalViewerCount);
    const votes = args.voters.map((voter) => ({ voter, startedAt: voteStart }));

    await ctx.db.patch(args.roundId, {
      phase: "voting",
      votes,
      viewerVotingEndsAt: voteStart + windowMs,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const setModelVote = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    voteIndex: v.number(),
    side: v.optional(v.union(v.literal("A"), v.literal("B"))),
    error: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    if (args.voteIndex < 0 || args.voteIndex >= round.votes.length) return false;

    const votes = [...round.votes];
    const vote = votes[args.voteIndex];
    if (!vote) return false;
    votes[args.voteIndex] = {
      ...vote,
      finishedAt: Date.now(),
      votedForSide: args.side,
      error: args.error,
    };

    await ctx.db.patch(args.roundId, {
      votes,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const recoverStaleActiveRound = internalMutation({
  args: {
    expectedGeneration: v.number(),
  },
  returns: v.object({
    recovered: v.boolean(),
    reason: v.string(),
  }),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    if (!state) {
      return { recovered: false, reason: "missing_state" };
    }
    if (state.generation !== args.expectedGeneration) {
      return { recovered: false, reason: "generation_mismatch" };
    }
    if (!state.activeRoundId) {
      return { recovered: false, reason: "no_active_round" };
    }

    const round = await ctx.db.get(state.activeRoundId);
    if (!round) {
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        updatedAt: Date.now(),
      });
      return { recovered: true, reason: "missing_active_round_cleared" };
    }
    if (round.generation !== args.expectedGeneration) {
      return { recovered: false, reason: "round_generation_mismatch" };
    }

    const now = Date.now();
    const promptStaleThresholdMs = getModelPhaseStaleThresholdMs();
    const answerStaleThresholdMs = getAnswerPhaseStaleThresholdMs();

    if (round.phase === "done") {
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        lastCompletedRoundId: round._id,
        updatedAt: now,
      });
      return { recovered: true, reason: "active_done_round_cleared" };
    }

    if (round.phase === "prompting") {
      const promptStartedAt = round.promptTask?.startedAt ?? round.createdAt ?? round.updatedAt ?? now;
      if (now - promptStartedAt <= promptStaleThresholdMs) {
        return { recovered: false, reason: "prompting_not_stale" };
      }

      await ctx.db.patch(round._id, {
        phase: "done",
        promptTask: {
          ...round.promptTask,
          finishedAt: now,
          error: round.promptTask?.error ?? "Prompt timed out",
        },
        skipped: true,
        skipReason: round.skipReason ?? "Prompt timed out",
        skipType: "prompt_error",
        completedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        lastCompletedRoundId: round._id,
        updatedAt: now,
      });
      return { recovered: true, reason: "prompting_timed_out" };
    }

    if (round.phase === "answering") {
      const answerStartedAt = Math.max(
        round.answerTasks?.[0]?.startedAt ?? 0,
        round.answerTasks?.[1]?.startedAt ?? 0,
        round.updatedAt ?? 0,
      );
      if (now - answerStartedAt <= answerStaleThresholdMs) {
        return { recovered: false, reason: "answering_not_stale" };
      }

      const answerTasks = round.answerTasks.map((task: any) =>
        task?.finishedAt
          ? task
          : {
              ...task,
              finishedAt: now,
              result: task?.result ?? "[no answer]",
              error: task?.error ?? "Timed out",
            },
      );

      await ctx.db.patch(round._id, {
        phase: "done",
        answerTasks,
        skipped: true,
        skipReason: round.skipReason ?? "Falha na resposta (timeout 60s)",
        skipType: "answer_error",
        completedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        lastCompletedRoundId: round._id,
        updatedAt: now,
      });
      return { recovered: true, reason: "answering_timed_out_skipped" };
    }

    if (round.phase === "voting") {
      const hasPendingVotes = round.votes.some((vote: any) => !vote?.finishedAt);
      const voteStartCandidates = round.votes
        .map((vote: any) => vote?.startedAt)
        .filter((startedAt: unknown) => typeof startedAt === "number" && Number.isFinite(startedAt));
      const voteStartedAt =
        voteStartCandidates.length > 0
          ? Math.min(...voteStartCandidates)
          : (round.updatedAt ?? now);

      const modelVotesStale = hasPendingVotes && now - voteStartedAt > getModelPhaseStaleThresholdMs();
      const windowClosed = !round.viewerVotingEndsAt || now >= round.viewerVotingEndsAt;
      if (!modelVotesStale && !windowClosed) {
        return { recovered: false, reason: "voting_not_stale" };
      }

      let latestRound = round;
      if (hasPendingVotes) {
        const votes = round.votes.map((vote: any) =>
          vote?.finishedAt
            ? vote
            : {
                ...vote,
                finishedAt: now,
                error: true,
              },
        );
        await ctx.db.patch(round._id, {
          votes,
          updatedAt: now,
        });
        latestRound = { ...round, votes };
      }

      if (!windowClosed) {
        return { recovered: true, reason: "voting_pending_votes_marked_error" };
      }

      const finalized = await finalizeRoundInternal(ctx as any, state, latestRound);
      return {
        recovered: finalized,
        reason: finalized ? "voting_finalized" : "voting_finalize_skipped",
      };
    }

    return { recovered: false, reason: "unsupported_phase" };
  },
});

export const maybeShortenVotingWindow = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const state = await getEngineState(ctx as any);
    if (!state?.activeRoundId) return false;

    const round = await ctx.db.get(state.activeRoundId);
    if (!round || round.phase !== "voting" || !round.viewerVotingEndsAt) return false;

    const now = Date.now();
    const remaining = round.viewerVotingEndsAt - now;
    if (remaining <= VIEWER_VOTE_WINDOW_ACTIVE_MS) {
      return false;
    }

    const totalViewerCount = await readTotalViewerCount(ctx as any);
    if (totalViewerCount <= 0) {
      return false;
    }

    await ctx.db.patch(round._id, {
      viewerVotingEndsAt: now + VIEWER_VOTE_WINDOW_ACTIVE_MS,
      updatedAt: now,
    });
    return true;
  },
});

export const finalizeRound = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await getEngineState(ctx as any);
    const round = await ctx.db.get(args.roundId);
    if (!state || !round) return false;
    if (state.generation !== args.expectedGeneration || round.generation !== args.expectedGeneration) return false;
    return await finalizeRoundInternal(ctx as any, state, round);
  },
});

export const getRoundForRunner = internalQuery({
  args: {
    roundId: v.id("rounds"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.roundId);
  },
});

