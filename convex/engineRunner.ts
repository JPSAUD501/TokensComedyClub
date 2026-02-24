"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import type { Model } from "../shared/models";
import {
  ENGINE_RUNNER_MIN_ENABLED_MODELS,
  ENGINE_RUNNER_RETRY_ACTIVE_ROUND_PENDING_MS,
  ENGINE_RUNNER_RETRY_ACTIVE_ROUND_RECOVERED_MS,
  ENGINE_RUNNER_RETRY_BLOCKED_MS,
  ENGINE_RUNNER_RETRY_CREATE_ROUND_FAILED_MS,
  ENGINE_RUNNER_RETRY_PAUSED_MS,
  ENGINE_RUNNER_VOTE_MODEL_WAIT_MS,
  ENGINE_RUNNER_VOTE_WINDOW_POLL_MAX_MS,
  ENGINE_RUNNER_VOTE_WINDOW_POLL_MIN_MS,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_ATTEMPTS,
  RUNNER_LEASE_HEARTBEAT_MS,
  RUNNER_LEASE_MANUAL_RENEW_MS,
  SKIPPED_ROUND_DELAY_MS,
  sleep,
  shuffle,
} from "./constants";
import { callGenerateAnswer, callGeneratePrompt, callVote, type LlmCallMetrics } from "./ai";

type RoleCapableModel = Model & {
  canPrompt?: boolean;
  canAnswer?: boolean;
  canVote?: boolean;
};

function toRoundModel(model: RoleCapableModel): Model {
  return {
    id: model.id,
    name: model.name,
    color: model.color,
    logoId: model.logoId,
    reasoningEffort: model.reasoningEffort,
    metricsEpoch: model.metricsEpoch,
  };
}

function pickRoundModels(models: RoleCapableModel[]): {
  prompter: Model;
  contestants: [Model, Model];
  voters: Model[];
} | null {
  const promptPool = shuffle(models.filter((model) => model.canPrompt !== false));
  const answerPool = models.filter((model) => model.canAnswer !== false);
  const votePool = models.filter((model) => model.canVote !== false);

  if (promptPool.length === 0 || answerPool.length < 2 || votePool.length === 0) {
    return null;
  }

  for (const prompter of promptPool) {
    const contestantCandidates = shuffle(answerPool.filter((candidate) => candidate.id !== prompter.id));
    if (contestantCandidates.length < 2) continue;

    for (let i = 0; i < contestantCandidates.length - 1; i += 1) {
      const contA = contestantCandidates[i]!;
      for (let j = i + 1; j < contestantCandidates.length; j += 1) {
        const contB = contestantCandidates[j]!;
        const voters = shuffle(
          votePool.filter((voter) => voter.id !== contA.id && voter.id !== contB.id),
        );
        if (voters.length === 0) continue;

        return {
          prompter: toRoundModel(prompter),
          contestants: [toRoundModel(contA), toRoundModel(contB)],
          voters: voters.map((voter) => toRoundModel(voter)),
        };
      }
    }
  }

  return null;
}

async function leaseStillValid(ctx: any, leaseId: string, generation: number): Promise<boolean> {
  const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
  if (!state) return false;
  if (state.generation !== generation) return false;
  if (state.runnerLeaseId !== leaseId) return false;
  if (!state.runnerLeaseUntil || state.runnerLeaseUntil <= Date.now()) return false;
  return true;
}

function isOptimisticConcurrencyError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "code" in (error as any)) {
    return (error as any).code === "OptimisticConcurrencyControlFailure";
  }
  if (error instanceof Error) {
    return /OptimisticConcurrencyControlFailure/i.test(error.message);
  }
  return false;
}

