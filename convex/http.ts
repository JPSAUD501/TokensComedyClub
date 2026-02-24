import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  isValidModelReasoningEffort,
  parseModelReasoningEffort,
} from "../shared/models";
const convexInternal = internal as any;

const http = httpRouter();

function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return ["*"];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request): Record<string, string> {
  const allowed = getAllowedOrigins();
  const origin = request.headers.get("origin") ?? "";
  const allowOrigin =
    allowed.includes("*") || (origin && allowed.includes(origin)) ? origin || "*" : allowed[0] || "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,x-admin-passcode,x-fossabot-token,x-fossabot-validateurl,x-fossabot-message-userprovider,x-fossabot-message-userproviderid,x-fossabot-message-userlogin",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

function text(request: Request, body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(request),
    },
  });
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return false;
  const provided = request.headers.get("x-admin-passcode") ?? "";
  return Boolean(provided) && provided === expected;
}

function parseVote(raw: string | null): "A" | "B" | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "1" || value === "A") return "A";
  if (value === "2" || value === "B") return "B";
  return null;
}

function getFossabotViewerId(request: Request): string | null {
  const provider = (request.headers.get("x-fossabot-message-userprovider") ?? "").trim().toLowerCase();
  const providerId = (request.headers.get("x-fossabot-message-userproviderid") ?? "").trim();
  if (!provider || !providerId) return null;
  return `${provider}:${providerId}`;
}

async function validateFossabotRequest(request: Request): Promise<boolean> {
  const enabled = (process.env.FOSSABOT_VALIDATE_REQUESTS ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "off") {
    return true;
  }

  const headerValidateUrl = (request.headers.get("x-fossabot-validateurl") ?? "").trim();
  const token = (request.headers.get("x-fossabot-token") ?? "").trim();
  const validateUrl = headerValidateUrl || (token ? `https://api.fossabot.com/v2/customapi/validate/${token}` : "");
  if (!validateUrl) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(validateUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function withOptions(handler: (ctx: any, request: Request) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }
    return handler(ctx, request);
  });
}

async function getModelsWithUsage(ctx: any) {
  const models = await ctx.runQuery(convexInternal.models.listModels, {});
  const usage = await ctx.runQuery(convexInternal.usage.getAdminModelUsageAverages, {});
  return {
    models,
    usageByModel: usage.usageByModel ?? {},
    usageHourlyByModel: usage.usageHourlyByModel ?? {},
    usageWindowSize: usage.usageWindowSize ?? 50,
    activeModelsAvgCostPerHourUsd: usage.activeModelsAvgCostPerHourUsd ?? null,
    activeModelsHourlyShareByModel: usage.activeModelsHourlyShareByModel ?? {},
  };
}

for (const path of [
  "/admin/login",
  "/admin/viewer-targets",
  "/admin/viewer-targets/delete",
  "/admin/status",
  "/admin/models",
  "/admin/models/update",
  "/admin/models/enable",
  "/admin/models/remove",
  "/admin/models/restore",
  "/admin/pause",
  "/admin/resume",
  "/admin/reset",
  "/admin/export",
  "/fossabot/vote",
]) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async (_ctx, request) => {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }),
  });
}

http.route({
  path: "/admin/login",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Invalid passcode", 401);
    }

    await ctx.runMutation(convexInternal.live.ensureStartedInternal, {});
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...snapshot });
  }),
});

http.route({
  path: "/admin/viewer-targets",
  method: "GET",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    const targets = await ctx.runQuery(convexInternal.admin.listViewerTargets, {});
    return json(request, { ok: true, targets });
  }),
});

http.route({
  path: "/admin/viewer-targets",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as {
      id?: string;
      platform?: "twitch" | "youtube";
      target?: string;
      enabled?: boolean;
    };

    if (payload.platform !== "twitch" && payload.platform !== "youtube") {
      return text(request, "Invalid platform", 400);
    }

    if (typeof payload.target !== "string" || !payload.target.trim()) {
      return text(request, "Invalid target", 400);
    }

    try {
      await ctx.runMutation(convexInternal.admin.upsertViewerTarget, {
        id: payload.id,
        platform: payload.platform,
        target: payload.target,
        enabled: payload.enabled !== false,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to save target", 400);
    }

    const targets = await ctx.runQuery(convexInternal.admin.listViewerTargets, {});
    return json(request, { ok: true, targets });
  }),
});

