import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getOrCreateEngineState } from "./state";
import { PROJECTION_BOOTSTRAP_TARGET_SAMPLES } from "./usage";

const convexInternal = internal as any;

const BOOTSTRAP_STALE_MS = 30 * 60_000;

type RequestType = "prompt" | "answer" | "vote";

type SampleCounts = {
  prompt: number;
  answer: number;
  vote: number;
};

type MissingCounts = {
  prompt: number;
  answer: number;
  vote: number;
};

type ProjectionBootstrapStatus = "ready" | "running" | "failed";

type EnsureProjectionBootstrapResult = {
  status: ProjectionBootstrapStatus;
  missingSamplesByModelAction: Record<string, MissingCounts>;
};

function normalizeMetricsEpoch(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 1;
}

function toMissingCounts(counts: SampleCounts): MissingCounts {
  return {
    prompt: Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - counts.prompt),
    answer: Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - counts.answer),
    vote: Math.max(0, PROJECTION_BOOTSTRAP_TARGET_SAMPLES - counts.vote),
  };
}

async function readSampleCount(
  db: any,
  args: {
    generation: number;
    modelId: string;
    modelMetricsEpoch: number;
    requestType: RequestType;
  },
): Promise<number> {
  const rows = await db
    .query("llmUsageEvents")
    .withIndex("by_generation_model_epoch_type_finishedAt", (q: any) =>
      q
        .eq("generation", args.generation)
        .eq("modelId", args.modelId)
        .eq("modelMetricsEpoch", args.modelMetricsEpoch)
        .eq("requestType", args.requestType),
    )
    .order("desc")
    .take(PROJECTION_BOOTSTRAP_TARGET_SAMPLES);
  return rows.length;
}

async function readModelSampleCounts(
  db: any,
  args: {
    generation: number;
    modelId: string;
    modelMetricsEpoch: number;
  },
): Promise<SampleCounts> {
  const [prompt, answer, vote] = await Promise.all([
    readSampleCount(db, { ...args, requestType: "prompt" }),
    readSampleCount(db, { ...args, requestType: "answer" }),
    readSampleCount(db, { ...args, requestType: "vote" }),
  ]);
  return { prompt, answer, vote };
}

async function readMissingByModel(
  db: any,
  generation: number,
): Promise<Record<string, MissingCounts>> {
  const models = await db.query("models").collect();
  const activeModels = models.filter((model: any) => model.enabled && !model.archivedAt);
  const missingByModel: Record<string, MissingCounts> = {};

  for (const model of activeModels) {
    const modelId = String(model.modelId);
    const modelMetricsEpoch = normalizeMetricsEpoch(model.metricsEpoch);
    const counts = await readModelSampleCounts(db, {
      generation,
      modelId,
      modelMetricsEpoch,
    });
    const missing = toMissingCounts(counts);
    if (missing.prompt > 0 || missing.answer > 0 || missing.vote > 0) {
      missingByModel[modelId] = missing;
    }
  }

  return missingByModel;
}

export const getModelBootstrapSampleCounts = internalQuery({
  args: {
    generation: v.number(),
    modelId: v.string(),
    modelMetricsEpoch: v.number(),
  },
  returns: v.object({
    counts: v.object({
      prompt: v.number(),
      answer: v.number(),
      vote: v.number(),
    }),
    missing: v.object({
      prompt: v.number(),
      answer: v.number(),
      vote: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const counts = await readModelSampleCounts(ctx.db, args);
    const missing = toMissingCounts(counts);
    return {
      counts,
      missing,
    };
  },
});

export const ensureProjectionBootstrap = internalMutation({
  args: {},
  returns: v.object({
    status: v.union(v.literal("ready"), v.literal("running"), v.literal("failed")),
    missingSamplesByModelAction: v.record(
      v.string(),
      v.object({
        prompt: v.number(),
        answer: v.number(),
        vote: v.number(),
      }),
    ),
  }),
  handler: async (ctx): Promise<EnsureProjectionBootstrapResult> => {
    const state = await getOrCreateEngineState(ctx as any);
    const now = Date.now();
    const missingByModel = await readMissingByModel(ctx.db, state.generation);
    const hasMissing = Object.keys(missingByModel).length > 0;

    if (!hasMissing) {
      if (state.projectionBootstrapRunning === true || state.projectionBootstrapError) {
        await ctx.db.patch(state._id, {
          projectionBootstrapRunning: false,
          projectionBootstrapRunId: undefined,
          projectionBootstrapStartedAt: undefined,
          projectionBootstrapError: undefined,
          projectionBootstrapFinishedAt: now,
          updatedAt: now,
        });
      }
      return {
        status: "ready",
        missingSamplesByModelAction: {},
      };
    }

    if (state.projectionBootstrapRunning === true) {
      const startedAt = Number(state.projectionBootstrapStartedAt ?? 0);
      if (startedAt > 0 && now - startedAt <= BOOTSTRAP_STALE_MS) {
        return {
          status: "running",
          missingSamplesByModelAction: missingByModel,
        };
      }
    }

    const runId = crypto.randomUUID();
    await ctx.db.patch(state._id, {
      projectionBootstrapRunning: true,
      projectionBootstrapRunId: runId,
      projectionBootstrapStartedAt: now,
      projectionBootstrapError: undefined,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, convexInternal.usageBootstrapRunner.runProjectionBootstrap, {
      runId,
      generation: state.generation,
    });

    return {
      status: "running",
      missingSamplesByModelAction: missingByModel,
    };
  },
});

export const finishProjectionBootstrapRun = internalMutation({
  args: {
    runId: v.string(),
    generation: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await getOrCreateEngineState(ctx as any);
    if (state.generation !== args.generation) return null;
    if (state.projectionBootstrapRunId !== args.runId) return null;

    const now = Date.now();
    await ctx.db.patch(state._id, {
      projectionBootstrapRunning: false,
      projectionBootstrapRunId: undefined,
      projectionBootstrapStartedAt: undefined,
      projectionBootstrapFinishedAt: now,
      projectionBootstrapError: args.error ? args.error.slice(0, 1_000) : undefined,
      updatedAt: now,
    });
    return null;
  },
});
