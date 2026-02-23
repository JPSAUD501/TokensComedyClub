import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AVAILABLE_MODEL_COLORS,
  AVAILABLE_MODEL_LOGO_IDS,
  AVAILABLE_REASONING_EFFORTS,
  DEFAULT_MODEL_REASONING_EFFORT,
  normalizeModelReasoningEffort,
  normalizeHexColor,
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
  runBlockedReason: "insufficient_active_models" | null;
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
type ModelsResponse = { ok: true; models: ModelCatalogEntry[] } & Partial<AdminSnapshot>;
type Mode = "checking" | "locked" | "ready";

const RESET_TOKEN = "RESET";
const ADMIN_PASSCODE_KEY = "tokenscomedyclub.adminPasscode";

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

function formatArchivedAt(archivedAt?: number): string {
  if (!archivedAt) return "ativo";
  return `arquivado em ${new Date(archivedAt).toLocaleString("pt-BR")}`;
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
  const [viewerTargets, setViewerTargets] = useState<ViewerTarget[]>([]);
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [targetPlatform, setTargetPlatform] = useState<"twitch" | "youtube">("twitch");
  const [targetValue, setTargetValue] = useState("");
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelColor, setModelColor] = useState<string>(AVAILABLE_MODEL_COLORS[0]);
  const [modelLogoId, setModelLogoId] = useState<(typeof AVAILABLE_MODEL_LOGO_IDS)[number]>("openai");
  const [modelReasoningEffort, setModelReasoningEffort] = useState<(typeof AVAILABLE_REASONING_EFFORTS)[number]>(
    DEFAULT_MODEL_REASONING_EFFORT,
  );
  const [modelEnabled, setModelEnabled] = useState(true);
  const [editingModelOriginalId, setEditingModelOriginalId] = useState<string | null>(null);
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  const [showArchivedModels, setShowArchivedModels] = useState(false);

  async function loadViewerTargets(passcodeToUse: string) {
    const response = await requestAdminJson<ViewerTargetsResponse>(
      "/admin/viewer-targets",
      passcodeToUse,
    );
    setViewerTargets(response.targets);
  }

  async function loadModels(passcodeToUse: string) {
    const response = await requestAdminJson<ModelsResponse>("/admin/models", passcodeToUse);
    setModels(response.models);
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
            loadModels(storedPasscode),
          ]);
        } catch {
          setViewerTargets([]);
          setModels([]);
        }
      })
      .catch(() => {
        setSnapshot(null);
        setMode("locked");
      });
  }, []);

  const busy = useMemo(() => pending !== null, [pending]);
  const activeModels = useMemo(
    () => models.filter((model) => model.enabled && !model.archivedAt),
    [models],
  );
  const visibleModels = useMemo(
    () => (showArchivedModels ? models : models.filter((model) => !model.archivedAt)),
    [models, showArchivedModels],
  );
  const modelColorOptions = useMemo(() => {
    const normalizedSelected = normalizeHexColor(modelColor);
    if (AVAILABLE_MODEL_COLORS.includes(normalizedSelected as (typeof AVAILABLE_MODEL_COLORS)[number])) {
      return AVAILABLE_MODEL_COLORS;
    }
    return [normalizedSelected, ...AVAILABLE_MODEL_COLORS];
  }, [modelColor]);

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
    setEditingModelOriginalId(null);
    setIsModelFormOpen(true);
  }

  function hydrateModelForm(model: ModelCatalogEntry) {
    setModelId(model.modelId);
    setModelName(model.name);
    setModelColor(normalizeHexColor(model.color));
    setModelLogoId(model.logoId);
    setModelReasoningEffort(normalizeModelReasoningEffort(model.reasoningEffort));
    setModelEnabled(model.enabled);
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
      await Promise.all([loadViewerTargets(passcode), loadModels(passcode)]);
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
      await loadViewerTargets(passcodeValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao recarregar targets");
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

  async function onSaveModel(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending("save-model");
    try {
      const passcodeValue = readStoredPasscode();
      const isEditing = Boolean(editingModelOriginalId);
      const path = isEditing ? "/admin/models/update" : "/admin/models";
      const body = isEditing
        ? {
            originalModelId: editingModelOriginalId,
            modelId: modelId.trim(),
            name: modelName.trim(),
            color: normalizeHexColor(modelColor),
            logoId: modelLogoId,
            reasoningEffort: normalizeModelReasoningEffort(modelReasoningEffort),
            enabled: modelEnabled,
          }
        : {
            modelId: modelId.trim(),
            name: modelName.trim(),
            color: normalizeHexColor(modelColor),
            logoId: modelLogoId,
            reasoningEffort: normalizeModelReasoningEffort(modelReasoningEffort),
            enabled: modelEnabled,
          };
      const data = await requestAdminJson<ModelsResponse>(path, passcodeValue, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setModels(data.models);
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
      setViewerTargets([]);
      setPasscode("");
      resetTargetForm();
      resetModelForm();
      setMode("locked");
    } finally {
      setPending(null);
    }
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
          <a href="/index.html" className="logo-link">
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
            <a href="/index.html">Jogo Ao Vivo</a>
            <a href="/history.html">Historico</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <a href="/index.html" className="logo-link">
          <img src="/assets/logo.svg" alt="TokensComedyClub" />
        </a>
        <nav className="quick-links">
          <a href="/index.html">Jogo Ao Vivo</a>
          <a href="/history.html">Historico</a>
          <button className="link-button" onClick={onLogout} disabled={busy}>
            Sair
          </button>
        </nav>
      </header>

      <main className="panel panel--main">
        <div className="panel-head">
          <h1>Console Admin</h1>
          <p>
            Pausar ou retomar o loop do jogo, gerenciar o catalogo de modelos,
            exportar dados e configurar targets de audiencia para Twitch e YouTube.
          </p>
        </div>

        {error && <div className="error-banner">{error}</div>}

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
            value={snapshot?.canRunRounds ? "Pronto" : "Bloqueado (<3 modelos)"}
          />
          <StatusCard label="Espectadores" value={String(snapshot?.viewerCount ?? 0)} />
        </section>

        {snapshot?.runBlockedReason === "insufficient_active_models" && (
          <div className="error-banner">
            Motor aguardando: ative ao menos 3 modelos para voltar a gerar rodadas.
          </div>
        )}

        <section className="actions" aria-label="Acoes admin">
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
        </section>

        <section className="models">
          <div className="models__header">
            <h2>Modelos</h2>
            <div className="models__header-actions">
              <span className="models__count">
                {activeModels.length} ativos de {models.length}
              </span>
              <label className="models__checkbox">
                <input
                  type="checkbox"
                  checked={showArchivedModels}
                  onChange={(event) => setShowArchivedModels(event.target.checked)}
                  disabled={busy}
                />
                Mostrar arquivados
              </label>
              <button type="button" className="btn" disabled={busy} onClick={onRefreshModels}>
                {pending === "refresh-models" ? "Atualizando..." : "Atualizar"}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={openCreateModelForm}
              >
                Adicionar modelo
              </button>
            </div>
          </div>
          <p className="muted">
            Adicione modelos, habilite/desabilite sem apagar dados e arquive quando nao quiser mais usar.
          </p>
          {isModelFormOpen ? (
            <>
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
                  event.target.value as (typeof AVAILABLE_REASONING_EFFORTS)[number],
                )
              }
              disabled={busy}
            >
              {AVAILABLE_REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>

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
            </>
          ) : (
            <p className="muted">Clique em <code>Adicionar modelo</code> para abrir o formulario.</p>
          )}

          <div className="models__list">
            {visibleModels.length === 0 ? (
              <div className="targets__empty">
                {models.length === 0
                  ? "Nenhum modelo cadastrado."
                  : "Nenhum modelo visivel com o filtro atual."}
              </div>
            ) : (
              visibleModels.map((model) => {
                const archived = Boolean(model.archivedAt);
                return (
                <div className="model-row" key={model.modelId}>
                  <div className="model-row__meta">
                    <div className="model-row__name-wrap">
                      <span className="model-row__swatch" style={{ background: model.color }} />
                      <span className="model-row__name">{model.name}</span>
                      <span
                        className={`model-row__state ${archived ? "model-row__state--archived" : ""}`}
                      >
                        {archived ? "arquivado" : model.enabled ? "ativo" : "inativo"}
                      </span>
                    </div>
                    <span className="model-row__id">{model.modelId}</span>
                    <span className="model-row__id">
                      logo: {model.logoId} | effort: {normalizeModelReasoningEffort(model.reasoningEffort)} |{" "}
                      {formatArchivedAt(model.archivedAt)}
                    </span>
                  </div>
                  <div className="model-row__actions">
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
                </div>
              )})
            )}
          </div>
        </section>

        <section className="targets">
          <div className="targets__header">
            <h2>Targets de Audiencia</h2>
            <button type="button" className="btn" disabled={busy} onClick={onRefreshTargets}>
              {pending === "refresh-targets" ? "Atualizando..." : "Atualizar"}
            </button>
          </div>
          <p className="muted">
            Twitch usa <code>user_login</code>. YouTube usa <code>videoId</code>.
          </p>

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
        </section>
      </main>

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

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
