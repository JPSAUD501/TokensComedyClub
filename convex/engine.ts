import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  DEFAULT_SCORES,
  RUNNER_LEASE_MS,
  VIEWER_VOTE_WINDOW_ACTIVE_MS,
  VIEWER_VOTE_WINDOW_IDLE_MS,
} from "./constants";
import { getEngineState, getOrCreateEngineState, isFiniteRuns } from "./state";
import { readTotalViewerCount } from "./viewerCount";

function getVotingWindowMs(totalViewerCount: number): number {
  return totalViewerCount > 0 ? VIEWER_VOTE_WINDOW_ACTIVE_MS : VIEWER_VOTE_WINDOW_IDLE_MS;
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
    prompter: v.object({ id: v.string(), name: v.string() }),
    contestants: v.array(v.object({ id: v.string(), name: v.string() })),
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
    if (state.activeRoundId === args.roundId) {
      await ctx.db.patch(state._id, {
        activeRoundId: undefined,
        updatedAt: now,
      });
    }
    await ctx.db.delete(args.roundId);

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

export const startVoting = internalMutation({
  args: {
    expectedGeneration: v.number(),
    roundId: v.id("rounds"),
    voters: v.array(v.object({ id: v.string(), name: v.string() })),
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

