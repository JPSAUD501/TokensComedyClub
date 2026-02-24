import React, { useEffect, useMemo, useState } from "react";
import {
  AVAILABLE_MODEL_COLORS,
  AVAILABLE_MODEL_LOGO_IDS,
  AVAILABLE_REASONING_EFFORTS,
  DEFAULT_MODEL_REASONING_EFFORT,
  REASONING_EFFORT_UNDEFINED,
  normalizeHexColor,
  type ModelReasoningEffort,
  type ModelCatalogEntry,
} from "./shared/models";
import "./admin.css";

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
  activeModelCount: number;
  canRunRounds: boolean;
  runBlockedReason: "insufficient_active_models" | "insufficient_role_coverage" | null;
  enabledModelIds: string[];
};

type ViewerTarget = {
  _id: string;
  platform: "twitch" | "youtube";
  target: string;
  enabled: boolean;
  viewerCount: number;
  isLive: boolean;
  lastPolledAt?: number;
  lastError?: string;
};

type AdminResponse = { ok: true } & AdminSnapshot;
type ViewerTargetsResponse = { ok: true; targets: ViewerTarget[] };
type TelegramConfig = {
  enabled: boolean;
  channelId: string;
  hasBotToken: boolean;
  tokenPreview: string | null;
  lastPolledAt: number | null;
  lastError: string | null;
};
type TelegramConfigResponse = { ok: true } & TelegramConfig;
type UsageSummary = {
  sampleSize: number;
  denominator: number;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
  avgReasoningTokens: number | null;
  avgTotalTokens: number | null;
};
type HourlyUsageSummary = {
  sampleSize: number;
  totalCostUsd: number;
  windowHours: number | null;
  avgCostPerHourUsd: number | null;
};
type ProjectionTiming = {
  viewerVoteWindowActiveMs: number;
  viewerVoteWindowIdleMs: number;
  postRoundDelayActiveMs: number;
  postRoundDelayIdleMs: number;
};
type ProjectionPayload = {
  timing: ProjectionTiming;
  samples: {
    rounds: number;
    events: number;
    roundCosts: number;
    gaps: number;
  };
  roleCounts: {
    promptCapable: number;
    answerCapable: number;
    voteCapable: number;
  };
  expectedRequestsPerRound: {
    prompt: number;
    answer: number;
    vote: number;
    total: number;
  };
  viewerRoundShare: number;
  confidencePercent: number;
  costs: {
    perRequestUsd: {
      prompt: number;
      answer: number;
      vote: number;
    };
    perRoundUsd: {
      prompt: number;
      answer: number;
      vote: number;
      total: number;
      modeledTotal: number;
      historicalTotal: null;
    };
  };
  timingsMs: {
    nonVoting: number | null;
    voteWindowEffective: number | null;
    postRoundDelayEffective: number | null;
    extraInterRound: number | null;
    roundCycle: number | null;
  };
  rates: {
    roundsPerHour: number | null;
    hourlyCostUsd: number | null;
    promptHourlyUsd: number | null;
    answerHourlyUsd: number | null;
    voteHourlyUsd: number | null;
  };
};
type ProjectionBootstrapPayload = {
  status: "ready" | "running" | "failed";
  running: boolean;
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  requiredSamplesPerAction: number;
  missingSamplesByModelAction: Record<string, { prompt: number; answer: number; vote: number }>;
};
type ModelUsageRow = {
  prompt: UsageSummary;
  answer: UsageSummary;
  vote: UsageSummary;
};
type UsageByModel = Record<string, ModelUsageRow>;
type UsageHourlyByModel = Record<string, HourlyUsageSummary>;
type ModelsResponse = {
  ok: true;
  models: ModelCatalogEntry[];
  usageByModel?: UsageByModel;
  usageHourlyByModel?: UsageHourlyByModel;
  usageWindowSize?: number;
  activeModelsHourlyShareByModel?: Record<string, number>;
  projectionBootstrap?: ProjectionBootstrapPayload | null;
  projection?: ProjectionPayload;
} & Partial<AdminSnapshot>;
type Mode = "checking" | "locked" | "ready";
type AdminPage = "operations" | "models" | "targets" | "projections";
type ModelReasoningEffortFormValue = ModelReasoningEffort | typeof REASONING_EFFORT_UNDEFINED;
type ActionRatios = {
  prompt: number;
  answer: number;
  vote: number;
};
type ModelStatusFilter = "all" | "active" | "inactive" | "archived";
type ModelRoleFilter = "all" | "prompt" | "answer" | "vote";
type ModelSort = "name" | "cost_desc" | "cost_asc" | "recent";

const RESET_TOKEN = "RESET";
const ADMIN_PASSCODE_KEY = "tokenscomedyclub.adminPasscode";
const DEFAULT_REASONING_LABEL = "padrão";
const DEFAULT_ADMIN_PAGE: AdminPage = "operations";
const ADMIN_PAGE_TABS: Array<{ id: AdminPage; label: string; description: string }> = [
  { id: "operations", label: "Operacao", description: "Controle do motor e status da rodada." },
  { id: "models", label: "Modelos", description: "Catalogo, papeis e configuracao dos modelos." },
  { id: "targets", label: "Audiencia", description: "Targets de Twitch/YouTube e Telegram para votacao." },
  { id: "projections", label: "Projecoes", description: "Custos, participacao e simulacao de preco." },
];

function parseAdminPage(value: string | null): AdminPage {
  if (value === "operations" || value === "models" || value === "targets" || value === "projections") {
    return value;
  }
  return DEFAULT_ADMIN_PAGE;
}

function readAdminPageFromLocation(): AdminPage {
  const params = new URLSearchParams(window.location.search);
  return parseAdminPage(params.get("page"));
}

function writeAdminPageToLocation(page: AdminPage) {
  const url = new URL(window.location.href);
  url.searchParams.set("page", page);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function safePositive(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function actionWeight(summary?: UsageSummary): number {
  if (!summary) return 0;
  return safePositive(summary.avgCostUsd) * safePositive(summary.sampleSize);
}

function getActionRatios(usage: ModelUsageRow | undefined, model: ModelCatalogEntry | undefined): ActionRatios {
  const promptWeight = actionWeight(usage?.prompt);
  const answerWeight = actionWeight(usage?.answer);
  const voteWeight = actionWeight(usage?.vote);
  const totalWeight = promptWeight + answerWeight + voteWeight;

  if (totalWeight > 0) {
    return {
      prompt: (promptWeight / totalWeight) * 100,
      answer: (answerWeight / totalWeight) * 100,
      vote: (voteWeight / totalWeight) * 100,
    };
  }

  const fallbackKeys: Array<keyof ActionRatios> = [];
  if (model?.canPrompt !== false) fallbackKeys.push("prompt");
  if (model?.canAnswer !== false) fallbackKeys.push("answer");
  if (model?.canVote !== false) fallbackKeys.push("vote");
  if (fallbackKeys.length === 0) fallbackKeys.push("prompt", "answer", "vote");
  const shared = 100 / fallbackKeys.length;

  return {
    prompt: fallbackKeys.includes("prompt") ? shared : 0,
    answer: fallbackKeys.includes("answer") ? shared : 0,
    vote: fallbackKeys.includes("vote") ? shared : 0,
  };
}

function getConvexSiteUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_CONVEX_SITE_URL?.trim();
  if (!url) throw new Error("VITE_CONVEX_SITE_URL is not configured");
  return url.replace(/\/$/, "");
}

function readStoredPasscode(): string {
  return window.localStorage.getItem(ADMIN_PASSCODE_KEY) ?? "";
}

function writeStoredPasscode(passcode: string) {
  if (!passcode) {
    window.localStorage.removeItem(ADMIN_PASSCODE_KEY);
    return;
  }
  window.localStorage.setItem(ADMIN_PASSCODE_KEY, passcode);
}

function formatLastPolled(lastPolledAt?: number): string {
  if (!lastPolledAt) return "nunca";
  return new Date(lastPolledAt).toLocaleTimeString("pt-BR");
}

function modelMatchesRole(model: ModelCatalogEntry, filter: ModelRoleFilter): boolean {
  if (filter === "all") return true;
  if (filter === "prompt") return model.canPrompt;
  if (filter === "answer") return model.canAnswer;
  if (filter === "vote") return model.canVote;
  return true;
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/D";
  if (value < 0.0001) return "US$0.0000";
  return `US$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

function formatModelSamplesLine(usage: ModelUsageRow | undefined): string {
  const promptSamples = usage?.prompt?.sampleSize ?? 0;
  const answerSamples = usage?.answer?.sampleSize ?? 0;
  const voteSamples = usage?.vote?.sampleSize ?? 0;
  return `Samples: P ${promptSamples} | R ${answerSamples} | V ${voteSamples}`;
}

function formatModelHourlyCostLine(summary?: HourlyUsageSummary): string {
  const avg = formatUsd(summary?.avgCostPerHourUsd ?? null);
  return `Custo/h: ${avg}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0%";
  return `${value.toFixed(1)}%`;
}

function formatSecondsFromMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/D";
  const seconds = value / 1000;
  if (seconds >= 100) return `${seconds.toFixed(0)}s`;
  if (seconds >= 10) return `${seconds.toFixed(1)}s`;
  return `${seconds.toFixed(2)}s`;
}

