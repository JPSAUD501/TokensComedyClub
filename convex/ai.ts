"use node";

import { generateText, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ALL_PROMPTS } from "../prompts";
import { parseModelReasoningEffort, type Model } from "../shared/models";
import {
  MODEL_ATTEMPTS,
  MODEL_CALL_TIMEOUT_MS,
  shuffle,
} from "./constants";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const GENERATION_RETRY_DELAYS_MS = [400, 800, 1_200, 1_800, 2_500, 3_500, 5_000] as const;
const DEFAULT_REASONING_CALIBRATION_FACTOR = 0.92;
const MIN_REASONING_CALIBRATION_FACTOR = 0.45;
const MAX_REASONING_CALIBRATION_FACTOR = 1.45;

export type DurationSource =
  | "openrouter_latency"
  | "openrouter_generation_time"
  | "local";

export type LlmCallMetrics = {
  generationId: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  durationMsLocal: number;
  durationMsFinal: number;
  durationSource: DurationSource;
  recordedAt: number;
  startedAt: number;
  finishedAt: number;
};

export type TextCallResult = {
  text: string;
  generationId?: string;
  metrics?: LlmCallMetrics;
  reasoningTokensEstimated: number;
};

export type VoteCallResult = {
  vote: "A" | "B";
  generationId?: string;
  metrics?: LlmCallMetrics;
};

type OpenRouterGenerationInfo = {
  totalCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  durationMsFinal: number;
  durationSource: DurationSource;
};

type ReasoningCallType = "prompt" | "answer";
type ReasoningCalibrationState = {
  factor: number;
  samples: number;
};

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});
const reasoningCalibrationByKey = new Map<string, ReasoningCalibrationState>();

function getModelChat(model: Model) {
  const effort = parseModelReasoningEffort(model.reasoningEffort);
  if (!effort) {
    return openrouter.chat(model.id, {
      usage: {
        include: true,
      },
    });
  }
  return openrouter.chat(model.id, {
    usage: {
      include: true,
    },
    extraBody: {
      reasoning: { effort },
    },
  });
}

function cleanResponse(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asNonNegativeInt(value: unknown): number {
  const parsed = numberOrNull(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.floor(parsed));
}

function pickTokenCount(primary: unknown, fallback: unknown): number {
  const primaryNumber = numberOrNull(primary);
  if (primaryNumber !== null && primaryNumber >= 0) {
    return asNonNegativeInt(primaryNumber);
  }
  return asNonNegativeInt(fallback);
}

function clampReasoningCalibrationFactor(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REASONING_CALIBRATION_FACTOR;
  return Math.max(
    MIN_REASONING_CALIBRATION_FACTOR,
    Math.min(MAX_REASONING_CALIBRATION_FACTOR, value),
  );
}

function getReasoningCalibrationKey(model: Model, callType: ReasoningCallType): string {
  const effort = parseModelReasoningEffort(model.reasoningEffort) ?? "default";
  return `${model.id}::${effort}::${callType}`;
}

function getReasoningCalibrationFactor(key: string): number {
  return reasoningCalibrationByKey.get(key)?.factor ?? DEFAULT_REASONING_CALIBRATION_FACTOR;
}

function updateReasoningCalibration(
  key: string,
  estimatedRawTokens: number,
  observedTokens: number,
) {
  if (!(estimatedRawTokens > 0) || !(observedTokens > 0)) return;
  const observedFactor = clampReasoningCalibrationFactor(observedTokens / estimatedRawTokens);
  const existing = reasoningCalibrationByKey.get(key);
  if (!existing) {
    reasoningCalibrationByKey.set(key, {
      factor: observedFactor,
      samples: 1,
    });
    return;
  }

  const alpha = existing.samples < 4 ? 0.2 : 0.1;
  const nextFactor = clampReasoningCalibrationFactor(
    existing.factor * (1 - alpha) + observedFactor * alpha,
  );
  reasoningCalibrationByKey.set(key, {
    factor: nextFactor,
    samples: existing.samples + 1,
  });
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function estimateReasoningTokensFromDelta(delta: string): number {
  if (!delta) return 0;

  let latin = 0;
  let digits = 0;
  let whitespace = 0;
  let punctuation = 0;
  let cjk = 0;
  let other = 0;

  for (const char of delta) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) {
      whitespace += 1;
      continue;
    }
    if ((codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122)) {
      latin += 1;
      continue;
    }
    if (codePoint >= 48 && codePoint <= 57) {
      digits += 1;
      continue;
    }
    if (isCjkCodePoint(codePoint)) {
      cjk += 1;
      continue;
    }
    if (/[\p{P}\p{S}]/u.test(char)) {
      punctuation += 1;
      continue;
    }
    other += 1;
  }

  const estimated =
    latin / 4.6 +
    digits / 3.1 +
    cjk * 1.1 +
    punctuation * 0.24 +
    other / 3.5 +
    Math.min(0.9, whitespace * 0.03);

  if (!Number.isFinite(estimated) || estimated <= 0) {
    return 0;
  }
  return Math.max(0.5, estimated);
}

