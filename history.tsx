import React from "react";
import { ConvexProvider, ConvexReactClient, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "./convex/_generated/api";
import { getLogoUrlById, normalizeHexColor, type ModelCatalogEntry } from "./shared/models";
import { FRONTEND_VIEWER_HEARTBEAT_MS, VIEWER_ID_STORAGE_KEY } from "./config";
import "./history.css";

// ── Types ───────────────────────────────────────────────────────────────────

type Model = { id: string; name: string; color?: string; logoId?: string };
type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
};
type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  error?: boolean;
};
type RoundState = {
  _id?: string;
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  skipped?: boolean;
  skipReason?: string;
  skipType?: "prompt_error" | "answer_error";
  prompter: Model;
  promptTask: TaskInfo;
  prompt?: string;
  contestants: [Model, Model];
  answerTasks: [TaskInfo, TaskInfo];
  votes: VoteInfo[];
  scoreA?: number;
  scoreB?: number;
  viewerVotesA?: number;
  viewerVotesB?: number;
};

// ── Shared UI Utils ─────────────────────────────────────────────────────────

const DEFAULT_UI_COLOR = "#A1A1A1";
let modelCatalogByName = new Map<string, ModelCatalogEntry>();

function syncModelCatalog(models: ModelCatalogEntry[]) {
  modelCatalogByName = new Map(models.map((model) => [model.name, model]));
}

function getColor(name: string, fallbackColor?: string): string {
  const fromCatalog = modelCatalogByName.get(name);
  if (fromCatalog) return normalizeHexColor(fromCatalog.color);
  return normalizeHexColor(fallbackColor) || DEFAULT_UI_COLOR;
}

function getLogo(name: string, fallbackLogoId?: string): string | null {
  const fromCatalog = modelCatalogByName.get(name);
  if (fromCatalog) return getLogoUrlById(fromCatalog.logoId);
  return getLogoUrlById(fallbackLogoId);
}

function getConvexUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_CONVEX_URL;
  if (!url) throw new Error("VITE_CONVEX_URL is not configured");
  return url.replace(/\/$/, "");
}

function getOrCreateViewerId(): string {
  const key = VIEWER_ID_STORAGE_KEY;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(key, generated);
  return generated;
}