function countMissingBootstrapSamples(bootstrap?: ProjectionBootstrapPayload | null): number {
  if (!bootstrap) return 0;
  return Object.values(bootstrap.missingSamplesByModelAction).reduce(
    (sum, item) => sum + item.prompt + item.answer + item.vote,
    0,
  );
}

function msToSecondsInput(valueMs: number): string {
  if (!Number.isFinite(valueMs)) return "0";
  const seconds = valueMs / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function secondsInputToMs(value: string): number {
  return Math.round(safePositive(Number(value)) * 1000);
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (text) return text;
  return `Falha na requisicao (${res.status})`;
}

async function requestAdminJson<T>(
  path: string,
  passcode: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("x-admin-passcode", passcode);

  const response = await fetch(`${getConvexSiteUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-card">
      <div className="status-card__label">{label}</div>
      <div className="status-card__value">{value}</div>
    </div>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>("checking");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [usageByModel, setUsageByModel] = useState<UsageByModel>({});
  const [usageHourlyByModel, setUsageHourlyByModel] = useState<UsageHourlyByModel>({});
  const [usageWindowSize, setUsageWindowSize] = useState(50);
  const [activeModelsHourlyShareByModel, setActiveModelsHourlyShareByModel] = useState<Record<string, number>>(
    {},
  );
  const [projectionBootstrap, setProjectionBootstrap] = useState<ProjectionBootstrapPayload | null>(null);
  const [viewerTargets, setViewerTargets] = useState<ViewerTarget[]>([]);
  const [telegramConfig, setTelegramConfig] = useState<TelegramConfig | null>(null);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [targetPlatform, setTargetPlatform] = useState<"twitch" | "youtube">("twitch");
  const [targetValue, setTargetValue] = useState("");
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [telegramEnabledInput, setTelegramEnabledInput] = useState(false);
  const [telegramChannelIdInput, setTelegramChannelIdInput] = useState("");
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelColor, setModelColor] = useState<string>(AVAILABLE_MODEL_COLORS[0]);
  const [modelLogoId, setModelLogoId] = useState<(typeof AVAILABLE_MODEL_LOGO_IDS)[number]>("openai");
  const [modelReasoningEffort, setModelReasoningEffort] = useState<ModelReasoningEffortFormValue>(
    DEFAULT_MODEL_REASONING_EFFORT,
  );
  const [modelEnabled, setModelEnabled] = useState(true);
  const [modelCanPrompt, setModelCanPrompt] = useState(true);
  const [modelCanAnswer, setModelCanAnswer] = useState(true);
  const [modelCanVote, setModelCanVote] = useState(true);
  const [editingModelOriginalId, setEditingModelOriginalId] = useState<string | null>(null);
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelStatusFilter, setModelStatusFilter] = useState<ModelStatusFilter>("all");
  const [modelRoleFilter, setModelRoleFilter] = useState<ModelRoleFilter>("all");
  const [modelSort, setModelSort] = useState<ModelSort>("cost_desc");
  const [activePage, setActivePage] = useState<AdminPage>(() => readAdminPageFromLocation());
  const [projection, setProjection] = useState<ProjectionPayload | null>(null);
  const [voteWindowActiveSecondsInput, setVoteWindowActiveSecondsInput] = useState("30");
  const [voteWindowIdleSecondsInput, setVoteWindowIdleSecondsInput] = useState("120");
  const [postRoundDelayActiveSecondsInput, setPostRoundDelayActiveSecondsInput] = useState("5");
  const [calcHoursPerDayInput, setCalcHoursPerDayInput] = useState("8");
  const [calcDaysPerWeekInput, setCalcDaysPerWeekInput] = useState("5");
  const [calcDaysPerMonthInput, setCalcDaysPerMonthInput] = useState("22");
  const [calcMonthlyBudgetInput, setCalcMonthlyBudgetInput] = useState("500");

  async function loadViewerTargets(passcodeToUse: string) {
    const response = await requestAdminJson<ViewerTargetsResponse>(
      "/admin/viewer-targets",
      passcodeToUse,
    );
    setViewerTargets(response.targets);
  }

  function applyTelegramConfig(response: TelegramConfig) {
    setTelegramConfig(response);
    setTelegramEnabledInput(response.enabled);
    setTelegramChannelIdInput(response.channelId ?? "");
    setTelegramBotTokenInput("");
  }

  async function loadTelegramConfig(passcodeToUse: string) {
    const response = await requestAdminJson<TelegramConfigResponse>("/admin/telegram/config", passcodeToUse);
    applyTelegramConfig(response);
  }

  function applyUsagePayload(response: ModelsResponse) {
    setUsageByModel(response.usageByModel ?? {});
    setUsageHourlyByModel(response.usageHourlyByModel ?? {});
    setUsageWindowSize(response.usageWindowSize ?? 50);
    setActiveModelsHourlyShareByModel(response.activeModelsHourlyShareByModel ?? {});
    setProjectionBootstrap(response.projectionBootstrap ?? null);
    if (response.projection) {
      setProjection(response.projection);
      setVoteWindowActiveSecondsInput(msToSecondsInput(response.projection.timing.viewerVoteWindowActiveMs));
      setVoteWindowIdleSecondsInput(msToSecondsInput(response.projection.timing.viewerVoteWindowIdleMs));
      setPostRoundDelayActiveSecondsInput(msToSecondsInput(response.projection.timing.postRoundDelayActiveMs));
    } else {
      setProjection(null);
    }
  }

  async function loadModels(passcodeToUse: string) {
    const response = await requestAdminJson<ModelsResponse>("/admin/models", passcodeToUse);
    setModels(response.models);
    applyUsagePayload(response);
  }

  useEffect(() => {
    const storedPasscode = readStoredPasscode();
    if (!storedPasscode) {
      setMode("locked");
      return;
    }

    requestAdminJson<AdminResponse>("/admin/status", storedPasscode)
      .then(async (data) => {
        setSnapshot(data);
        setMode("ready");
        try {
          await Promise.all([
            loadViewerTargets(storedPasscode),
            loadTelegramConfig(storedPasscode),
            loadModels(storedPasscode),
          ]);
        } catch {
          setViewerTargets([]);
          setTelegramConfig(null);
          setTelegramEnabledInput(false);
          setTelegramChannelIdInput("");
          setTelegramBotTokenInput("");
          setModels([]);
          setUsageByModel({});
          setUsageHourlyByModel({});
          setUsageWindowSize(50);
          setActiveModelsHourlyShareByModel({});
          setProjectionBootstrap(null);
          setProjection(null);
        }
      })
      .catch(() => {
        setSnapshot(null);
        setMode("locked");
      });
  }, []);

  useEffect(() => {
    writeAdminPageToLocation(activePage);
  }, [activePage]);

  const busy = useMemo(() => pending !== null, [pending]);
  const activeModels = useMemo(
    () => models.filter((model) => model.enabled && !model.archivedAt),
    [models],
  );
  const modelStats = useMemo(() => {
    const active = models.filter((model) => model.enabled && !model.archivedAt).length;
    const inactive = models.filter((model) => !model.enabled && !model.archivedAt).length;
    const archived = models.filter((model) => Boolean(model.archivedAt)).length;
    const answerReady = models.filter((model) => model.canAnswer && !model.archivedAt).length;
    return {
      total: models.length,
      active,
      inactive,
      archived,
      answerReady,
    };
  }, [models]);
  const filteredModels = useMemo(() => {
    const search = modelSearch.trim().toLowerCase();
    const filtered = models
      .filter((model) => {
        if (modelStatusFilter === "active") return model.enabled && !model.archivedAt;
        if (modelStatusFilter === "inactive") return !model.enabled && !model.archivedAt;
        if (modelStatusFilter === "archived") return Boolean(model.archivedAt);
        return true;
      })
      .filter((model) => modelMatchesRole(model, modelRoleFilter))
      .filter((model) => {
        if (!search) return true;
        return model.name.toLowerCase().includes(search) || model.modelId.toLowerCase().includes(search);
      });

    return filtered.sort((a, b) => {
      if (modelSort === "name") {
        return a.name.localeCompare(b.name, "pt-BR");
      }
      if (modelSort === "recent") {
        const aUpdated = Number(a.updatedAt ?? a.createdAt ?? 0);
        const bUpdated = Number(b.updatedAt ?? b.createdAt ?? 0);
        return bUpdated - aUpdated;
      }
      const aHourly = Number(usageHourlyByModel[a.modelId]?.avgCostPerHourUsd ?? 0);
      const bHourly = Number(usageHourlyByModel[b.modelId]?.avgCostPerHourUsd ?? 0);
      if (modelSort === "cost_asc") return aHourly - bHourly;
      return bHourly - aHourly;
    });
  }, [models, modelRoleFilter, modelSearch, modelSort, modelStatusFilter, usageHourlyByModel]);
  const modelColorOptions = useMemo(() => {
    const normalizedSelected = normalizeHexColor(modelColor);
    if (AVAILABLE_MODEL_COLORS.includes(normalizedSelected as (typeof AVAILABLE_MODEL_COLORS)[number])) {
      return AVAILABLE_MODEL_COLORS;
    }
    return [normalizedSelected, ...AVAILABLE_MODEL_COLORS];
  }, [modelColor]);
  const modelsById = useMemo(() => new Map(models.map((model) => [model.modelId, model])), [models]);
  const activeHourlyUsageRows = useMemo(
    () =>
      activeModels.map((model) => {
        const usage = usageHourlyByModel[model.modelId];
        const hourlyCost = usage?.avgCostPerHourUsd;
        return {
          modelId: model.modelId,
          name: model.name,
          color: model.color,
          avgCostPerHourUsd:
            hourlyCost !== null && Number.isFinite(hourlyCost)
              ? Number(hourlyCost)
              : 0,
        };
      }),
    [activeModels, usageHourlyByModel],
  );
  const projectionMissingSamples = useMemo(
    () => countMissingBootstrapSamples(projectionBootstrap),
    [projectionBootstrap],
  );
  const projectionReady = useMemo(() => {
    if (!projection) return false;
    if (projectionMissingSamples <= 0) return true;
    return projectionBootstrap?.status === "ready";
  }, [projection, projectionBootstrap?.status, projectionMissingSamples]);
  const projectionBootstrapFailed = projectionBootstrap?.status === "failed" && projectionMissingSamples > 0;
  const shouldShowProjectionBootstrapBanner = !projection || projectionMissingSamples > 0 || projectionBootstrapFailed;
  const activeHourlyShareRows = useMemo(
    () =>
      activeHourlyUsageRows
        .map((row) => {
          const serverShare = activeModelsHourlyShareByModel[row.modelId];
          const sharePercent = Number.isFinite(serverShare) ? Number(serverShare) : 0;
          return {
            ...row,
            sharePercent,
          };
        })
        .sort((a, b) => b.sharePercent - a.sharePercent),
    [activeHourlyUsageRows, activeModelsHourlyShareByModel],
  );
  const voteWindowActiveMs = useMemo(
    () => secondsInputToMs(voteWindowActiveSecondsInput),
    [voteWindowActiveSecondsInput],
  );
  const voteWindowIdleMs = useMemo(
    () => secondsInputToMs(voteWindowIdleSecondsInput),
    [voteWindowIdleSecondsInput],
  );
  const postRoundDelayActiveMs = useMemo(
    () => secondsInputToMs(postRoundDelayActiveSecondsInput),
    [postRoundDelayActiveSecondsInput],
  );
  const projectionViewerRoundShare = useMemo(() => {
    if (projection) return Math.max(0, Math.min(1, projection.viewerRoundShare));
    return (snapshot?.viewerCount ?? 0) > 0 ? 1 : 0;
  }, [projection, snapshot?.viewerCount]);
  const effectiveVoteWindowMs = useMemo(() => {
    if (!projection) return null;
    return (
      projectionViewerRoundShare * voteWindowActiveMs +
      (1 - projectionViewerRoundShare) * voteWindowIdleMs
    );
  }, [projection, projectionViewerRoundShare, voteWindowActiveMs, voteWindowIdleMs]);
  const effectivePostRoundDelayMs = useMemo(() => {
    if (!projection) return null;
    const idleDelay = projection.timing.postRoundDelayIdleMs;
    const extra = projection.timingsMs.extraInterRound ?? 0;
    return (
      projectionViewerRoundShare * postRoundDelayActiveMs +
      (1 - projectionViewerRoundShare) * idleDelay +
      extra
    );
  }, [projection, projectionViewerRoundShare, postRoundDelayActiveMs]);
  const projectedRoundCycleMs = useMemo(() => {
    if (
      !projectionReady ||
      !projection ||
      projection.timingsMs.nonVoting === null ||
      effectiveVoteWindowMs === null ||
      effectivePostRoundDelayMs === null
    ) {
      return null;
    }
    return Math.max(1, projection.timingsMs.nonVoting + effectiveVoteWindowMs + effectivePostRoundDelayMs);
  }, [projection, projectionReady, effectivePostRoundDelayMs, effectiveVoteWindowMs]);
  const projectedRoundsPerHour = useMemo(() => {
    if (projectedRoundCycleMs === null || projectedRoundCycleMs <= 0) return null;
    return 3_600_000 / projectedRoundCycleMs;
  }, [projectedRoundCycleMs]);
  const projectedRoundCostUsd = useMemo(() => {
    if (!projectionReady || !projection) return null;
    const total = projection.costs.perRoundUsd.total;
    return Number.isFinite(total) ? total : null;
  }, [projection, projectionReady]);
  const projectedTotalHourlyCostUsd = useMemo(() => {
    if (projectedRoundCostUsd === null || projectedRoundsPerHour === null) return null;
    return projectedRoundCostUsd * projectedRoundsPerHour;
  }, [projectedRoundCostUsd, projectedRoundsPerHour]);
  const totalHourlyCostUsd = useMemo(
    () =>
      projectedTotalHourlyCostUsd !== null && Number.isFinite(projectedTotalHourlyCostUsd)
        ? projectedTotalHourlyCostUsd
        : null,
    [projectedTotalHourlyCostUsd],
  );
  const isProjectionTimingDirty = useMemo(() => {
    if (!projection) return false;
    return (
      voteWindowActiveMs !== projection.timing.viewerVoteWindowActiveMs ||
      voteWindowIdleMs !== projection.timing.viewerVoteWindowIdleMs ||
      postRoundDelayActiveMs !== projection.timing.postRoundDelayActiveMs
    );
  }, [postRoundDelayActiveMs, projection, voteWindowActiveMs, voteWindowIdleMs]);
  const projectedDailyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * 24 : null),
    [totalHourlyCostUsd],
  );
  const projectedWeeklyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * 24 * 7 : null),
    [totalHourlyCostUsd],
  );
  const projectedMonthlyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * 24 * 30 : null),
    [totalHourlyCostUsd],
  );
  const activeHourlyCompositionRows = useMemo(
    () =>
      activeHourlyShareRows.map((row) => {
        const usage = usageByModel[row.modelId];
        const model = modelsById.get(row.modelId);
        const ratios = getActionRatios(usage, model);
        const promptHourlyUsd = (row.avgCostPerHourUsd * ratios.prompt) / 100;
        const answerHourlyUsd = (row.avgCostPerHourUsd * ratios.answer) / 100;
        const voteHourlyUsd = (row.avgCostPerHourUsd * ratios.vote) / 100;
        return {
          ...row,
          promptSharePercent: ratios.prompt,
          answerSharePercent: ratios.answer,
          voteSharePercent: ratios.vote,
          promptHourlyUsd,
          answerHourlyUsd,
          voteHourlyUsd,
        };
      }),
    [activeHourlyShareRows, usageByModel, modelsById],
  );
  const actionTotals = useMemo(() => {
    if (!projectionReady || !projection || projectedRoundsPerHour === null) {
      return {
        promptHourlyUsd: 0,
        answerHourlyUsd: 0,
        voteHourlyUsd: 0,
        promptPercent: 0,
        answerPercent: 0,
        votePercent: 0,
      };
    }

    const promptHourlyUsd = projection.costs.perRoundUsd.prompt * projectedRoundsPerHour;
    const answerHourlyUsd = projection.costs.perRoundUsd.answer * projectedRoundsPerHour;
    const voteHourlyUsd = projection.costs.perRoundUsd.vote * projectedRoundsPerHour;
    const total = promptHourlyUsd + answerHourlyUsd + voteHourlyUsd;
    return {
      promptHourlyUsd,
      answerHourlyUsd,
      voteHourlyUsd,
      promptPercent: total > 0 ? (promptHourlyUsd / total) * 100 : 0,
      answerPercent: total > 0 ? (answerHourlyUsd / total) * 100 : 0,
      votePercent: total > 0 ? (voteHourlyUsd / total) * 100 : 0,
    };
  }, [projectedRoundsPerHour, projection, projectionReady]);
  const calcHoursPerDay = useMemo(() => safePositive(Number(calcHoursPerDayInput)), [calcHoursPerDayInput]);
  const calcDaysPerWeek = useMemo(() => safePositive(Number(calcDaysPerWeekInput)), [calcDaysPerWeekInput]);
  const calcDaysPerMonth = useMemo(() => safePositive(Number(calcDaysPerMonthInput)), [calcDaysPerMonthInput]);
  const calcMonthlyBudget = useMemo(() => safePositive(Number(calcMonthlyBudgetInput)), [calcMonthlyBudgetInput]);
  const customDailyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * calcHoursPerDay : null),
    [totalHourlyCostUsd, calcHoursPerDay],
  );
  const customWeeklyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * calcHoursPerDay * calcDaysPerWeek : null),
    [totalHourlyCostUsd, calcHoursPerDay, calcDaysPerWeek],
  );
  const customMonthlyCostUsd = useMemo(
    () => (totalHourlyCostUsd !== null ? totalHourlyCostUsd * calcHoursPerDay * calcDaysPerMonth : null),
    [totalHourlyCostUsd, calcHoursPerDay, calcDaysPerMonth],
  );
  const budgetUsagePercent = useMemo(() => {
    if (!customMonthlyCostUsd || customMonthlyCostUsd <= 0 || calcMonthlyBudget <= 0) return 0;
    return (customMonthlyCostUsd / calcMonthlyBudget) * 100;
  }, [customMonthlyCostUsd, calcMonthlyBudget]);
  const budgetRemainingUsd = useMemo(() => {
    if (calcMonthlyBudget <= 0 || customMonthlyCostUsd === null) return null;
    return calcMonthlyBudget - customMonthlyCostUsd;
  }, [calcMonthlyBudget, customMonthlyCostUsd]);
  const affordableHoursPerMonth = useMemo(() => {
    if (!totalHourlyCostUsd || totalHourlyCostUsd <= 0 || calcMonthlyBudget <= 0) return null;
    return calcMonthlyBudget / totalHourlyCostUsd;
  }, [totalHourlyCostUsd, calcMonthlyBudget]);

  function resetTargetForm() {
    setTargetPlatform("twitch");
    setTargetValue("");
    setTargetEnabled(true);
    setEditingTargetId(null);
  }

  function resetModelForm() {
    setModelId("");
    setModelName("");
    setModelColor(AVAILABLE_MODEL_COLORS[0]);
    setModelLogoId("openai");
    setModelReasoningEffort(DEFAULT_MODEL_REASONING_EFFORT);
    setModelEnabled(true);
    setModelCanPrompt(true);
    setModelCanAnswer(true);
    setModelCanVote(true);
    setEditingModelOriginalId(null);
    setIsModelFormOpen(false);
  }

  function openCreateModelForm() {
    setModelId("");
    setModelName("");
    setModelColor(AVAILABLE_MODEL_COLORS[0]);
    setModelLogoId("openai");
    setModelReasoningEffort(DEFAULT_MODEL_REASONING_EFFORT);
    setModelEnabled(true);
    setModelCanPrompt(true);
    setModelCanAnswer(true);
    setModelCanVote(true);
    setEditingModelOriginalId(null);
    setIsModelFormOpen(true);
  }

  function hydrateModelForm(model: ModelCatalogEntry) {
    setModelId(model.modelId);
    setModelName(model.name);
    setModelColor(normalizeHexColor(model.color));
    setModelLogoId(model.logoId);
    setModelReasoningEffort(model.reasoningEffort ?? REASONING_EFFORT_UNDEFINED);
    setModelEnabled(model.enabled);
    setModelCanPrompt(model.canPrompt);
    setModelCanAnswer(model.canAnswer);
    setModelCanVote(model.canVote);
    setEditingModelOriginalId(model.modelId);
    setIsModelFormOpen(true);
  }

  async function onLogin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("login");
    try {
      const data = await requestAdminJson<AdminResponse>("/admin/login", passcode, {
        method: "POST",
      });
      writeStoredPasscode(passcode);
      setSnapshot(data);
      setPasscode("");
      setMode("ready");
      await Promise.all([loadViewerTargets(passcode), loadTelegramConfig(passcode), loadModels(passcode)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao entrar");
    } finally {
      setPending(null);
    }
  }

  async function runControl(path: string, task: string) {
    setError(null);
    setPending(task);
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<AdminResponse>(path, passcodeValue, { method: "POST" });
      setSnapshot(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha na acao de admin";
      const lowered = message.toLowerCase();
      if (lowered.includes("unauthorized") || lowered.includes("nao autorizado")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onExport() {
    setError(null);
    setPending("export");
    try {
      const passcodeValue = readStoredPasscode();
      const response = await fetch(`${getConvexSiteUrl()}/admin/export`, {
        cache: "no-store",
        headers: {
          "x-admin-passcode": passcodeValue,
        },
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      const fileName = fileNameMatch?.[1] ?? `tokenscomedyclub-export-${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha no export";
      const lowered = message.toLowerCase();
      if (lowered.includes("unauthorized") || lowered.includes("nao autorizado")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onReset() {
    setError(null);
    setPending("reset");
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<AdminResponse>("/admin/reset", passcodeValue, {
        method: "POST",
      });
      setSnapshot(data);
      setResetText("");
      setIsResetOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no reset");
    } finally {
      setPending(null);
    }
  }

  async function onSaveViewerTarget(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("save-target");
    try {
      const passcodeValue = readStoredPasscode();
      const response = await requestAdminJson<ViewerTargetsResponse>(
        "/admin/viewer-targets",
        passcodeValue,
        {
          method: "POST",
          body: JSON.stringify({
            id: editingTargetId ?? undefined,
            platform: targetPlatform,
            target: targetValue,
            enabled: targetEnabled,
          }),
        },
      );
      setViewerTargets(response.targets);
      resetTargetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar target");
    } finally {
      setPending(null);
    }
  }

  async function onDeleteViewerTarget(targetId: string) {
    setError(null);
    setPending("delete-target");
    try {
      const passcodeValue = readStoredPasscode();
      const response = await requestAdminJson<ViewerTargetsResponse>(
        "/admin/viewer-targets/delete",
        passcodeValue,
        {
          method: "POST",
          body: JSON.stringify({ id: targetId }),
        },
      );
      setViewerTargets(response.targets);
      if (editingTargetId === targetId) {
        resetTargetForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover target");
    } finally {
      setPending(null);
    }
  }

  async function onRefreshTargets() {
    setError(null);
    setPending("refresh-targets");
    try {
      const passcodeValue = readStoredPasscode();
      await Promise.all([loadViewerTargets(passcodeValue), loadTelegramConfig(passcodeValue)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao recarregar targets");
    } finally {
      setPending(null);
    }
  }

  async function onSaveTelegramConfig(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("save-telegram-config");
    try {
      const passcodeValue = readStoredPasscode();
      const payload: { enabled: boolean; channelId: string; botToken?: string } = {
        enabled: telegramEnabledInput,
        channelId: telegramChannelIdInput.trim(),
      };
      const token = telegramBotTokenInput.trim();
      if (token) {
        payload.botToken = token;
      }

      const response = await requestAdminJson<TelegramConfigResponse>("/admin/telegram/config", passcodeValue, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      applyTelegramConfig(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar configuracao do Telegram");
    } finally {
      setPending(null);
    }
  }

  async function onRefreshModels() {
    setError(null);
    setPending("refresh-models");
    try {
      const passcodeValue = readStoredPasscode();
      await loadModels(passcodeValue);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao recarregar modelos");
    } finally {
      setPending(null);
    }
  }

  async function onSaveProjectionTiming() {
    if (!projection) return;

    setError(null);
    setPending("save-projection-timing");
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<ModelsResponse>("/admin/projections/settings", passcodeValue, {
        method: "POST",
        body: JSON.stringify({
          viewerVoteWindowActiveMs: voteWindowActiveMs,
          viewerVoteWindowIdleMs: voteWindowIdleMs,
          postRoundDelayActiveMs,
        }),
      });
      setModels(data.models);
      applyUsagePayload(data);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar tempos de projecao");
    } finally {
      setPending(null);
    }
  }

  async function onSaveModel(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("save-model");
    try {
      const passcodeValue = readStoredPasscode();
      const isEditing = Boolean(editingModelOriginalId);
      const path = isEditing ? "/admin/models/update" : "/admin/models";
      const reasoningEffortPayload =
        modelReasoningEffort === REASONING_EFFORT_UNDEFINED ? null : modelReasoningEffort;
      const body = isEditing
        ? {
            originalModelId: editingModelOriginalId,
            modelId: modelId.trim(),
            name: modelName.trim(),
            color: normalizeHexColor(modelColor),
            logoId: modelLogoId,
            reasoningEffort: reasoningEffortPayload,
            enabled: modelEnabled,
            canPrompt: modelCanPrompt,
            canAnswer: modelCanAnswer,
            canVote: modelCanVote,
          }
        : {
            modelId: modelId.trim(),
            name: modelName.trim(),
            color: normalizeHexColor(modelColor),
            logoId: modelLogoId,
            reasoningEffort: reasoningEffortPayload,
            enabled: modelEnabled,
            canPrompt: modelCanPrompt,
            canAnswer: modelCanAnswer,
            canVote: modelCanVote,
          };
      const data = await requestAdminJson<ModelsResponse>(path, passcodeValue, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setModels(data.models);
      applyUsagePayload(data);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
      resetModelForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar modelo");
    } finally {
      setPending(null);
    }
  }

  async function onToggleModel(modelIdValue: string, enabled: boolean) {
    setError(null);
    setPending(`toggle-model:${modelIdValue}`);
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<ModelsResponse>("/admin/models/enable", passcodeValue, {
        method: "POST",
        body: JSON.stringify({ modelId: modelIdValue, enabled }),
      });
      setModels(data.models);
      applyUsagePayload(data);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao atualizar modelo";
      const lowered = message.toLowerCase();
      if (lowered.includes("unauthorized") || lowered.includes("nao autorizado")) {
        setMode("locked");
        setSnapshot(null);
      }
      setError(message);
    } finally {
      setPending(null);
    }
  }

  async function onRemoveModel(modelIdValue: string) {
    setError(null);
    setPending(`remove-model:${modelIdValue}`);
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<ModelsResponse>("/admin/models/remove", passcodeValue, {
        method: "POST",
        body: JSON.stringify({ modelId: modelIdValue }),
      });
      setModels(data.models);
      applyUsagePayload(data);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao arquivar modelo");
    } finally {
      setPending(null);
    }
  }

  async function onRestoreModel(modelIdValue: string) {
    setError(null);
    setPending(`restore-model:${modelIdValue}`);
    try {
      const passcodeValue = readStoredPasscode();
      const data = await requestAdminJson<ModelsResponse>("/admin/models/restore", passcodeValue, {
        method: "POST",
        body: JSON.stringify({ modelId: modelIdValue, enabled: true }),
      });
      setModels(data.models);
      applyUsagePayload(data);
      const status = await requestAdminJson<AdminResponse>("/admin/status", passcodeValue);
      setSnapshot(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao desarquivar modelo");
    } finally {
      setPending(null);
    }
  }

  function onEditViewerTarget(target: ViewerTarget) {
    setEditingTargetId(target._id);
    setTargetPlatform(target.platform);
    setTargetValue(target.target);
    setTargetEnabled(target.enabled);
  }

  async function onLogout() {
    setError(null);
    setPending("logout");
    try {
      writeStoredPasscode("");
      setSnapshot(null);
      setModels([]);
      setUsageByModel({});
      setUsageHourlyByModel({});
      setUsageWindowSize(50);
      setActiveModelsHourlyShareByModel({});
      setProjectionBootstrap(null);
      setProjection(null);
      setVoteWindowActiveSecondsInput("30");
      setVoteWindowIdleSecondsInput("120");
      setPostRoundDelayActiveSecondsInput("5");
      setViewerTargets([]);
      setPasscode("");
      resetTargetForm();
      resetModelForm();
      setMode("locked");
    } finally {
      setPending(null);
    }
  }

  function onSelectPage(page: AdminPage) {
    setActivePage(page);
  }

  if (mode === "checking") {
    return (
      <div className="admin admin--centered">
        <div className="loading">Verificando sessao admin...</div>
      </div>
    );
  }

  if (mode === "locked") {
    return (
      <div className="admin admin--centered">
        <main className="panel panel--login">
          <a href="/" className="logo-link">
            <img src="/assets/logo.svg" alt="TokensComedyClub" />
          </a>
          <h1>Acesso Admin</h1>
          <p className="muted">
            Digite sua senha de admin para liberar os controles.
          </p>

          <form
            onSubmit={onLogin}
            className="login-form"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          >
            <label htmlFor="passcode" className="field-label">
              Senha
            </label>
            <input
              id="passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className="text-input"
              autoFocus
              autoComplete="off"
              required
              data-1p-ignore
              data-lpignore="true"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !passcode.trim()}
              data-1p-ignore
              data-lpignore="true"
            >
              {pending === "login" ? "Verificando..." : "Desbloquear Admin"}
            </button>
          </form>

          {error && <div className="error-banner">{error}</div>}

          <div className="quick-links">
            <a href="/">Jogo Ao Vivo</a>
            <a href="/history">Historico</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <a href="/" className="logo-link">
          <img src="/assets/logo.svg" alt="TokensComedyClub" />
        </a>
        <nav className="quick-links">
          <a href="/">Jogo Ao Vivo</a>
          <a href="/history">Historico</a>
          <button className="link-button" onClick={onLogout} disabled={busy}>
            Sair
          </button>
        </nav>
      </header>

      <main className="panel panel--main">
        <div className="panel-head">
          <h1>Console Admin</h1>
          <p>
            Controle do motor, catalogo de modelos, audiencia e custos em telas separadas.
          </p>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="Telas do console admin">
          {ADMIN_PAGE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activePage === tab.id}
              className={`admin-tabs__item ${activePage === tab.id ? "admin-tabs__item--active" : ""}`}
              onClick={() => onSelectPage(tab.id)}
              disabled={busy}
            >
              <span className="admin-tabs__label">{tab.label}</span>
            </button>
          ))}
        </div>
        <p className="admin-tabs__hint">{ADMIN_PAGE_TABS.find((tab) => tab.id === activePage)?.description}</p>

        {error && <div className="error-banner">{error}</div>}

        {activePage === "operations" && (
        <section className="operations operations--standalone" aria-label="Operacao do sistema">
          <div className="operations__top">
            <div className="operations__intro">
              <h2>Operacao</h2>
              <p className="muted">
                Comandos de runtime e saude do motor para controle rapido durante a transmissao.
              </p>
            </div>
            <div className="actions" aria-label="Acoes admin">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || Boolean(snapshot?.isPaused)}
                onClick={() => runControl("/admin/pause", "pause")}
              >
                {pending === "pause" ? "Pausando..." : "Pausar"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !snapshot?.isPaused}
                onClick={() => runControl("/admin/resume", "resume")}
              >
                {pending === "resume" ? "Retomando..." : "Retomar"}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={onExport}>
                {pending === "export" ? "Exportando..." : "Exportar JSON"}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={() => setIsResetOpen(true)}
              >
                Resetar Dados
              </button>
            </div>
          </div>

          <section className="status-grid" aria-live="polite">
            <StatusCard
              label="Motor"
              value={snapshot?.isPaused ? "Pausado" : "Rodando"}
            />
            <StatusCard
              label="Rodada Ativa"
              value={snapshot?.isRunningRound ? "Em Andamento" : "Parada"}
            />
            <StatusCard
              label="Rodadas Persistidas"
              value={String(snapshot?.persistedRounds ?? 0)}
            />
            <StatusCard
              label="Modelos Ativos"
              value={String(snapshot?.activeModelCount ?? activeModels.length)}
            />
            <StatusCard
              label="Execucao"
              value={
                snapshot?.canRunRounds
                  ? "Pronto"
                  : snapshot?.runBlockedReason === "insufficient_role_coverage"
                    ? "Bloqueado (papeis)"
                    : "Bloqueado (<3 modelos)"
              }
            />
            <StatusCard label="Espectadores" value={String(snapshot?.viewerCount ?? 0)} />
          </section>

          {snapshot?.runBlockedReason === "insufficient_active_models" && (
            <div className="error-banner">
              Motor aguardando: ative ao menos 3 modelos para voltar a gerar rodadas.
            </div>
          )}
          {snapshot?.runBlockedReason === "insufficient_role_coverage" && (
            <div className="error-banner">
              Motor aguardando: configure cobertura de papeis (pelo menos 1 prompt, 2 respostas e 1 voto fora dos
              concorrentes).
            </div>
          )}
        </section>
        )}

        {activePage === "models" && (
        <section className="models models--standalone">
          <div className="section-head">
            <div>
              <h2>Modelos</h2>
              <p className="muted">
                Configure papeis e custos por modelo. Janela atual: ultimas {usageWindowSize} requests por tipo.
              </p>
            </div>
            <span className="models__count">
              {filteredModels.length} exibidos de {modelStats.total}
            </span>
          </div>

          <div className="models-ux__stats">
            <div className="hour-card">
              <span className="hour-card__label">Ativos</span>
              <strong className="hour-card__value">{modelStats.active}</strong>
            </div>
            <div className="hour-card">
              <span className="hour-card__label">Inativos</span>
              <strong className="hour-card__value">{modelStats.inactive}</strong>
            </div>
            <div className="hour-card">
              <span className="hour-card__label">Arquivados</span>
              <strong className="hour-card__value">{modelStats.archived}</strong>
            </div>
            <div className="hour-card">
              <span className="hour-card__label">Com resposta habilitada</span>
              <strong className="hour-card__value">{modelStats.answerReady}</strong>
            </div>
          </div>

          <div className="models-ux__toolbar">
            <input
              className="text-input models-ux__search"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder="Buscar por nome ou model id"
              disabled={busy}
            />
            <select
              className="text-input models-ux__select"
              value={modelStatusFilter}
              onChange={(event) => setModelStatusFilter(event.target.value as ModelStatusFilter)}
              disabled={busy}
            >
              <option value="all">Todos os status</option>
              <option value="active">Ativos</option>
              <option value="inactive">Inativos</option>
              <option value="archived">Arquivados</option>
            </select>
            <select
              className="text-input models-ux__select"
              value={modelRoleFilter}
              onChange={(event) => setModelRoleFilter(event.target.value as ModelRoleFilter)}
              disabled={busy}
            >
              <option value="all">Todos os papeis</option>
              <option value="prompt">Pode escrever prompt</option>
              <option value="answer">Pode responder</option>
              <option value="vote">Pode votar</option>
            </select>
            <select
              className="text-input models-ux__select"
              value={modelSort}
              onChange={(event) => setModelSort(event.target.value as ModelSort)}
              disabled={busy}
            >
              <option value="cost_desc">Ordenar por custo/h (maior)</option>
              <option value="cost_asc">Ordenar por custo/h (menor)</option>
              <option value="recent">Mais recentes</option>
              <option value="name">Nome (A-Z)</option>
            </select>
            <button type="button" className="btn" disabled={busy} onClick={onRefreshModels}>
              {pending === "refresh-models" ? "Atualizando..." : "Atualizar"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={openCreateModelForm}
            >
              Novo modelo
            </button>
          </div>

          <div className="models-ux__layout models-ux__layout--single">
            <div className="models-ux__catalog">
              <div className="models__catalog-head">
                <h3>Lista de modelos</h3>
                <span className="models__count">{filteredModels.length} resultados</span>
              </div>

              <div className="models__list">
                {filteredModels.length === 0 ? (
                  <div className="targets__empty">Nenhum modelo encontrado com os filtros atuais.</div>
                ) : (
                  filteredModels.map((model) => {
                    const archived = Boolean(model.archivedAt);
                    const usage = usageByModel[model.modelId];
                    const hourlyUsage = usageHourlyByModel[model.modelId];
                    const stateLabel = archived ? "arquivado" : model.enabled ? "ativo" : "inativo";
                    return (
                      <article
                        key={model.modelId}
                        className="model-card"
                      >
                        <button
                          type="button"
                          className="model-card__primary"
                          onClick={() => {
                            if (!archived) {
                              hydrateModelForm(model);
                            }
                          }}
                          disabled={archived}
                        >
                          <span className="model-row__swatch" style={{ background: model.color }} />
                          <span className="model-card__name">{model.name}</span>
                          <span className="model-card__id">{model.modelId}</span>
                          <span className={`model-row__state ${archived ? "model-row__state--archived" : ""}`}>
                            {stateLabel}
                          </span>
                        </button>

                        <div className="model-card__roles">
                          <span className={`role-pill ${model.canPrompt ? "" : "role-pill--off"}`}>Prompt</span>
                          <span className={`role-pill ${model.canAnswer ? "" : "role-pill--off"}`}>Resposta</span>
                          <span className={`role-pill ${model.canVote ? "" : "role-pill--off"}`}>Voto</span>
                        </div>

                        <div className="model-card__usage">
                          <span>{formatModelHourlyCostLine(hourlyUsage)}</span>
                          <span>{formatModelSamplesLine(usage)}</span>
                        </div>

                        <div className="model-card__actions">
                          {archived ? (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => onRestoreModel(model.modelId)}
                            >
                              Desarquivar
                            </button>
                          ) : (
                            <>
                              <label className="models__checkbox">
                                <input
                                  type="checkbox"
                                  checked={Boolean(model.enabled)}
                                  disabled={busy}
                                  onChange={(event) => onToggleModel(model.modelId, event.target.checked)}
                                />
                                Ativo
                              </label>
                              <button
                                type="button"
                                className="btn"
                                disabled={busy}
                                onClick={() => hydrateModelForm(model)}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                className="btn btn--danger"
                                disabled={busy}
                                onClick={() => onRemoveModel(model.modelId)}
                              >
                                Arquivar
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </div>

          </div>
        </section>
        )}

        {activePage === "targets" && (
        <section className="targets targets--standalone">
          <div className="section-head">
            <div>
              <h2>Targets de Audiencia</h2>
              <p className="muted">
                Twitch usa <code>user_login</code>. YouTube usa <code>videoId</code>. Telegram usa{' '}
                <code>@canal</code> ou <code>-100...</code>.
              </p>
            </div>
            <button type="button" className="btn" disabled={busy} onClick={onRefreshTargets}>
              {pending === "refresh-targets" ? "Atualizando..." : "Atualizar"}
            </button>
          </div>

          <div className="targets__workspace">
            <aside className="targets__editor">
              <h3>{editingTargetId ? "Editar target" : "Novo target"}</h3>
              <form className="targets__form" onSubmit={onSaveViewerTarget}>
                <label className="field-label" htmlFor="target-platform">
                  Plataforma
                </label>
                <select
                  id="target-platform"
                  className="text-input"
                  value={targetPlatform}
                  onChange={(event) => setTargetPlatform(event.target.value as "twitch" | "youtube")}
                  disabled={busy}
                >
                  <option value="twitch">Twitch</option>
                  <option value="youtube">YouTube</option>
                </select>

                <label className="field-label" htmlFor="target-value">
                  Target
                </label>
                <input
                  id="target-value"
                  className="text-input"
                  value={targetValue}
                  onChange={(event) => setTargetValue(event.target.value)}
                  placeholder={targetPlatform === "twitch" ? "user_login" : "videoId (11 chars)"}
                  disabled={busy}
                  required
                />

                <label className="targets__checkbox">
                  <input
                    type="checkbox"
                    checked={targetEnabled}
                    onChange={(event) => setTargetEnabled(event.target.checked)}
                    disabled={busy}
                  />
                  Ativo
                </label>

                <div className="targets__form-actions">
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || !targetValue.trim()}
                  >
                    {pending === "save-target"
                      ? "Salvando..."
                      : editingTargetId
                        ? "Salvar Edicao"
                        : "Adicionar Target"}
                  </button>
                  {editingTargetId && (
                    <button
                      type="button"
                      className="btn"
                      onClick={resetTargetForm}
                      disabled={busy}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </form>
            </aside>

            <div className="targets__catalog">
              <h3>Lista de targets</h3>
              <div className="targets__list">
                {viewerTargets.length === 0 ? (
                  <div className="targets__empty">Nenhum target configurado.</div>
                ) : (
                  viewerTargets.map((target) => (
                    <div className="target-row" key={target._id}>
                      <div className="target-row__main">
                        <div className="target-row__name">
                          <span className="target-row__platform">{target.platform.toUpperCase()}</span>
                          <span>{target.target}</span>
                        </div>
                        <div className="target-row__meta">
                          <span>{target.enabled ? "ativo" : "desativado"}</span>
                          <span>{target.isLive ? `${target.viewerCount} ao vivo` : "offline"}</span>
                          <span>ultimo poll: {formatLastPolled(target.lastPolledAt)}</span>
                          {target.lastError && <span className="target-row__error">{target.lastError}</span>}
                        </div>
                      </div>
                      <div className="target-row__actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => onEditViewerTarget(target)}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger"
                          disabled={busy}
                          onClick={() => onDeleteViewerTarget(target._id)}
                        >
                          Remover
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="targets__workspace">
            <aside className="targets__editor">
              <h3>Telegram votacao</h3>
              <form className="targets__form" onSubmit={onSaveTelegramConfig}>
                <label className="field-label" htmlFor="telegram-channel-id">
                  Channel ID
                </label>
                <input
                  id="telegram-channel-id"
                  className="text-input"
                  value={telegramChannelIdInput}
                  onChange={(event) => setTelegramChannelIdInput(event.target.value)}
                  placeholder="@seu_canal ou -1001234567890"
                  disabled={busy}
                />

                <label className="field-label" htmlFor="telegram-bot-token">
                  Bot token (opcional para manter)
                </label>
                <input
                  id="telegram-bot-token"
                  type="password"
                  className="text-input"
                  value={telegramBotTokenInput}
                  onChange={(event) => setTelegramBotTokenInput(event.target.value)}
                  placeholder={telegramConfig?.hasBotToken ? "Token ja configurado" : "123456:ABCDEF..."}
                  disabled={busy}
                />

                <label className="targets__checkbox">
                  <input
                    type="checkbox"
                    checked={telegramEnabledInput}
                    onChange={(event) => setTelegramEnabledInput(event.target.checked)}
                    disabled={busy}
                  />
                  Ativar integracao Telegram
                </label>

                <div className="targets__form-actions">
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || (telegramEnabledInput && !telegramChannelIdInput.trim())}
                  >
                    {pending === "save-telegram-config" ? "Salvando..." : "Salvar Telegram"}
                  </button>
                </div>
              </form>
            </aside>

            <div className="targets__catalog">
              <h3>Status Telegram</h3>
              <div className="targets__list">
                <div className="target-row target-row--telegram">
                  <div className="target-row__main">
                    <div className="target-row__name">
                      <span className="target-row__platform">TELEGRAM</span>
                      <span>{telegramConfig?.channelId || "canal nao configurado"}</span>
                    </div>
                    <div className="target-row__meta">
                      <span>{telegramConfig?.enabled ? "ativo" : "desativado"}</span>
                      <span>
                        token:{" "}
                        {telegramConfig?.hasBotToken
                          ? (telegramConfig?.tokenPreview ?? "configurado")
                          : "nao configurado"}
                      </span>
                      <span>ultimo poll: {formatLastPolled(telegramConfig?.lastPolledAt ?? undefined)}</span>
                      {telegramConfig?.lastError && <span className="target-row__error">{telegramConfig.lastError}</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        )}

        {activePage === "projections" && (
          <section className="projections">
            <div className="section-head">
              <div>
                <h2>Projecoes e Calculo de Preco</h2>
                <p className="muted">
                  Baseado em custos recentes, intervalos observados e quantidade de modelos por papel.
                </p>
              </div>
              <button type="button" className="btn" disabled={busy} onClick={onRefreshModels}>
                {pending === "refresh-models" ? "Atualizando..." : "Atualizar dados"}
              </button>
            </div>

            {shouldShowProjectionBootstrapBanner && (
              <div className="error-banner">
                {projectionBootstrapFailed
                  ? `Falha ao gerar baseline de projecao. Faltam ${projectionMissingSamples} samples.`
                  : `Gerando baseline real para projecao. Faltam ${projectionMissingSamples} samples.`}
              </div>
            )}

            <div className="models__hourly-cards">
              <div className="hour-card">
                <span className="hour-card__label">Media/h estimada</span>
                <strong className="hour-card__value">{formatUsd(totalHourlyCostUsd)}</strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Projecao diaria (24h)</span>
                <strong className="hour-card__value">{formatUsd(projectedDailyCostUsd)}</strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Projecao semanal (7d)</span>
                <strong className="hour-card__value">{formatUsd(projectedWeeklyCostUsd)}</strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Projecao mensal (30d)</span>
                <strong className="hour-card__value">{formatUsd(projectedMonthlyCostUsd)}</strong>
              </div>
            </div>

            <div className="models__hourly-cards">
              <div className="hour-card">
                <span className="hour-card__label">Rodadas por hora</span>
                <strong className="hour-card__value">
                  {projectedRoundsPerHour === null ? "N/D" : projectedRoundsPerHour.toFixed(2)}
                </strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Custo por rodada</span>
                <strong className="hour-card__value">{formatUsd(projectedRoundCostUsd)}</strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Ciclo medio por rodada</span>
                <strong className="hour-card__value">{formatSecondsFromMs(projectedRoundCycleMs)}</strong>
              </div>
              <div className="hour-card">
                <span className="hour-card__label">Confianca da previsao</span>
                <strong className="hour-card__value">
                  {projectionReady && projection ? `${projection.confidencePercent}%` : "N/D"}
                </strong>
              </div>
            </div>

            <div className="projections__workspace">
              <aside className="projections__calculator">
                <h3>Calculadora</h3>
                <p className="muted">
                  Ajuste tempos de votacao e intervalo para recalcular custo em tempo real.
                </p>
                <div className="projections__fields">
                  <label className="field-label" htmlFor="proj-vote-active">
                    Votacao com espectadores (s)
                  </label>
                  <input
                    id="proj-vote-active"
                    className="text-input"
                    type="number"
                    min={5}
                    step={0.5}
                    value={voteWindowActiveSecondsInput}
                    onChange={(event) => setVoteWindowActiveSecondsInput(event.target.value)}
                    disabled={busy || !projection}
                  />

                  <label className="field-label" htmlFor="proj-vote-idle">
                    Votacao sem espectadores (s)
                  </label>
                  <input
                    id="proj-vote-idle"
                    className="text-input"
                    type="number"
                    min={5}
                    step={0.5}
                    value={voteWindowIdleSecondsInput}
                    onChange={(event) => setVoteWindowIdleSecondsInput(event.target.value)}
                    disabled={busy || !projection}
                  />

                  <label className="field-label" htmlFor="proj-delay-active">
                    Intervalo com espectadores (s)
                  </label>
                  <input
                    id="proj-delay-active"
                    className="text-input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={postRoundDelayActiveSecondsInput}
                    onChange={(event) => setPostRoundDelayActiveSecondsInput(event.target.value)}
                    disabled={busy || !projection}
                  />
                </div>

                <div className="projections__timing-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || !projection || !isProjectionTimingDirty}
                    onClick={onSaveProjectionTiming}
                  >
                    {pending === "save-projection-timing" ? "Salvando..." : "Salvar tempos da rodada"}
                  </button>
                  <span className="projections__timing-note">
                    Intervalo sem espectadores:{" "}
                    {projection ? formatSecondsFromMs(projection.timing.postRoundDelayIdleMs) : "N/D"}
                  </span>
                  <span className="projections__timing-note">
                    Share com espectadores: {formatPercent(projectionViewerRoundShare * 100)}
                  </span>
                  <span className="projections__timing-note">
                    Amostras: {projection?.samples.rounds ?? 0} rodadas, {projection?.samples.events ?? 0} requests
                  </span>
                </div>

                <div className="projections__fields">
                  <label className="field-label" htmlFor="calc-hours-day">
                    Horas por dia
                  </label>
                  <input
                    id="calc-hours-day"
                    className="text-input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={calcHoursPerDayInput}
                    onChange={(event) => setCalcHoursPerDayInput(event.target.value)}
                  />

                  <label className="field-label" htmlFor="calc-days-week">
                    Dias por semana
                  </label>
                  <input
                    id="calc-days-week"
                    className="text-input"
                    type="number"
                    min={0}
                    step={1}
                    value={calcDaysPerWeekInput}
                    onChange={(event) => setCalcDaysPerWeekInput(event.target.value)}
                  />

                  <label className="field-label" htmlFor="calc-days-month">
                    Dias por mes
                  </label>
                  <input
                    id="calc-days-month"
                    className="text-input"
                    type="number"
                    min={0}
                    step={1}
                    value={calcDaysPerMonthInput}
                    onChange={(event) => setCalcDaysPerMonthInput(event.target.value)}
                  />

                  <label className="field-label" htmlFor="calc-budget-month">
                    Budget mensal (USD)
                  </label>
                  <input
                    id="calc-budget-month"
                    className="text-input"
                    type="number"
                    min={0}
                    step={10}
                    value={calcMonthlyBudgetInput}
                    onChange={(event) => setCalcMonthlyBudgetInput(event.target.value)}
                  />
                </div>

                <div className="projections__totals">
                  <div className="hour-card">
                    <span className="hour-card__label">Sua projecao diaria</span>
                    <strong className="hour-card__value">{formatUsd(customDailyCostUsd)}</strong>
                  </div>
                  <div className="hour-card">
                    <span className="hour-card__label">Sua projecao semanal</span>
                    <strong className="hour-card__value">{formatUsd(customWeeklyCostUsd)}</strong>
                  </div>
                  <div className="hour-card">
                    <span className="hour-card__label">Sua projecao mensal</span>
                    <strong className="hour-card__value">{formatUsd(customMonthlyCostUsd)}</strong>
                  </div>
                </div>

                <div className="projections__budget">
                  <span className="projections__budget-label">Uso do budget mensal</span>
                  <strong
                    className={`projections__budget-value ${
                      budgetUsagePercent > 100 ? "projections__budget-value--over" : ""
                    }`}
                  >
                    {formatPercent(budgetUsagePercent)}
                  </strong>
                  <span
                    className={`projections__budget-delta ${
                      budgetRemainingUsd !== null && budgetRemainingUsd < 0
                        ? "projections__budget-delta--over"
                        : ""
                    }`}
                  >
                    {budgetRemainingUsd === null ? "Saldo: N/D" : `Saldo: ${formatUsd(budgetRemainingUsd)}`}
                  </span>
                  <span className="projections__budget-delta">
                    Horas/mes suportadas:{" "}
                    {affordableHoursPerMonth === null ? "N/D" : affordableHoursPerMonth.toFixed(1)}
                  </span>
                </div>
              </aside>

              <div className="projections__analytics">
                <div className="projections__action-summary">
                  <h3>Composicao total por acao</h3>
                  <div className="projections__action-bar" aria-hidden="true">
                    <span
                      className="models__share-segment models__share-segment--prompt"
                      style={{ width: `${actionTotals.promptPercent}%` }}
                    />
                    <span
                      className="models__share-segment models__share-segment--answer"
                      style={{ width: `${actionTotals.answerPercent}%` }}
                    />
                    <span
                      className="models__share-segment models__share-segment--vote"
                      style={{ width: `${actionTotals.votePercent}%` }}
                    />
                  </div>
                  <div className="projections__action-legend">
                    <span>
                      Prompt: {formatUsd(actionTotals.promptHourlyUsd)}/h ({formatPercent(actionTotals.promptPercent)})
                    </span>
                    <span>
                      Resposta: {formatUsd(actionTotals.answerHourlyUsd)}/h (
                      {formatPercent(actionTotals.answerPercent)})
                    </span>
                    <span>
                      Voto: {formatUsd(actionTotals.voteHourlyUsd)}/h ({formatPercent(actionTotals.votePercent)})
                    </span>
                    <span>
                      Janela de voto efetiva: {formatSecondsFromMs(effectiveVoteWindowMs)}
                    </span>
                    <span>
                      Intervalo efetivo: {formatSecondsFromMs(effectivePostRoundDelayMs)}
                    </span>
                  </div>
                </div>

                <div className="models__share-chart" aria-label="Participacao por modelo no custo medio por hora">
                  <h3>Participacao por modelo com divisao por acao</h3>
                  {activeHourlyCompositionRows.length === 0 ? (
                    <div className="targets__empty">Sem modelos ativos para calcular participacao.</div>
                  ) : (
                    <div className="models__share-list">
                      {activeHourlyCompositionRows.map((row) => {
                        const width = Math.min(100, Math.max(0, row.sharePercent));
                        return (
                          <div key={row.modelId} className="models__share-row">
                            <div className="models__share-meta">
                              <span className="models__share-name">
                                <span className="model-row__swatch" style={{ background: row.color }} />
                                {row.name}
                              </span>
                              <span className="models__share-values">
                                {formatUsd(row.avgCostPerHourUsd)}/h | {formatPercent(row.sharePercent)}
                              </span>
                            </div>
                            <div className="models__share-bar" aria-hidden="true">
                              <div className="models__share-fill" style={{ width: `${width}%` }}>
                                <span
                                  className="models__share-segment models__share-segment--prompt"
                                  style={{ width: `${row.promptSharePercent}%` }}
                                />
                                <span
                                  className="models__share-segment models__share-segment--answer"
                                  style={{ width: `${row.answerSharePercent}%` }}
                                />
                                <span
                                  className="models__share-segment models__share-segment--vote"
                                  style={{ width: `${row.voteSharePercent}%` }}
                                />
                              </div>
                            </div>
                            <div className="models__share-actions">
                              <span>
                                P: {formatPercent(row.promptSharePercent)} ({formatUsd(row.promptHourlyUsd)}/h)
                              </span>
                              <span>
                                R: {formatPercent(row.answerSharePercent)} ({formatUsd(row.answerHourlyUsd)}/h)
                              </span>
                              <span>
                                V: {formatPercent(row.voteSharePercent)} ({formatUsd(row.voteHourlyUsd)}/h)
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {isModelFormOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal modal--model">
            <div className="models__editor-head">
              <h2>{editingModelOriginalId ? "Editar modelo" : "Novo modelo"}</h2>
              <button type="button" className="btn" onClick={resetModelForm} disabled={busy}>
                Fechar
              </button>
            </div>
            {editingModelOriginalId && (
              <p className="muted">
                Editando modelo: <code>{editingModelOriginalId}</code>
              </p>
            )}
            <form className="models__form" onSubmit={onSaveModel}>
              <label className="field-label" htmlFor="model-id">
                Model ID
              </label>
              <input
                id="model-id"
                className="text-input"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="openai/gpt-5.2"
                disabled={busy}
                required
              />

              <label className="field-label" htmlFor="model-name">
                Nome
              </label>
              <input
                id="model-name"
                className="text-input"
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
                placeholder="GPT-5.2"
                disabled={busy}
                required
              />

              <label className="field-label" htmlFor="model-color">
                Cor
              </label>
              <div className="models__color-field" id="model-color" role="radiogroup" aria-label="Cor do modelo">
                <div className="models__color-palette">
                  {modelColorOptions.map((colorValue) => {
                    const selected = normalizeHexColor(modelColor) === colorValue;
                    return (
                      <button
                        key={colorValue}
                        type="button"
                        className={`model-color-swatch ${selected ? "model-color-swatch--selected" : ""}`}
                        style={{ backgroundColor: colorValue }}
                        onClick={() => setModelColor(colorValue)}
                        disabled={busy}
                        title={colorValue}
                        aria-label={`Selecionar cor ${colorValue}`}
                        aria-checked={selected}
                        role="radio"
                      />
                    );
                  })}
                </div>
                <span className="models__color-value">{normalizeHexColor(modelColor)}</span>
              </div>

              <label className="field-label" htmlFor="model-logo">
                Logo
              </label>
              <select
                id="model-logo"
                className="text-input"
                value={modelLogoId}
                onChange={(event) =>
                  setModelLogoId(event.target.value as (typeof AVAILABLE_MODEL_LOGO_IDS)[number])
                }
                disabled={busy}
              >
                {AVAILABLE_MODEL_LOGO_IDS.map((logoId) => (
                  <option key={logoId} value={logoId}>
                    {logoId}
                  </option>
                ))}
              </select>

              <label className="field-label" htmlFor="model-reasoning-effort">
                Reasoning Effort
              </label>
              <select
                id="model-reasoning-effort"
                className="text-input"
                value={modelReasoningEffort}
                onChange={(event) =>
                  setModelReasoningEffort(
                    event.target.value as ModelReasoningEffortFormValue,
                  )
                }
                disabled={busy}
              >
                <option value={REASONING_EFFORT_UNDEFINED}>{DEFAULT_REASONING_LABEL}</option>
                {AVAILABLE_REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>

              <label className="models__checkbox">
                <input
                  type="checkbox"
                  checked={modelCanPrompt}
                  onChange={(event) => setModelCanPrompt(event.target.checked)}
                  disabled={busy}
                />
                Pode escrever prompt
              </label>

              <label className="models__checkbox">
                <input
                  type="checkbox"
                  checked={modelCanAnswer}
                  onChange={(event) => setModelCanAnswer(event.target.checked)}
                  disabled={busy}
                />
                Pode responder
              </label>

              <label className="models__checkbox">
                <input
                  type="checkbox"
                  checked={modelCanVote}
                  onChange={(event) => setModelCanVote(event.target.checked)}
                  disabled={busy}
                />
                Pode votar
              </label>

              <label className="models__checkbox">
                <input
                  type="checkbox"
                  checked={modelEnabled}
                  onChange={(event) => setModelEnabled(event.target.checked)}
                  disabled={busy}
                />
                Criar como ativo
              </label>

              <div className="models__form-actions">
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || !modelId.trim() || !modelName.trim()}
                >
                  {pending === "save-model"
                    ? "Salvando..."
                    : editingModelOriginalId
                      ? "Salvar Edicao"
                      : "Salvar Modelo"}
                </button>
                <button type="button" className="btn" onClick={resetModelForm} disabled={busy}>
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isResetOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Resetar todos os dados?</h2>
            <p>
              Isso apaga permanentemente todas as rodadas salvas e zera a
              pontuacao. O fluxo atual do jogo tambem e pausado.
            </p>
            <p>
              Digite <code>{RESET_TOKEN}</code> para continuar.
            </p>
            <input
              type="text"
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              className="text-input"
              placeholder={RESET_TOKEN}
              autoFocus
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setIsResetOpen(false);
                  setResetText("");
                }}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={onReset}
                disabled={busy || resetText !== RESET_TOKEN}
              >
                {pending === "reset" ? "Resetando..." : "Confirmar Reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

