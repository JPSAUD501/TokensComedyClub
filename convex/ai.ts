"use node";

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ALL_PROMPTS } from "../prompts";
import { normalizeModelReasoningEffort, type Model } from "../shared/models";
import {
  MODEL_ATTEMPTS,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_RETRY_BACKOFF_MS,
  sleep,
  shuffle,
} from "./constants";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

function getModelChat(model: Model) {
  const effort = normalizeModelReasoningEffort(model.reasoningEffort);
  if (effort === "none") {
    return openrouter.chat(model.id);
  }
  return openrouter.chat(model.id, {
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

function isRealString(s: string, minLength = 5): boolean {
  return s.length >= minLength;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  attempts = MODEL_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fn();
      if (validate(result)) return result;
      lastErr = new Error("validation failed");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts - 1) {
      const backoffMs =
        MODEL_RETRY_BACKOFF_MS[Math.min(attempt, MODEL_RETRY_BACKOFF_MS.length - 1)] ?? 0;
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

function buildPromptSystem(): string {
  const examples = shuffle([...ALL_PROMPTS]).slice(0, 80);
  return `Voce e roteirista de comedia para o jogo Quiplash. Gere um unico prompt engracado de preencher lacuna que os jogadores vao tentar responder. O prompt deve ser surpreendente e pensado para render respostas hilarias. Retorne APENAS o texto do prompt, nada alem disso. Mantenha curto (menos de 15 palavras).\n\nUse uma grande VARIEDADE de formatos de prompt. NAO use sempre "A pior coisa para..." - varie bastante! Aqui vao exemplos da faixa de estilos:\n\n${examples
    .map((p) => `- ${p}`)
    .join("\n")}\n\nCrie algo ORIGINAL - nao copie estes exemplos.`;
}

export async function callGeneratePrompt(model: Model): Promise<string> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: getModelChat(model),
        system: buildPromptSystem(),
        prompt:
          "Gere um unico prompt original de Quiplash. Seja criativo e nao repita padroes comuns.",
        timeout: MODEL_CALL_TIMEOUT_MS,
        maxRetries: 0,
      });
      return cleanResponse(text);
    },
    (s) => isRealString(s, 10),
    MODEL_ATTEMPTS,
  );
}

export async function callGenerateAnswer(model: Model, prompt: string): Promise<string> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: getModelChat(model),
        system:
          "You are playing Quiplash! You'll be given a fill-in-the-blank prompt. Give the FUNNIEST possible answer. Be creative, edgy, unexpected, and concise. Reply with ONLY your answer - no quotes, no explanation, no preamble. Keep it short (under 12 words).",
        prompt: `Fill in the blank: ${prompt}`,
        timeout: MODEL_CALL_TIMEOUT_MS,
        maxRetries: 0,
      });
      return cleanResponse(text);
    },
    (s) => isRealString(s, 3),
    1,
  );
}

export async function callVote(
  voter: Model,
  prompt: string,
  a: { answer: string },
  b: { answer: string },
): Promise<"A" | "B"> {
  return withRetry(
    async () => {
      const { text } = await generateText({
        model: getModelChat(voter),
        system:
          "You are a judge in a comedy game. You'll see a fill-in-the-blank prompt and two answers. Pick which answer is FUNNIER. You MUST respond with exactly \"A\" or \"B\".",
        prompt: `Prompt: \"${prompt}\"\n\nAnswer A: \"${a.answer}\"\nAnswer B: \"${b.answer}\"\n\nWhich is funnier? Reply with just A or B.`,
        timeout: MODEL_CALL_TIMEOUT_MS,
        maxRetries: 0,
      });

      const cleaned = text.trim().toUpperCase();
      if (!cleaned.startsWith("A") && !cleaned.startsWith("B")) {
        throw new Error(`Invalid vote: ${text.trim()}`);
      }
      return cleaned.startsWith("A") ? "A" : "B";
    },
    (v) => v === "A" || v === "B",
    MODEL_ATTEMPTS,
  );
}