function isGhostViewer(): boolean {
  const value = (new URLSearchParams(window.location.search).get("ghost") ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

const convex = new ConvexReactClient(getConvexUrl());
const convexApi = api as any;

function ModelName({
  model,
  className = "",
}: {
  model: Model;
  className?: string;
}) {
  const logo = getLogo(model.name, model.logoId);
  const color = getColor(model.name, model.color);
  return (
    <span className={`model-name ${className}`} style={{ color }}>
      {logo && <img src={logo} alt="" className="model-logo" />}
      {model.name}
    </span>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

function HistoryContestant({
  task,
  votes,
  voters,
}: {
  task: TaskInfo;
  votes: number;
  voters: Model[];
}) {
  const color = getColor(task.model.name, task.model.color);
  return (
    <div className={`history-contestant`} style={{ borderColor: color }}>
      <div className="history-contestant__header">
        <ModelName model={task.model} />
      </div>
      <div className="history-contestant__answer">
        &ldquo;{task.result}&rdquo;
      </div>
      <div className="history-contestant__votes">
        <div className="history-contestant__score" style={{ color }}>
          {votes} {votes === 1 ? "voto" : "votos"}
        </div>
        <div className="history-contestant__voters">
          {voters.map((v) => {
            const logo = getLogo(v.name, v.logoId);
            if (!logo) return null;
            return (
              <img
                key={v.name}
                src={logo}
                title={v.name}
                alt={v.name}
                className="voter-mini-logo"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ViewerVotes({ count, label }: { count: number; label: string }) {
  return (
    <div className="history-contestant__viewer-votes">
      <span className="history-contestant__viewer-icon">👥</span>
      <span className="history-contestant__viewer-count">
        {count} {label}
      </span>
    </div>
  );
}

function HistoryCard({ round }: { round: RoundState }) {
  const [contA, contB] = round.contestants;
  const isSkipped = Boolean(round.skipped);

  let votesA = 0,
    votesB = 0;
  const votersA: Model[] = [];
  const votersB: Model[] = [];

  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) {
      votesA++;
      votersA.push(v.voter);
    } else if (v.votedFor?.name === contB.name) {
      votesB++;
      votersB.push(v.voter);
    }
  }

  const isAWinner = !isSkipped && votesA > votesB;
  const isBWinner = !isSkipped && votesB > votesA;
  const totalViewerVotes = (round.viewerVotesA ?? 0) + (round.viewerVotesB ?? 0);

  return (
    <div className="history-card">
      <div className="history-card__header">
        <div className="history-card__prompt-section">
          <div className="history-card__prompter">
            Prompt de <ModelName model={round.prompter} />
          </div>
          <div className="history-card__prompt">{round.prompt}</div>
        </div>
        <div className="history-card__meta">
          <div>R{round.num}</div>
        </div>
      </div>

      {isSkipped && (
        <div className="history-card__skipped">
          <span className="history-card__skipped-label">Rodada pulada por falha</span>
          <span className="history-card__skipped-reason">{round.skipReason ?? "Falha tecnica"}</span>
        </div>
      )}

      {round.skipType !== "prompt_error" && (
      <div className="history-card__showdown">
        <div
          className={`history-contestant ${isAWinner ? "history-contestant--winner" : ""}`}
        >
          <div className="history-contestant__header">
            <ModelName model={contA} />
            {isAWinner && (
              <div className="history-contestant__winner-badge">VENCEDOR</div>
            )}
          </div>
          <div className="history-contestant__answer">
            &ldquo;{round.answerTasks[0].result ?? "Sem resposta"}&rdquo;
          </div>
          <div className="history-contestant__votes">
            <div
              className="history-contestant__score"
              style={{ color: getColor(contA.name, contA.color) }}
            >
              {votesA} {votesA === 1 ? "voto" : "votos"}
            </div>
            <div className="history-contestant__voters">
              {votersA.map(
                (v) =>
                  getLogo(v.name, v.logoId) && (
                    <img
                      key={v.name}
                      src={getLogo(v.name, v.logoId)!}
                      title={v.name}
                      className="voter-mini-logo"
                    />
                  ),
              )}
            </div>
          </div>
          {totalViewerVotes > 0 && (
            <ViewerVotes
              count={round.viewerVotesA ?? 0}
              label={`voto${(round.viewerVotesA ?? 0) === 1 ? "" : "s"} da plateia`}
            />
          )}
        </div>

        <div
          className={`history-contestant ${isBWinner ? "history-contestant--winner" : ""}`}
        >
          <div className="history-contestant__header">
            <ModelName model={contB} />
            {isBWinner && (
              <div className="history-contestant__winner-badge">VENCEDOR</div>
            )}
          </div>
          <div className="history-contestant__answer">
            &ldquo;{round.answerTasks[1].result ?? "Sem resposta"}&rdquo;
          </div>
          <div className="history-contestant__votes">
            <div
              className="history-contestant__score"
              style={{ color: getColor(contB.name, contB.color) }}
            >
              {votesB} {votesB === 1 ? "voto" : "votos"}
            </div>
            <div className="history-contestant__voters">
              {votersB.map(
                (v) =>
                  getLogo(v.name, v.logoId) && (
                    <img
                      key={v.name}
                      src={getLogo(v.name, v.logoId)!}
                      title={v.name}
                      className="voter-mini-logo"
                    />
                  ),
              )}
            </div>
          </div>
          {totalViewerVotes > 0 && (
            <ViewerVotes
              count={round.viewerVotesB ?? 0}
              label={`voto${(round.viewerVotesB ?? 0) === 1 ? "" : "s"} da plateia`}
            />
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const liveState = useQuery(convexApi.live.getState, {}) as
    | { data: { models: ModelCatalogEntry[] } }
    | undefined;
  const { results, status, loadMore } = usePaginatedQuery(
    convexApi.history.listPaginated,
    {},
    { initialNumItems: 10 },
  );
  const rounds = results as RoundState[];

  const ensureStarted = useMutation(convexApi.live.ensureStarted);
  const heartbeat = useMutation(convexApi.viewers.heartbeat);
  const ghostViewer = React.useMemo(() => isGhostViewer(), []);

  React.useEffect(() => {
    syncModelCatalog(liveState?.data.models ?? []);
  }, [liveState?.data.models]);

  React.useEffect(() => {
    const viewerId = getOrCreateViewerId();
    void ensureStarted({});

    if (ghostViewer) {
      return;
    }

    void heartbeat({ viewerId, page: "live" });
    const interval = setInterval(() => {
      void heartbeat({ viewerId, page: "live" });
    }, FRONTEND_VIEWER_HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [ensureStarted, heartbeat, ghostViewer]);

  return (
    <div className="app history-page">
      <a href="/" className="history-main-logo">
        <img src="/assets/logo.svg" alt="TokensComedyClub" />
      </a>
      <main className="history-main">
        <div className="history-page-header">
          <div className="history-page-title">Rodadas Anteriores</div>
          <div className="history-page-links">
            <a href="/" className="history-back-link">
              Voltar ao Jogo
            </a>
          </div>
        </div>

        {status === "LoadingFirstPage" ? (
          <div className="history-loading">Carregando...</div>
        ) : rounds.length === 0 ? (
          <div className="history-empty">Nenhuma rodada anterior encontrada.</div>
        ) : (
          <>
            <div
              className="history-list"
              style={{ display: "flex", flexDirection: "column", gap: "32px" }}
            >
              {rounds.map((r) => (
                <HistoryCard key={r._id ?? String(r.num)} round={r} />
              ))}
            </div>

            {(status === "CanLoadMore" || status === "LoadingMore") && (
              <div className="pagination">
                <button
                  className="pagination__btn"
                  disabled={status !== "CanLoadMore"}
                  onClick={() => loadMore(10)}
                >
                  {status === "LoadingMore" ? "Carregando..." : "Carregar Mais"}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function HistoryPage() {
  return (
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  );
}

export default HistoryPage;