http.route({
  path: "/admin/viewer-targets/delete",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as { id?: string };
    if (typeof payload.id !== "string" || !payload.id) {
      return text(request, "Invalid id", 400);
    }

    try {
      await ctx.runMutation(convexInternal.admin.deleteViewerTarget, {
        id: payload.id,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to delete target", 400);
    }

    const targets = await ctx.runQuery(convexInternal.admin.listViewerTargets, {});
    return json(request, { ok: true, targets });
  }),
});

http.route({
  path: "/admin/status",
  method: "GET",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...snapshot });
  }),
});

http.route({
  path: "/admin/models",
  method: "GET",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});
    const payload = await getModelsWithUsage(ctx);
    return json(request, { ok: true, ...payload });
  }),
});

http.route({
  path: "/admin/models",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }

    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as {
      modelId?: string;
      name?: string;
      color?: string;
      logoId?: string;
      reasoningEffort?: string | null;
      enabled?: boolean;
    };
    if (typeof payload.modelId !== "string" || !payload.modelId.trim()) {
      return text(request, "Invalid modelId", 400);
    }
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      return text(request, "Invalid name", 400);
    }
    if (typeof payload.color !== "string" || !payload.color.trim()) {
      return text(request, "Invalid color", 400);
    }
    if (typeof payload.logoId !== "string" || !payload.logoId.trim()) {
      return text(request, "Invalid logoId", 400);
    }
    if (
      payload.reasoningEffort !== undefined &&
      payload.reasoningEffort !== null &&
      (typeof payload.reasoningEffort !== "string" ||
        !isValidModelReasoningEffort(payload.reasoningEffort.trim().toLowerCase()))
    ) {
      return text(request, "Invalid reasoningEffort", 400);
    }

    try {
      await ctx.runMutation(convexInternal.models.createModel, {
        modelId: payload.modelId.trim(),
        name: payload.name.trim(),
        color: payload.color.trim(),
        logoId: payload.logoId.trim(),
        reasoningEffort:
          payload.reasoningEffort === null
            ? null
            : typeof payload.reasoningEffort === "string"
              ? parseModelReasoningEffort(payload.reasoningEffort)
              : undefined,
        enabled: payload.enabled !== false,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to create model", 400);
    }

    const modelsPayload = await getModelsWithUsage(ctx);
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...modelsPayload, ...snapshot });
  }),
});

http.route({
  path: "/admin/models/update",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }

    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as {
      originalModelId?: string;
      modelId?: string;
      name?: string;
      color?: string;
      logoId?: string;
      reasoningEffort?: string | null;
      enabled?: boolean;
    };

    if (typeof payload.originalModelId !== "string" || !payload.originalModelId.trim()) {
      return text(request, "Invalid originalModelId", 400);
    }
    if (typeof payload.modelId !== "string" || !payload.modelId.trim()) {
      return text(request, "Invalid modelId", 400);
    }
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      return text(request, "Invalid name", 400);
    }
    if (typeof payload.color !== "string" || !payload.color.trim()) {
      return text(request, "Invalid color", 400);
    }
    if (typeof payload.logoId !== "string" || !payload.logoId.trim()) {
      return text(request, "Invalid logoId", 400);
    }
    if (
      payload.reasoningEffort !== undefined &&
      payload.reasoningEffort !== null &&
      (typeof payload.reasoningEffort !== "string" ||
        !isValidModelReasoningEffort(payload.reasoningEffort.trim().toLowerCase()))
    ) {
      return text(request, "Invalid reasoningEffort", 400);
    }
    if (typeof payload.enabled !== "boolean") {
      return text(request, "Invalid enabled", 400);
    }

    try {
      await ctx.runMutation(convexInternal.models.updateModel, {
        originalModelId: payload.originalModelId.trim(),
        modelId: payload.modelId.trim(),
        name: payload.name.trim(),
        color: payload.color.trim(),
        logoId: payload.logoId.trim(),
        reasoningEffort:
          payload.reasoningEffort === null
            ? null
            : typeof payload.reasoningEffort === "string"
              ? parseModelReasoningEffort(payload.reasoningEffort)
              : undefined,
        enabled: payload.enabled,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to update model", 400);
    }

    const modelsPayload = await getModelsWithUsage(ctx);
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...modelsPayload, ...snapshot });
  }),
});

