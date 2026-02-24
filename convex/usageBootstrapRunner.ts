"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Model } from "../shared/models";
import { callGenerateAnswer, callGeneratePrompt, callVote, type LlmCallMetrics } from "./ai";
import { ALL_PROMPTS } from "../prompts";

const convexInternal = internal as any;

const MAX_BOOTSTRAP_ATTEMPTS_PER_ACTION = 30;
const DEFAULT_BOOTSTRAP_MODEL_CONCURRENCY = 2;
const MAX_BOOTSTRAP_MODEL_CONCURRENCY = 3;
const FALLBACK_VOTE_ANSWERS = [
  "I forgot my joke in another timeline.",
  "That is not a bug, it is premium chaos.",
  "My confidence is high, my facts are low.",
  "Please clap, the punchline is loading.",
  "I trained for this by losing gracefully.",
];

type RequestType = "prompt" | "answer" | "vote";

type MissingCounts = {
  prompt: number;
  answer: number;
  vote: number;
};

function resolveBootstrapModelConcurrency(): number {
  const raw = Number.parseInt(process.env.PROJECTION_BOOTSTRAP_MODEL_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BOOTSTRAP_MODEL_CONCURRENCY;
  return Math.max(1, Math.min(MAX_BOOTSTRAP_MODEL_CONCURRENCY, raw));
}

function randomFrom<T>(items: readonly T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[Math.max(0, Math.min(items.length - 1, index))] as T;
}

function normalizeMetricsEpoch(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 1;
}

function requireMetrics(
  metrics: LlmCallMetrics | undefined,
  requestType: RequestType,
  modelId: string,
): LlmCallMetrics {
  if (!metrics) {
    throw new Error(`Bootstrap ${requestType} sem metrica para ${modelId}`);
  }
  return metrics;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Falha desconhecida no bootstrap";
}

async function recordBootstrapUsageEvent(
  ctx: any,
  args: {
    generation: number;
    model: Model;
    requestType: RequestType;
    metrics: LlmCallMetrics;
  },
) {
  await ctx.runMutation(convexInternal.usage.recordLlmUsageEvent, {
    generation: args.generation,
    origin: "bootstrap",
    requestType: args.requestType,
    modelId: args.model.id,
    modelName: args.model.name,
    modelMetricsEpoch: normalizeMetricsEpoch(args.model.metricsEpoch),
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

async function ensureRunStillOwned(ctx: any, runId: string, generation: number): Promise<boolean> {
  const state = await ctx.runQuery(convexInternal.engine.getRunnerState, {});
  if (!state) return false;
  if (state.generation !== generation) return false;
  if (state.projectionBootstrapRunning !== true) return false;
  if (state.projectionBootstrapRunId !== runId) return false;
  return true;
}

async function generatePromptSamples(
  ctx: any,
  args: {
    generation: number;
    model: Model;
    missing: number;
    promptPool: string[];
  },
) {
  if (args.missing <= 0) return;
  let remaining = args.missing;
  let attempts = 0;
  let lastError = "";
  while (remaining > 0 && attempts < MAX_BOOTSTRAP_ATTEMPTS_PER_ACTION) {
    attempts += 1;
    try {
      const result = await callGeneratePrompt(args.model);
      const metrics = requireMetrics(result.metrics, "prompt", args.model.id);
      await recordBootstrapUsageEvent(ctx, {
        generation: args.generation,
        model: args.model,
        requestType: "prompt",
        metrics,
      });
      args.promptPool.push(result.text);
      remaining -= 1;
    } catch (error) {
      lastError = normalizeError(error);
    }
  }
  if (remaining > 0) {
    throw new Error(`Bootstrap prompt incompleto para ${args.model.id}: ${lastError || "sem detalhe"}`);
  }
}

async function generateAnswerSamples(
  ctx: any,
  args: {
    generation: number;
    model: Model;
    missing: number;
    promptPool: string[];
    answerPool: string[];
  },
) {
  if (args.missing <= 0) return;
  let remaining = args.missing;
  let attempts = 0;
  let lastError = "";
  while (remaining > 0 && attempts < MAX_BOOTSTRAP_ATTEMPTS_PER_ACTION) {
    attempts += 1;
    const prompt = args.promptPool.length > 0 ? randomFrom(args.promptPool) : randomFrom(ALL_PROMPTS);
    try {
      const result = await callGenerateAnswer(args.model, prompt);
      const metrics = requireMetrics(result.metrics, "answer", args.model.id);
      await recordBootstrapUsageEvent(ctx, {
        generation: args.generation,
        model: args.model,
        requestType: "answer",
        metrics,
      });
      args.answerPool.push(result.text);
      remaining -= 1;
    } catch (error) {
      lastError = normalizeError(error);
    }
  }
  if (remaining > 0) {
    throw new Error(`Bootstrap answer incompleto para ${args.model.id}: ${lastError || "sem detalhe"}`);
  }
}

async function generateVoteSamples(
  ctx: any,
  args: {
    generation: number;
    model: Model;
    missing: number;
    promptPool: string[];
    answerPool: string[];
  },
) {
  if (args.missing <= 0) return;
  const promptPool: readonly string[] = args.promptPool.length > 0 ? args.promptPool : ALL_PROMPTS;
  const answerPool =
    args.answerPool.length >= 2
      ? args.answerPool
      : [...args.answerPool, ...FALLBACK_VOTE_ANSWERS];
  if (answerPool.length < 2) {
    throw new Error(`Bootstrap vote sem pool de respostas para ${args.model.id}`);
  }

  let remaining = args.missing;
  let attempts = 0;
  let lastError = "";
  while (remaining > 0 && attempts < MAX_BOOTSTRAP_ATTEMPTS_PER_ACTION) {
    attempts += 1;
    const prompt = randomFrom(promptPool);
    const firstIndex = Math.floor(Math.random() * answerPool.length);
    let secondIndex = Math.floor(Math.random() * answerPool.length);
    if (secondIndex === firstIndex) {
      secondIndex = (secondIndex + 1) % answerPool.length;
    }
    const firstAnswer = answerPool[firstIndex] ?? FALLBACK_VOTE_ANSWERS[0]!;
    const secondAnswer = answerPool[secondIndex] ?? FALLBACK_VOTE_ANSWERS[1]!;
    try {
      const result = await callVote(
        args.model,
        prompt,
        { answer: firstAnswer },
        { answer: secondAnswer },
      );
      const metrics = requireMetrics(result.metrics, "vote", args.model.id);
      await recordBootstrapUsageEvent(ctx, {
        generation: args.generation,
        model: args.model,
        requestType: "vote",
        metrics,
      });
      remaining -= 1;
    } catch (error) {
      lastError = normalizeError(error);
    }
  }
  if (remaining > 0) {
    throw new Error(`Bootstrap vote incompleto para ${args.model.id}: ${lastError || "sem detalhe"}`);
  }
}

async function runBootstrapForModel(
  ctx: any,
  args: {
    runId: string;
    generation: number;
    model: Model;
  },
): Promise<"done" | "skipped" | "ownership_lost"> {
  if (!(await ensureRunStillOwned(ctx, args.runId, args.generation))) {
    return "ownership_lost";
  }

  const counts = await ctx.runQuery(convexInternal.usageBootstrap.getModelBootstrapSampleCounts, {
    generation: args.generation,
    modelId: args.model.id,
    modelMetricsEpoch: normalizeMetricsEpoch(args.model.metricsEpoch),
  });
  const missing = counts.missing as MissingCounts;
  if (missing.prompt <= 0 && missing.answer <= 0 && missing.vote <= 0) {
    return "skipped";
  }

  const promptPool: string[] = [];
  const answerPool: string[] = [];
  await generatePromptSamples(ctx, {
    generation: args.generation,
    model: args.model,
    missing: missing.prompt,
    promptPool,
  });
  if (!(await ensureRunStillOwned(ctx, args.runId, args.generation))) {
    return "ownership_lost";
  }

  await generateAnswerSamples(ctx, {
    generation: args.generation,
    model: args.model,
    missing: missing.answer,
    promptPool,
    answerPool,
  });
  if (!(await ensureRunStillOwned(ctx, args.runId, args.generation))) {
    return "ownership_lost";
  }

  await generateVoteSamples(ctx, {
    generation: args.generation,
    model: args.model,
    missing: missing.vote,
    promptPool,
    answerPool,
  });

  return "done";
}

export const runProjectionBootstrap = internalAction({
  args: {
    runId: v.string(),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      if (!(await ensureRunStillOwned(ctx, args.runId, args.generation))) {
        return null;
      }

      const models = (await ctx.runQuery(convexInternal.models.listActiveForRuntime, {})) as Model[];
      if (models.length === 0) {
        await ctx.runMutation(convexInternal.usageBootstrap.finishProjectionBootstrapRun, {
          runId: args.runId,
          generation: args.generation,
        });
        return null;
      }

      const workerCount = Math.min(resolveBootstrapModelConcurrency(), models.length);
      let nextModelIndex = 0;
      let ownershipLost = false;
      let fatalError: unknown = null;

      const worker = async () => {
        while (true) {
          if (ownershipLost || fatalError) return;
          const index = nextModelIndex;
          nextModelIndex += 1;
          if (index >= models.length) return;
          const model = models[index];
          if (!model) return;

          try {
            const status = await runBootstrapForModel(ctx, {
              runId: args.runId,
              generation: args.generation,
              model,
            });
            if (status === "ownership_lost") {
              ownershipLost = true;
              return;
            }
          } catch (error) {
            fatalError = error;
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (ownershipLost) {
        return null;
      }
      if (fatalError) {
        throw fatalError;
      }

      await ctx.runMutation(convexInternal.usageBootstrap.finishProjectionBootstrapRun, {
        runId: args.runId,
        generation: args.generation,
      });
      return null;
    } catch (error) {
      await ctx.runMutation(convexInternal.usageBootstrap.finishProjectionBootstrapRun, {
        runId: args.runId,
        generation: args.generation,
        error: normalizeError(error),
      });
      return null;
    }
  },
});
