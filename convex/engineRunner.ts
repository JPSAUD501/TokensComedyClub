"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import type { Model } from "../shared/models";
import {
  POST_ROUND_DELAY_MS,
  RUNNER_LEASE_HEARTBEAT_MS,
  SKIPPED_ROUND_DELAY_MS,
  sleep,
  shuffle,
} from "./constants";
import { callGenerateAnswer, callGeneratePrompt, callVote, type LlmCallMetrics } from "./ai";

function pickRoundModels(models: Model[]): {
  prompter: Model;
  contestants: [Model, Model];
  voters: Model[];
} {
  const shuffled = shuffle([...models]);
  const prompter = shuffled[0]!;
  const contA = shuffled[1]!;
  const contB = shuffled[2]!;
  return {
    prompter,
    contestants: [contA, contB],
    voters: [prompter, ...shuffled.slice(3)],
  };
}

async function leaseStillValid(ctx: any, leaseId: string, generation: number): Promise<boolean> {
  const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
  if (!state) return false;
  if (state.generation !== generation) return false;
  if (state.runnerLeaseId !== leaseId) return false;
  if (!state.runnerLeaseUntil || state.runnerLeaseUntil <= Date.now()) return false;
  return true;
}

async function withLeaseHeartbeat<T>(ctx: any, leaseId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void ctx.runMutation(convexInternal.engine.renewLease, { leaseId }).catch(() => {});
  }, RUNNER_LEASE_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function toTaskMetrics(metrics?: LlmCallMetrics) {
  if (!metrics) return undefined;
  return {
    generationId: metrics.generationId,
    costUsd: metrics.costUsd,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    totalTokens: metrics.totalTokens,
    reasoningTokens: metrics.reasoningTokens,
    durationMsLocal: metrics.durationMsLocal,
    durationMsFinal: metrics.durationMsFinal,
    durationSource: metrics.durationSource,
    recordedAt: metrics.recordedAt,
  };
}

async function recordUsageIfAvailable(
  ctx: any,
  args: {
    generation: number;
    roundId: any;
    roundNum: number;
    requestType: "prompt" | "answer" | "vote";
    answerIndex?: number;
    voteIndex?: number;
    model: Model;
    metrics?: LlmCallMetrics;
  },
) {
  if (!args.metrics) return;

  await ctx.runMutation(convexInternal.usage.recordLlmUsageEvent, {
    generation: args.generation,
    roundId: args.roundId,
    roundNum: args.roundNum,
    requestType: args.requestType,
    answerIndex: args.answerIndex,
    voteIndex: args.voteIndex,
    modelId: args.model.id,
    modelName: args.model.name,
    modelMetricsEpoch: Number.isFinite(args.model.metricsEpoch) ? args.model.metricsEpoch : 1,
    generationId: args.metrics.generationId,
    costUsd: args.metrics.costUsd,
    promptTokens: args.metrics.promptTokens,
    completionTokens: args.metrics.completionTokens,
    totalTokens: args.metrics.totalTokens,
    reasoningTokens: args.metrics.reasoningTokens,
    durationMsLocal: args.metrics.durationMsLocal,
    durationMsFinal: args.metrics.durationMsFinal,
    durationSource: args.metrics.durationSource,
    startedAt: args.metrics.startedAt,
    finishedAt: args.metrics.finishedAt,
  });
}