async function safeRenewLease(
  ctx: any,
  leaseId: string,
  generation: number,
): Promise<boolean> {
  try {
    const renewed = await ctx.runMutation(convexInternal.engine.renewLease, { leaseId });
    if (renewed === true) return true;
    return await leaseStillValid(ctx, leaseId, generation);
  } catch (error) {
    if (isOptimisticConcurrencyError(error)) {
      return await leaseStillValid(ctx, leaseId, generation);
    }
    throw error;
  }
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
    const expectedGeneration = state.generation;

    if (state.done) {
      return null;
    }

    if (!(await safeRenewLease(ctx, args.leaseId, expectedGeneration))) {
      return null;
    }

    if (state.isPaused) {
      await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_PAUSED_MS, convexInternal.engineRunner.runLoop, {
        leaseId: args.leaseId,
      });
      return null;
    }

    if (state.activeRoundId) {
      const recovery = await ctx.runMutation(convexInternal.engine.recoverStaleActiveRound, {
        expectedGeneration,
      });
      if (recovery.recovered) {
        await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_ACTIVE_ROUND_RECOVERED_MS, convexInternal.engineRunner.runLoop, {
          leaseId: args.leaseId,
        });
      } else {
        await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_ACTIVE_ROUND_PENDING_MS, convexInternal.engineRunner.runLoop, {
          leaseId: args.leaseId,
        });
      }
      return null;
    }

    const enabledModels = (await ctx.runQuery(
      convexInternal.models.listActiveForRuntime,
      {},
    )) as RoleCapableModel[];
    if (enabledModels.length < ENGINE_RUNNER_MIN_ENABLED_MODELS) {
      await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_BLOCKED_MS, convexInternal.engineRunner.runLoop, {
        leaseId: args.leaseId,
      });
      return null;
    }

    const selectedModels = pickRoundModels(enabledModels);
    if (!selectedModels) {
      await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_BLOCKED_MS, convexInternal.engineRunner.runLoop, {
        leaseId: args.leaseId,
      });
      return null;
    }
    const { prompter, contestants, voters } = selectedModels;

    const created = await ctx.runMutation(convexInternal.engine.createRound, {
      expectedGeneration,
      prompter,
      contestants,
    });

    if (!created) {
      await ctx.scheduler.runAfter(ENGINE_RUNNER_RETRY_CREATE_ROUND_FAILED_MS, convexInternal.engineRunner.runLoop, {
        leaseId: args.leaseId,
      });
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
        error: `Falha ao gerar prompt (${MODEL_ATTEMPTS} tentativas)`,
      });

      await sleep(SKIPPED_ROUND_DELAY_MS);
      if (!(await safeRenewLease(ctx, args.leaseId, expectedGeneration))) return null;
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
                ? `Tempo esgotado (${Math.round(MODEL_CALL_TIMEOUT_MS / 1000)}s)`
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
      if (!(await safeRenewLease(ctx, args.leaseId, expectedGeneration))) return null;
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
    while (!windowClosed) {
      if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

      const latestRound = await ctx.runQuery(convexInternal.engine.getRoundForRunner, { roundId });
      if (!latestRound || latestRound.phase !== "voting" || !latestRound.viewerVotingEndsAt) {
        windowClosed = true;
        if (!modelVotesDone) {
          await sleep(ENGINE_RUNNER_VOTE_MODEL_WAIT_MS);
        }
      } else {
        const remaining = latestRound.viewerVotingEndsAt - Date.now();
        windowClosed = remaining <= 0;
        if (!windowClosed) {
          await sleep(
            Math.max(
              ENGINE_RUNNER_VOTE_WINDOW_POLL_MIN_MS,
              Math.min(ENGINE_RUNNER_VOTE_WINDOW_POLL_MAX_MS, remaining),
            ),
          );
        } else if (!modelVotesDone) {
          await sleep(ENGINE_RUNNER_VOTE_MODEL_WAIT_MS);
        }
      }

      const now = Date.now();
      if (now - lastLeaseRenewAt >= RUNNER_LEASE_MANUAL_RENEW_MS) {
        if (!(await safeRenewLease(ctx, args.leaseId, expectedGeneration))) return null;
        lastLeaseRenewAt = now;
      }
    }

    let modelVotesFailed = false;
    if (modelVotesDone) {
      try {
        await modelVotesPromise;
      } catch {
        modelVotesFailed = true;
      }
    } else {
      modelVotesFailed = true;
      void modelVotesPromise.catch(() => {});
    }

    if (modelVotesFailed) {
      await ctx.runMutation(convexInternal.engine.recoverStaleActiveRound, {
        expectedGeneration,
      });
    }

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;

    await ctx.runMutation(convexInternal.engine.finalizeRound, {
      expectedGeneration,
      roundId,
    });

    const postRoundDelayMs = await ctx.runQuery(convexInternal.engine.getPostRoundDelayMs, {
      expectedGeneration,
    });
    await sleep(Math.max(0, Number.isFinite(postRoundDelayMs) ? postRoundDelayMs : 0));

    if (!(await leaseStillValid(ctx, args.leaseId, expectedGeneration))) return null;
    if (!(await safeRenewLease(ctx, args.leaseId, expectedGeneration))) return null;
    await ctx.scheduler.runAfter(0, convexInternal.engineRunner.runLoop, { leaseId: args.leaseId });

    return null;
  },
});
