import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  AVAILABLE_MODEL_LOGO_IDS,
  DEFAULT_MODEL_REASONING_EFFORT,
  isValidModelLogoId,
  parseModelReasoningEffort,
  normalizeHexColor,
  toRuntimeModel,
  type Model,
  type ModelCatalogEntry,
} from "../shared/models";
import { getOrCreateEngineState } from "./state";

export const MIN_ACTIVE_MODELS = 3;

export type RunBlockedReason = "insufficient_active_models" | null;

type SeedModel = Pick<
  ModelCatalogEntry,
  "modelId" | "name" | "color" | "logoId" | "reasoningEffort" | "enabled" | "metricsEpoch"
>;

const reasoningEffortValidator = v.union(
  v.literal("xhigh"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("minimal"),
  v.literal("none"),
);
const reasoningEffortInputValidator = v.union(reasoningEffortValidator, v.null());

const LEGACY_MODEL_SEED: SeedModel[] = [
  {
    modelId: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    color: "#4285F4",
    logoId: "gemini",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "moonshotai/kimi-k2-0905",
    name: "Kimi K2",
    color: "#00E599",
    logoId: "kimi",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "deepseek/deepseek-v3.2",
    name: "DeepSeek 3.2",
    color: "#4D6BFE",
    logoId: "deepseek",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "minimax/minimax-m2.5",
    name: "MiniMax 2.5",
    color: "#FF3B30",
    logoId: "minimax",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "z-ai/glm-5",
    name: "GLM-5",
    color: "#1F63EC",
    logoId: "glm",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "openai/gpt-5.2",
    name: "GPT-5.2",
    color: "#10A37F",
    logoId: "openai",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "anthropic/claude-sonnet-4.6",
    name: "Sonnet 4.6",
    color: "#D97757",
    logoId: "claude",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
  {
    modelId: "x-ai/grok-4.1-fast",
    name: "Grok 4.1",
    color: "#FFFFFF",
    logoId: "grok",
    reasoningEffort: "medium",
    metricsEpoch: 1,
    enabled: true,
  },
];

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function trimRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} vazio.`);
  return trimmed;
}

function toCatalogEntry(row: any): ModelCatalogEntry {
  return {
    _id: row._id,
    modelId: row.modelId,
    name: row.name,
    color: normalizeHexColor(row.color),
    logoId: row.logoId,
    reasoningEffort: parseModelReasoningEffort(row.reasoningEffort),
    metricsEpoch: Number.isFinite(row.metricsEpoch) ? row.metricsEpoch : 1,
    enabled: Boolean(row.enabled),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sortCatalog(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [...models].sort((a, b) => {
    const aArchived = a.archivedAt ? 1 : 0;
    const bArchived = b.archivedAt ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    return a.name.localeCompare(b.name);
  });
}

export function getEnabledModelIds(models: ModelCatalogEntry[]): string[] {
  return models
    .filter((model) => model.enabled && !model.archivedAt)
    .map((model) => model.modelId);
}

export function computeRunStatus(models: ModelCatalogEntry[]): {
  activeModelCount: number;
  canRunRounds: boolean;
  runBlockedReason: RunBlockedReason;
} {
  const activeModelCount = getEnabledModelIds(models).length;
  const canRunRounds = activeModelCount >= MIN_ACTIVE_MODELS;
  return {
    activeModelCount,
    canRunRounds,
    runBlockedReason: canRunRounds ? null : "insufficient_active_models",
  };
}

export async function listModelCatalog(ctx: { db: any }): Promise<ModelCatalogEntry[]> {
  const rows = await ctx.db.query("models").collect();
  return sortCatalog(rows.map(toCatalogEntry));
}

async function syncEngineEnabledModelIds(ctx: { db: any }, models: ModelCatalogEntry[]) {
  const state = await getOrCreateEngineState(ctx as any);
  await ctx.db.patch(state._id, {
    enabledModelIds: getEnabledModelIds(models),
    updatedAt: Date.now(),
  });
}

export async function ensureModelCatalogSeededImpl(ctx: { db: any }): Promise<ModelCatalogEntry[]> {
  const existing = await ctx.db.query("models").collect();
  if (existing.length > 0) {
    const now = Date.now();
    await Promise.all(
      existing.map(async (row: any) => {
        if (!Number.isFinite(row.metricsEpoch)) {
          await ctx.db.patch(row._id, { metricsEpoch: 1, updatedAt: now });
        }
      }),
    );
    const updated = await ctx.db.query("models").collect();
    return sortCatalog(updated.map(toCatalogEntry));
  }

  const now = Date.now();
  for (const model of LEGACY_MODEL_SEED) {
    await ctx.db.insert("models", {
      modelId: model.modelId,
      name: model.name,
      color: model.color,
      logoId: model.logoId,
      reasoningEffort: model.reasoningEffort,
      metricsEpoch: model.metricsEpoch,
      enabled: model.enabled,
      createdAt: now,
      updatedAt: now,
    });
  }

  const inserted = await ctx.db.query("models").collect();
  return sortCatalog(inserted.map(toCatalogEntry));
}

function assertLogoId(logoId: string): asserts logoId is (typeof AVAILABLE_MODEL_LOGO_IDS)[number] {
  if (!isValidModelLogoId(logoId)) {
    throw new Error("Logo invalida.");
  }
}

function buildModelMutationResponse(models: ModelCatalogEntry[]) {
  return {
    models,
    enabledModelIds: getEnabledModelIds(models),
    ...computeRunStatus(models),
  };
}

export const ensureModelCatalogSeeded = internalMutation({
  args: {},
  returns: v.object({
    seeded: v.boolean(),
    count: v.number(),
  }),
  handler: async (ctx) => {
    const before = await ctx.db.query("models").collect();
    const models = await ensureModelCatalogSeededImpl(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return {
      seeded: before.length === 0,
      count: models.length,
    };
  },
});

export const listModels = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const models = await listModelCatalog(ctx as any);
    return models;
  },
});

export const listActiveForRuntime = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      color: v.optional(v.string()),
      logoId: v.optional(v.string()),
      reasoningEffort: v.optional(reasoningEffortValidator),
      metricsEpoch: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const models = await listModelCatalog(ctx as any);
    return models
      .filter((model) => model.enabled && !model.archivedAt)
      .map((model) => toRuntimeModel(model));
  },
});

export const createModel = internalMutation({
  args: {
    modelId: v.string(),
    name: v.string(),
    color: v.string(),
    logoId: v.string(),
    reasoningEffort: v.optional(reasoningEffortInputValidator),
    enabled: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const modelId = trimRequired(args.modelId, "modelId");
    const name = trimRequired(args.name, "name");
    const color = trimRequired(args.color, "color");
    const logoId = trimRequired(args.logoId, "logoId");
    const reasoningEffort =
      args.reasoningEffort === null
        ? undefined
        : parseModelReasoningEffort(args.reasoningEffort) ?? DEFAULT_MODEL_REASONING_EFFORT;
    assertLogoId(logoId);
    if (!isHexColor(color)) {
      throw new Error("Cor invalida. Use formato #RRGGBB.");
    }

    const existingById = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", modelId))
      .first();

    const existingByName = await ctx.db
      .query("models")
      .withIndex("by_name", (q: any) => q.eq("name", name))
      .first();

    if (existingById && existingByName && existingByName._id !== existingById._id) {
      throw new Error("Nome ja esta em uso.");
    }

    const now = Date.now();
    if (existingById) {
      if (!existingById.archivedAt) {
        throw new Error("Modelo ja existe.");
      }
      await ctx.db.patch(existingById._id, {
        name,
        color: normalizeHexColor(color),
        logoId,
        reasoningEffort,
        metricsEpoch: Number.isFinite(existingById.metricsEpoch)
          ? existingById.metricsEpoch
          : 1,
        enabled: args.enabled ?? true,
        archivedAt: undefined,
        updatedAt: now,
      });
    } else {
      if (existingByName) {
        throw new Error("Nome ja esta em uso.");
      }
      await ctx.db.insert("models", {
        modelId,
        name,
        color: normalizeHexColor(color),
        logoId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        metricsEpoch: 1,
        enabled: args.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const models = await listModelCatalog(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return buildModelMutationResponse(models);
  },
});

export const setModelEnabled = internalMutation({
  args: {
    modelId: v.string(),
    enabled: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const modelId = trimRequired(args.modelId, "modelId");
    const existing = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", modelId))
      .first();
    if (!existing || existing.archivedAt) {
      throw new Error("Modelo invalido.");
    }

    await ctx.db.patch(existing._id, {
      enabled: args.enabled,
      updatedAt: Date.now(),
    });

    const models = await listModelCatalog(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return buildModelMutationResponse(models);
  },
});

export const archiveModel = internalMutation({
  args: {
    modelId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const modelId = trimRequired(args.modelId, "modelId");
    const existing = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", modelId))
      .first();
    if (!existing) {
      throw new Error("Modelo nao encontrado.");
    }

    if (!existing.archivedAt) {
      await ctx.db.patch(existing._id, {
        enabled: false,
        archivedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const models = await listModelCatalog(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return buildModelMutationResponse(models);
  },
});

export const restoreModel = internalMutation({
  args: {
    modelId: v.string(),
    enabled: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const modelId = trimRequired(args.modelId, "modelId");
    const existing = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", modelId))
      .first();
    if (!existing) {
      throw new Error("Modelo nao encontrado.");
    }
    if (!existing.archivedAt) {
      throw new Error("Modelo nao esta arquivado.");
    }

    await ctx.db.patch(existing._id, {
      archivedAt: undefined,
      enabled: args.enabled ?? true,
      updatedAt: Date.now(),
    });

    const models = await listModelCatalog(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return buildModelMutationResponse(models);
  },
});

export const updateModel = internalMutation({
  args: {
    originalModelId: v.string(),
    modelId: v.string(),
    name: v.string(),
    color: v.string(),
    logoId: v.string(),
    reasoningEffort: v.optional(reasoningEffortInputValidator),
    enabled: v.boolean(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const originalModelId = trimRequired(args.originalModelId, "originalModelId");
    const modelId = trimRequired(args.modelId, "modelId");
    const name = trimRequired(args.name, "name");
    const color = trimRequired(args.color, "color");
    const logoId = trimRequired(args.logoId, "logoId");
    assertLogoId(logoId);
    if (!isHexColor(color)) {
      throw new Error("Cor invalida. Use formato #RRGGBB.");
    }

    const existing = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", originalModelId))
      .first();
    if (!existing) {
      throw new Error("Modelo nao encontrado.");
    }
    if (existing.archivedAt) {
      throw new Error("Modelo arquivado nao pode ser editado.");
    }

    const existingReasoningEffort = parseModelReasoningEffort(existing.reasoningEffort);
    const reasoningEffort =
      args.reasoningEffort === undefined
        ? existingReasoningEffort
        : args.reasoningEffort === null
          ? undefined
          : parseModelReasoningEffort(args.reasoningEffort);

    const existingById = await ctx.db
      .query("models")
      .withIndex("by_modelId", (q: any) => q.eq("modelId", modelId))
      .first();
    if (existingById && existingById._id !== existing._id) {
      throw new Error("modelId ja esta em uso.");
    }

    const existingByName = await ctx.db
      .query("models")
      .withIndex("by_name", (q: any) => q.eq("name", name))
      .first();
    if (existingByName && existingByName._id !== existing._id) {
      throw new Error("Nome ja esta em uso.");
    }
    const currentEpoch = Number.isFinite(existing.metricsEpoch)
      ? Number(existing.metricsEpoch)
      : 1;

    await ctx.db.patch(existing._id, {
      modelId,
      name,
      color: normalizeHexColor(color),
      logoId,
      reasoningEffort,
      metricsEpoch:
        modelId !== existing.modelId || reasoningEffort !== existingReasoningEffort
          ? currentEpoch + 1
          : currentEpoch,
      enabled: args.enabled,
      updatedAt: Date.now(),
    });

    const models = await listModelCatalog(ctx as any);
    await syncEngineEnabledModelIds(ctx as any, models);
    return buildModelMutationResponse(models);
  },
});
