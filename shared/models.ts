export const AVAILABLE_MODEL_LOGO_IDS = [
  "claude",
  "deepseek",
  "gemini",
  "glm",
  "grok",
  "kimi",
  "minimax",
  "openai",
  "qwen",
  "xiaomi",
] as const;

export const AVAILABLE_REASONING_EFFORTS = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;
export const REASONING_EFFORT_UNDEFINED = "undefined" as const;

export const AVAILABLE_MODEL_COLORS = [
  "#10A37F",
  "#14B8A6",
  "#06B6D4",
  "#0EA5E9",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#A855F7",
  "#D946EF",
  "#EC4899",
  "#F43F5E",
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#16A34A",
  "#10B981",
  "#2DD4BF",
  "#38BDF8",
  "#60A5FA",
  "#F87171",
  "#FB7185",
] as const;

export type ModelLogoId = (typeof AVAILABLE_MODEL_LOGO_IDS)[number];
export type ModelReasoningEffort = (typeof AVAILABLE_REASONING_EFFORTS)[number];

export type Model = {
  id: string;
  name: string;
  color?: string;
  logoId?: ModelLogoId;
  reasoningEffort?: ModelReasoningEffort;
  metricsEpoch?: number;
};

export type ModelCatalogEntry = {
  _id?: string;
  modelId: string;
  name: string;
  color: string;
  logoId: ModelLogoId;
  reasoningEffort?: ModelReasoningEffort;
  metricsEpoch: number;
  enabled: boolean;
  archivedAt?: number;
  createdAt?: number;
  updatedAt?: number;
};

export const DEFAULT_MODEL_COLOR = "#A1A1A1";
export const DEFAULT_MODEL_REASONING_EFFORT: ModelReasoningEffort = "medium";

const LOGO_ID_SET = new Set<string>(AVAILABLE_MODEL_LOGO_IDS);
const REASONING_EFFORT_SET = new Set<string>(AVAILABLE_REASONING_EFFORTS);

export function isValidModelLogoId(value: string): value is ModelLogoId {
  return LOGO_ID_SET.has(value);
}

export function isValidModelReasoningEffort(value: string): value is ModelReasoningEffort {
  return REASONING_EFFORT_SET.has(value);
}

export function getLogoUrlById(logoId?: string | null): string | null {
  if (!logoId || !isValidModelLogoId(logoId)) return null;
  return `/assets/logos/${logoId}.svg`;
}

export function normalizeModelReasoningEffort(input?: string | null): ModelReasoningEffort {
  const parsed = parseModelReasoningEffort(input);
  if (parsed) return parsed;
  return DEFAULT_MODEL_REASONING_EFFORT;
}

export function parseModelReasoningEffort(
  input?: string | null,
): ModelReasoningEffort | undefined {
  const value = (input ?? "").trim().toLowerCase();
  if (isValidModelReasoningEffort(value)) {
    return value;
  }
  return undefined;
}

export function normalizeHexColor(input?: string | null): string {
  const value = (input ?? "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toUpperCase();
  }
  return DEFAULT_MODEL_COLOR;
}

export function toRuntimeModel(
  entry: Pick<
    ModelCatalogEntry,
    "modelId" | "name" | "color" | "logoId" | "reasoningEffort" | "metricsEpoch"
  >,
): Model {
  return {
    id: entry.modelId,
    name: entry.name,
    color: normalizeHexColor(entry.color),
    logoId: entry.logoId,
    reasoningEffort: parseModelReasoningEffort(entry.reasoningEffort),
    metricsEpoch: Number.isFinite(entry.metricsEpoch) ? entry.metricsEpoch : 1,
  };
}