function getProviderUsageReasoningTokens(providerMetadata: unknown): number {
  return asNonNegativeInt(
    (providerMetadata as any)?.openrouter?.usage?.completionTokensDetails?.reasoningTokens,
  );
}

function computeDuration(
  info: any,
  durationMsLocal: number,
): { durationMsFinal: number; durationSource: DurationSource } {
  const latency = numberOrNull(info?.latency);
  if (latency !== null && latency >= 0) {
    return {
      durationMsFinal: Math.max(0, Math.floor(latency)),
      durationSource: "openrouter_latency",
    };
  }

  const generationTime = numberOrNull(info?.generation_time);
  if (generationTime !== null && generationTime >= 0) {
    return {
      durationMsFinal: Math.max(0, Math.floor(generationTime)),
      durationSource: "openrouter_generation_time",
    };
  }

  return {
    durationMsFinal: durationMsLocal,
    durationSource: "local",
  };
}

function parseGenerationInfo(info: any, durationMsLocal: number): OpenRouterGenerationInfo | null {
  const totalCost = numberOrNull(info?.total_cost) ?? numberOrNull(info?.usage);
  if (totalCost === null || totalCost < 0) {
    return null;
  }

  const promptTokens = pickTokenCount(info?.tokens_prompt, info?.usage?.prompt_tokens);
  const completionTokens = pickTokenCount(info?.tokens_completion, info?.usage?.completion_tokens);
  const totalTokens = Math.max(
    asNonNegativeInt(info?.usage?.total_tokens),
    promptTokens + completionTokens,
  );
  const reasoningTokens = Math.max(
    asNonNegativeInt(info?.native_tokens_reasoning),
    asNonNegativeInt(info?.usage?.completion_tokens_details?.reasoning_tokens),
  );
  const { durationMsFinal, durationSource } = computeDuration(info, durationMsLocal);

  return {
    totalCost,
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    durationMsFinal,
    durationSource,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getGenerationLookupKeys(): string[] {
  const keys = [
    process.env.OPENROUTER_ADMIN_API_KEY,
    process.env.OPENROUTER_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(keys)];
}

async function fetchOpenRouterGeneration(generationId: string): Promise<OpenRouterGenerationInfo | null> {
  const apiKeys = getGenerationLookupKeys();
  if (apiKeys.length === 0) return null;

  const url = `${OPENROUTER_BASE_URL}/generation?id=${encodeURIComponent(generationId)}`;

  for (let attempt = 0; attempt < GENERATION_RETRY_DELAYS_MS.length; attempt++) {
    let shouldRetry = false;
    for (const apiKey of apiKeys) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });

        if (response.ok) {
          const payload = (await response.json()) as { data?: unknown } | unknown;
          const info = parseGenerationInfo((payload as any)?.data ?? payload, 0);
          if (info) return info;
          shouldRetry = true;
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          continue;
        }

        if (
          response.status === 404 ||
          response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504
        ) {
          shouldRetry = true;
          continue;
        }

        return null;
      } catch {
        shouldRetry = true;
      }
    }

    if (!shouldRetry) break;
    await sleep(GENERATION_RETRY_DELAYS_MS[attempt]!);
  }

  return null;
}