http.route({
  path: "/admin/models/enable",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as { modelId?: string; enabled?: boolean };
    if (typeof payload.modelId !== "string" || !payload.modelId.trim()) {
      return text(request, "Invalid modelId", 400);
    }
    if (typeof payload.enabled !== "boolean") {
      return text(request, "Invalid enabled", 400);
    }

    try {
      await ctx.runMutation(convexInternal.models.setModelEnabled, {
        modelId: payload.modelId.trim(),
        enabled: payload.enabled,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to update model", 400);
    }

    const modelsPayload = await getModelsWithUsage(ctx);
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...modelsPayload, ...snapshot });
  }),
});

http.route({
  path: "/admin/models/remove",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as { modelId?: string };
    if (typeof payload.modelId !== "string" || !payload.modelId.trim()) {
      return text(request, "Invalid modelId", 400);
    }

    try {
      await ctx.runMutation(convexInternal.models.archiveModel, {
        modelId: payload.modelId.trim(),
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to remove model", 400);
    }

    const modelsPayload = await getModelsWithUsage(ctx);
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...modelsPayload, ...snapshot });
  }),
});

http.route({
  path: "/admin/models/restore",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.models.ensureModelCatalogSeeded, {});

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return text(request, "Invalid JSON", 400);
    }

    const payload = body as { modelId?: string; enabled?: boolean };
    if (typeof payload.modelId !== "string" || !payload.modelId.trim()) {
      return text(request, "Invalid modelId", 400);
    }

    try {
      await ctx.runMutation(convexInternal.models.restoreModel, {
        modelId: payload.modelId.trim(),
        enabled: payload.enabled,
      });
    } catch (error) {
      return text(request, error instanceof Error ? error.message : "Failed to restore model", 400);
    }

    const modelsPayload = await getModelsWithUsage(ctx);
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...modelsPayload, ...snapshot });
  }),
});

http.route({
  path: "/admin/pause",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.admin.pause, {});
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, action: "Paused", ...snapshot });
  }),
});

http.route({
  path: "/admin/resume",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.admin.resume, {});
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, action: "Resumed", ...snapshot });
  }),
});

http.route({
  path: "/admin/reset",
  method: "POST",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }
    await ctx.runMutation(convexInternal.admin.reset, {});
    const snapshot = await ctx.runMutation(convexInternal.admin.getSnapshot, {});
    return json(request, { ok: true, ...snapshot });
  }),
});

http.route({
  path: "/admin/export",
  method: "GET",
  handler: withOptions(async (ctx, request) => {
    if (!isAuthorized(request)) {
      return text(request, "Unauthorized", 401);
    }

    const data = await ctx.runQuery(convexInternal.admin.getExportData, {});
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="tokenscomedyclub-export-${Date.now()}.json"`,
        ...corsHeaders(request),
      },
    });
  }),
});

http.route({
  path: "/fossabot/vote",
  method: "GET",
  handler: withOptions(async (ctx, request) => {
    const valid = await validateFossabotRequest(request);
    if (!valid) {
      return text(request, "voto rejeitado", 403);
    }

    const viewerId = getFossabotViewerId(request);
    if (!viewerId) {
      return text(request, "usuario invalido", 400);
    }

    const url = new URL(request.url);
    const side = parseVote(url.searchParams.get("vote"));
    if (!side) {
      return text(request, "vote com 1 ou 2", 400);
    }

    await ctx.runMutation(convexInternal.live.ensureStartedInternal, {});
    const result = await ctx.runMutation(convexInternal.viewers.castVoteInternal, {
      viewerId,
      side,
    });

    if (!result.ok) {
      return text(request, "votacao indisponivel", 200);
    }

    if (result.status === "updated") {
      return text(request, side === "A" ? "voto alterado para 1" : "voto alterado para 2", 200);
    }
    if (result.status === "unchanged") {
      return text(request, side === "A" ? "voto 1 ja registrado" : "voto 2 ja registrado", 200);
    }
    return text(request, side === "A" ? "voto 1 registrado" : "voto 2 registrado", 200);
  }),
});

export default http;

