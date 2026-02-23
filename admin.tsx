import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./admin.css";

type AdminSnapshot = {
  isPaused: boolean;
  isRunningRound: boolean;
  done: boolean;
  completedInMemory: number;
  persistedRounds: number;
  viewerCount: number;
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
type Mode = "checking" | "locked" | "ready";

const RESET_TOKEN = "RESET";
const ADMIN_PASSCODE_KEY = "papotorto.adminPasscode";

function getConvexUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_CONVEX_URL;
  if (!url) throw new Error("VITE_CONVEX_URL is not configured");
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

  const response = await fetch(`${getConvexUrl()}${path}`, {
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
  const mountedRef = React.useRef<boolean>(true);

  async function loadViewerTargets(passcodeToUse: string) {
    const response = await requestAdminJson<ViewerTargetsResponse>(
      "/admin/viewer-targets",
      passcodeToUse,
    );
    setViewerTargets(response.targets);
  }

  useEffect(() => {
    mountedRef.current = true;
    const storedPasscode = readStoredPasscode();
    if (!storedPasscode) {
      setMode("locked");
      return () => {
        mountedRef.current = false;
      };
    }

    requestAdminJson<AdminResponse>("/admin/status", storedPasscode)
      .then(async (data) => {
        if (!mountedRef.current) return;
        setSnapshot(data);
        setMode("ready");
        try {
          await loadViewerTargets(storedPasscode);
        } catch {
          if (!mountedRef.current) return;
          setViewerTargets([]);
        }
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setSnapshot(null);
        setMode("locked");
      });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const busy = useMemo(() => pending !== null, [pending]);

  function resetTargetForm() {
    setTargetPlatform("twitch");
    setTargetValue("");
    setTargetEnabled(true);
    setEditingTargetId(null);
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
      await loadViewerTargets(passcode);
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
      const response = await fetch(`${getConvexUrl()}/admin/export`, {
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
      const fileName = fileNameMatch?.[1] ?? `papotorto-export-${Date.now()}.json`;

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
      setViewerTargets([]);
      setPasscode("");
      resetTargetForm();
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
            <img src="/assets/logo.svg" alt="PapoTorto" />
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
          <img src="/assets/logo.svg" alt="PapoTorto" />
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
            Pausar ou retomar o loop do jogo, exportar dados e configurar
            targets de audiencia para Twitch e YouTube.
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
          <StatusCard label="Espectadores" value={String(snapshot?.viewerCount ?? 0)} />
        </section>

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