function withDurationFallback(
  info: OpenRouterGenerationInfo | null,
  durationMsLocal: number,
): OpenRouterGenerationInfo | null {
  if (!info) return null;
  const duration =
    info.durationSource === "local"
      ? {
          durationMsFinal: durationMsLocal,
          durationSource: "local" as const,
        }
      : {
          durationMsFinal: info.durationMsFinal,
          durationSource: info.durationSource,
        };
  return {
    ...info,
    ...duration,
  };
}

function toMetrics(
  generationId: string,
  info: OpenRouterGenerationInfo | null,
  startedAt: number,
  finishedAt: number,
): LlmCallMetrics | undefined {
  const durationMsLocal = Math.max(0, finishedAt - startedAt);
  const normalized = withDurationFallback(info, durationMsLocal);
  if (!normalized) return undefined;

  return {
    generationId,
    costUsd: normalized.totalCost,
    promptTokens: normalized.promptTokens,
    completionTokens: normalized.completionTokens,
    totalTokens: normalized.totalTokens,
    reasoningTokens: normalized.reasoningTokens,
    durationMsLocal,
    durationMsFinal: normalized.durationMsFinal,
    durationSource: normalized.durationSource,
    recordedAt: Date.now(),
    startedAt,
    finishedAt,
  };
}

function buildPromptSystem(): string {
  const examples = shuffle([...ALL_PROMPTS]).slice(0, 80);
  return `Voce e roteirista de comedia para o jogo Quiplash. Gere um unico prompt engracado de preencher lacuna que os jogadores vao tentar responder. O prompt deve ser surpreendente e pensado para render respostas hilarias. Retorne APENAS o texto do prompt, nada alem disso. Mantenha curto (menos de 15 palavras).\n\nUse uma grande VARIEDADE de formatos de prompt. NAO use sempre "A pior coisa para..." - varie bastante! Aqui vao exemplos da faixa de estilos:\n\n${examples
    .map((p) => `- ${p}`)
    .join("\n")}\n\nCrie algo ORIGINAL - nao copie estes exemplos.`;
}

type ReasoningProgressReporter = (
  estimatedReasoningTokens: number,
  finalized: boolean,
) => Promise<void> | void;

async function generateTextWithReasoningStream(
  model: Model,
  callType: ReasoningCallType,
  system: string,
  prompt: string,
  onReasoningProgress?: ReasoningProgressReporter,
): Promise<TextCallResult> {
  const startedAt = Date.now();
  let estimatedReasoningTokens = 0;
  let estimatedReasoningTokensRaw = 0;
  const reasoningCalibrationKey = getReasoningCalibrationKey(model, callType);
  const reasoningCalibrationFactor = getReasoningCalibrationFactor(reasoningCalibrationKey);
  let lastFlushedTokens = -1;
  let lastFlushedFinalized = false;
  let lastFlushedAt = 0;

  const flushReasoningProgress = async (force = false, finalized = false) => {
    if (!onReasoningProgress) return;
    const now = Date.now();
    if (!force) {
      if (estimatedReasoningTokens === lastFlushedTokens) return;
      if (now - lastFlushedAt < 1_000) return;
    } else if (
      estimatedReasoningTokens === lastFlushedTokens &&
      finalized === lastFlushedFinalized
    ) {
      return;
    }
    lastFlushedAt = now;
    lastFlushedTokens = estimatedReasoningTokens;
    lastFlushedFinalized = finalized;
    await onReasoningProgress(estimatedReasoningTokens, finalized);
  };

  const result = streamText({
    model: getModelChat(model),
    system,
    prompt,
    timeout: MODEL_CALL_TIMEOUT_MS,
    maxRetries: MODEL_ATTEMPTS - 1,
    onChunk: async ({ chunk }) => {
      if (chunk.type !== "reasoning-delta") return;
      estimatedReasoningTokensRaw += estimateReasoningTokensFromDelta(chunk.text);
      estimatedReasoningTokens = Math.max(
        estimatedReasoningTokens,
        Math.floor(estimatedReasoningTokensRaw * reasoningCalibrationFactor),
      );
      await flushReasoningProgress(false, false);
    },
  });

  const responsePromise = Promise.resolve(result.response);
  const providerMetadataPromise = Promise.resolve(result.providerMetadata).catch(() => undefined);
  const generationInfoPromise = responsePromise
    .then((response) =>
      response.id ? fetchOpenRouterGeneration(response.id) : null,
    )
    .catch(() => null);
  const [textRaw, response, providerMetadata] = await Promise.all([
    result.text,
    responsePromise,
    providerMetadataPromise,
  ]);
  const finishedAt = Date.now();
  const text = cleanResponse(textRaw);
  const generationId = response.id;

  const providerReasoningTokens = getProviderUsageReasoningTokens(providerMetadata);
  if (providerReasoningTokens > 0) {
    estimatedReasoningTokens = Math.max(estimatedReasoningTokens, providerReasoningTokens);
    await flushReasoningProgress(true, true);
  }

  if (!generationId) {
    await flushReasoningProgress(true, true);
    return {
      text,
      reasoningTokensEstimated: estimatedReasoningTokens,
    };
  }

  const info = await generationInfoPromise;
  const metrics = toMetrics(generationId, info, startedAt, finishedAt);
  if (metrics) {
    estimatedReasoningTokens = Math.max(
      estimatedReasoningTokens,
      metrics.reasoningTokens,
    );
    updateReasoningCalibration(
      reasoningCalibrationKey,
      estimatedReasoningTokensRaw,
      metrics.reasoningTokens,
    );
  } else if (providerReasoningTokens > 0) {
    updateReasoningCalibration(
      reasoningCalibrationKey,
      estimatedReasoningTokensRaw,
      providerReasoningTokens,
    );
  }
  await flushReasoningProgress(true, true);

  return {
    text,
    generationId,
    metrics,
    reasoningTokensEstimated: estimatedReasoningTokens,
  };
}