export const runLoop = internalAction({
  args: {
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
    if (!state) return null;
    if (state.runnerLeaseId !== args.leaseId) return null;
    if (!state.runnerLeaseUntil || state.runnerLeaseUntil <= Date.now()) return null;

    if (state.done) {
      return null;
    }

    await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });

    if (state.isPaused) {
      await ctx.scheduler.runAfter(1_000, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const expectedGeneration = state.generation;
    if (state.activeRoundId) {
      const recovery = await ctx.runMutation(convexInternal.engine.recoverStaleActiveRound, {
        expectedGeneration,
      });
      if (recovery.recovered) {
        await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      } else {
        await ctx.scheduler.runAfter(750, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      }
      return null;
    }

    const enabledModels = (await ctx.runQuery(
      convexInternal.models.listActiveForRuntime,
      {},
    )) as Model[];
    if (enabledModels.length < 3) {
      await ctx.scheduler.runAfter(1_000, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const { prompter, contestants, voters } = pickRoundModels(enabledModels);

    const created = await ctx.runMutation(convexInternal.engine.createRound, {
      expectedGeneration,
      prompter,
      contestants,
    });

    if (!created) {
      await ctx.scheduler.runAfter(300, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const roundId = created.roundId;
    const roundNum = created.num;
    let promptReasoningEstimate = 0;

    try {
      await ctx.runMutation(convexInternal.usage.upsertLiveReasoningProgress, {
        generation: expectedGeneration,
        roundId,
        requestType: "prompt",
        modelId: prompter.id,
        estimatedReasoningTokens: 0,
      });

      const promptResult = await withLeaseHeartbeat(ctx, args.leaseId, async () => {
        return await callGeneratePrompt(prompter, async (estimatedReasoningTokens, finalized) => {
          promptReasoningEstimate = estimatedReasoningTokens;
          if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
          await ctx.runMutation(convexInternal.usage.upsertLiveReasoningProgress, {
            generation: expectedGeneration,
            roundId,
            requestType: "prompt",
            modelId: prompter.id,
            estimatedReasoningTokens,
            finalized,
          });
        });
      });
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      await ctx.runMutation(convexInternal.engine.setPromptResult, {
        expectedGeneration,
        roundId,
        prompt: promptResult.text,
        metrics: toTaskMetrics(promptResult.metrics),
      });
      await recordUsageIfAvailable(ctx, {
        generation: expectedGeneration,
        roundId,
        roundNum,
        requestType: "prompt",
        model: prompter,
        metrics: promptResult.metrics,
      });
    } catch {
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      await ctx.runMutation(convexInternal.usage.finalizeLiveReasoningProgress, {
        generation: expectedGeneration,
        roundId,
        requestType: "prompt",
        modelId: prompter.id,
        estimatedReasoningTokens: promptReasoningEstimate,
      });

      await ctx.runMutation(convexInternal.engine.setPromptError, {
        expectedGeneration,
        roundId,
        error: "Falha ao gerar prompt (3 tentativas)",
      });

      await sleep(SKIPPED_ROUND_DELAY_MS);
      await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.startAnswering, {
      expectedGeneration,
      roundId,
    });

    const currentRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!currentRound || !currentRound.prompt) {
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const answerReasoningEstimates = [0, 0];
    await Promise.all(
      contestants.map(async (contestant, answerIndex) => {
        await ctx.runMutation(convexInternal.usage.upsertLiveReasoningProgress, {
          generation: expectedGeneration,
          roundId,
          requestType: "answer",
          answerIndex,
          modelId: contestant.id,
          estimatedReasoningTokens: 0,
        });
      }),
    );

    await withLeaseHeartbeat(ctx, args.leaseId, async () => {
      await Promise.all(
        contestants.map(async (contestant, answerIndex) => {
          try {
            const result = await callGenerateAnswer(
              contestant,
              currentRound.prompt as string,
              async (estimatedReasoningTokens, finalized) => {
                answerReasoningEstimates[answerIndex] = estimatedReasoningTokens;
                if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
                await ctx.runMutation(convexInternal.usage.upsertLiveReasoningProgress, {
                  generation: expectedGeneration,
                  roundId,
                  requestType: "answer",
                  answerIndex,
                  modelId: contestant.id,
                  estimatedReasoningTokens,
                  finalized,
                });
              },
            );
            if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
            await ctx.runMutation(convexInternal.engine.setAnswerResult, {
              expectedGeneration,
              roundId,
              answerIndex,
              result: result.text,
              metrics: toTaskMetrics(result.metrics),
            });
            await recordUsageIfAvailable(ctx, {
              generation: expectedGeneration,
              roundId,
              roundNum,
              requestType: "answer",
              answerIndex,
              model: contestant,
              metrics: result.metrics,
            });
          } catch (error) {
            const message =
              error instanceof Error && /timeout|timed out|abort/i.test(error.message)
                ? "Tempo esgotado (60s)"
                : "Failed to answer";
            if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;

            await ctx.runMutation(convexInternal.usage.finalizeLiveReasoningProgress, {
              generation: expectedGeneration,
              roundId,
              requestType: "answer",
              answerIndex,
              modelId: contestant.id,
              estimatedReasoningTokens: answerReasoningEstimates[answerIndex] ?? 0,
            });
            await ctx.runMutation(convexInternal.engine.setAnswerResult, {
              expectedGeneration,
              roundId,
              answerIndex,
              result: "[no answer]",
              error: message,
            });
          }
        }),
      );
    });

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    const roundAfterAnswers = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!roundAfterAnswers) {
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const failedAnswerTask = roundAfterAnswers.answerTasks.find((task: any) => Boolean(task?.error));
    if (failedAnswerTask) {
      const modelName = failedAnswerTask?.model?.name ?? "modelo";
      const reason = failedAnswerTask?.error ?? "Falha na resposta";
      await ctx.runMutation(convexInternal.engine.skipRoundForAnswerFailure, {
        expectedGeneration,
        roundId,
        error: `${modelName}: ${reason}`,
      });
      await sleep(SKIPPED_ROUND_DELAY_MS);
      await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    await ctx.runMutation(convexInternal.engine.startVoting, {
      expectedGeneration,
      roundId,
      voters,
    });

    const roundForVotes = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
    if (!roundForVotes) {
      await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });
      return null;
    }

    const answerA = roundForVotes.answerTasks[0]?.result ?? "[no answer]";
    const answerB = roundForVotes.answerTasks[1]?.result ?? "[no answer]";

    let modelVotesDone = false;
    const modelVotesPromise = withLeaseHeartbeat(ctx, args.leaseId, async () => {
      await Promise.all(
        voters.map(async (voter, voteIndex) => {
          try {
            const showAFirst = Math.random() > 0.5;
            const first = showAFirst ? { answer: answerA } : { answer: answerB };
            const second = showAFirst ? { answer: answerB } : { answer: answerA };
            const result = await callVote(voter, roundForVotes.prompt ?? "", first, second);
            if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;

            const votedForSide: "A" | "B" = showAFirst
              ? result.vote === "A"
                ? "A"
                : "B"
              : result.vote === "A"
                ? "B"
                : "A";

            await ctx.runMutation(convexInternal.engine.setModelVote, {
              expectedGeneration,
              roundId,
              voteIndex,
              side: votedForSide,
            });
            await recordUsageIfAvailable(ctx, {
              generation: expectedGeneration,
              roundId,
              roundNum,
              requestType: "vote",
              voteIndex,
              model: voter,
              metrics: result.metrics,
            });
          } catch {
            if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return;
            await ctx.runMutation(convexInternal.engine.setModelVote, {
              expectedGeneration,
              roundId,
              voteIndex,
              error: true,
            });
          }
        }),
      );
    }).finally(() => {
      modelVotesDone = true;
    });

    let windowClosed = false;
    let lastLeaseRenewAt = Date.now();
    while (!windowClosed || !modelVotesDone) {
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      const latestRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
      if (!latestRound || latestRound.phase !== "voting" || !latestRound.viewerVotingEndsAt) {
        windowClosed = true;
        if (!modelVotesDone) {
          await sleep(300);
        }
      } else {
        const remaining = latestRound.viewerVotingEndsAt - Date.now();
        windowClosed = remaining <= 0;
        if (!windowClosed) {
          await sleep(Math.max(100, Math.min(1_000, remaining)));
        } else if (!modelVotesDone) {
          await sleep(300);
        }
      }

      const now = Date.now();
      if (now - lastLeaseRenewAt >= 20_000) {
        await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
        lastLeaseRenewAt = now;
      }
    }

    await modelVotesPromise;

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.finalizeRound, {
      expectedGeneration,
      roundId,
    });

    await sleep(POST_ROUND_DELAY_MS);

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;
    await ctx.runMutation(convexInternal.engine.renewLease, { leaseId: args.leaseId });
    await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });

    return null;
  },
});