export async function callGeneratePrompt(
  model: Model,
  onReasoningProgress?: ReasoningProgressReporter,
): Promise<TextCallResult> {
  const result = await generateTextWithReasoningStream(
    model,
    "prompt",
    buildPromptSystem(),
    "Gere um unico prompt original de Quiplash. Seja criativo e nao repita padroes comuns.",
    onReasoningProgress,
  );

  if (result.text.trim().length < 10) {
    throw new Error("Prompt generation returned an invalid text.");
  }

  return result;
}

export async function callGenerateAnswer(
  model: Model,
  prompt: string,
  onReasoningProgress?: ReasoningProgressReporter,
): Promise<TextCallResult> {
  const result = await generateTextWithReasoningStream(
    model,
    "answer",
    "You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer - no quotes, no explanation, no preamble. Keep it short (under 12 words).",
    `Fill in the blank: ${prompt}`,
    onReasoningProgress,
  );

  if (result.text.trim().length < 3) {
    throw new Error("Answer generation returned an invalid text.");
  }

  return result;
}

export async function callVote(
  voter: Model,
  prompt: string,
  a: { answer: string },
  b: { answer: string },
): Promise<VoteCallResult> {
  const startedAt = Date.now();
  const result = await generateText({
    model: getModelChat(voter),
    system:
      "You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly \"A\" or \"B\".",
    prompt: `Prompt: "${prompt}"\n\nAnswer A: "${a.answer}"\nAnswer B: "${b.answer}"\n\nWhich is funnier? Reply with just A or B.`,
    timeout: MODEL_CALL_TIMEOUT_MS,
    maxRetries: MODEL_ATTEMPTS - 1,
  });
  const finishedAt = Date.now();

  const cleaned = result.text.trim().toUpperCase();
  if (!cleaned.startsWith("A") && !cleaned.startsWith("B")) {
    throw new Error(`Invalid vote: ${result.text.trim()}`);
  }
  const vote: "A" | "B" = cleaned.startsWith("A") ? "A" : "B";

  const generationId = result.response.id;
  if (!generationId) {
    return { vote };
  }
  const info = await fetchOpenRouterGeneration(generationId);
  const metrics = toMetrics(generationId, info, startedAt, finishedAt);

  return {
    vote,
    generationId,
    metrics,
  };
}
