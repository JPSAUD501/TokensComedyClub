import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { api } from "./convex/_generated/api";
import { createVotingCountdownTracker, type VotingCountdownView } from "./shared/countdown";
import {
  getLogoUrlById,
  normalizeHexColor,
  type ModelCatalogEntry,
} from "./shared/models";
import "./frontend.css";

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  viewerVotingEndsAt?: number;
};
type GameState = {
  lastCompleted: RoundState | null;
  active: RoundState | null;
  scores: Record<string, number>;
  humanScores: Record<string, number>;
  humanVoteTotals: Record<string, number>;
  models: ModelCatalogEntry[];
  enabledModelIds: string[];
  done: boolean;
  isPaused: boolean;
  generation: number;
  completedRounds: number;
};
type StateMessage = {
  type: "state";
  data: GameState;
  totalRounds: number;
  viewerCount: number;
  version?: string;
};
type ViewerCountMessage = {
  type: "viewerCount";
  viewerCount: number;
};
type VotedAckMessage = { type: "votedAck"; votedFor: "A" | "B" };
type ServerMessage = StateMessage | ViewerCountMessage | VotedAckMessage;

// â”€â”€ Model colors & logos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  const key = "tokenscomedyclub.viewerId";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  window.localStorage.setItem(key, generated);
  return generated;
}

function getEnabledModelNames(models: ModelCatalogEntry[]): string[] {
  return models
    .filter((model) => model.enabled && !model.archivedAt)
    .map((model) => model.name);
}

function isGhostViewer(): boolean {
  const value = (new URLSearchParams(window.location.search).get("ghost") ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

type RankingEntry = {
  name: string;
  score: number;
  tieTotal: number;
};

function collectRankingNames(...records: Record<string, number>[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      names.add(name);
    }
  }
  return [...names];
}

function namesAsScoreRecord(names: string[]): Record<string, number> {
  return names.reduce<Record<string, number>>((acc, name) => {
    acc[name] = 0;
    return acc;
  }, {});
}

function rankByScore(
  scores: Record<string, number>,
  tieTotals: Record<string, number>,
  fallbackNames: string[],
  allowedNames?: Set<string>,
): RankingEntry[] {
  const names = new Set<string>([
    ...fallbackNames,
    ...Object.keys(scores),
    ...Object.keys(tieTotals),
  ]);
  return [...names]
    .filter((name) => !allowedNames || allowedNames.has(name))
    .map((name) => ({
      name,
      score: scores[name] ?? 0,
      tieTotal: tieTotals[name] ?? 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.tieTotal !== a.tieTotal) return b.tieTotal - a.tieTotal;
      return a.name.localeCompare(b.name);
    });
}

type SkipReasonView = {
  modelName: string | null;
  message: string;
};

function parseSkipReason(skipReason?: string): SkipReasonView {
  const raw = (skipReason ?? "").trim();
  if (!raw) {
    return { modelName: null, message: "Falha tecnica" };
  }

  const separatorIndex = raw.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= raw.length - 1) {
    return { modelName: null, message: raw };
  }

  const modelName = raw.slice(0, separatorIndex).trim();
  const message = raw.slice(separatorIndex + 1).trim();
  if (!modelName || !message) {
    return { modelName: null, message: raw };
  }

  return { modelName, message };
}

const convex = new ConvexReactClient(getConvexUrl());
const convexApi = api as any;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Dots() {
  return (
    <span className="dots">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

function ModelTag({ model, small }: { model: Model; small?: boolean }) {
  const logo = getLogo(model.name, model.logoId);
  const color = getColor(model.name, model.color);
  return (
    <span
      className={`model-tag ${small ? "model-tag--sm" : ""}`}
      style={{ color }}
    >
      {logo && <img src={logo} alt="" className="model-tag__logo" />}
      {model.name}
    </span>
  );
}

// â”€â”€ Prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function PromptCard({ round }: { round: RoundState }) {
  if (round.phase === "prompting" && !round.prompt) {
    return (
      <div className="prompt">
        <div className="prompt__by">
          <ModelTag model={round.prompter} small /> esta escrevendo um prompt
          <Dots />
        </div>
        <div className="prompt__text prompt__text--loading">
          <Dots />
        </div>
      </div>
    );
  }

  if (round.promptTask.error) {
    return (
      <div className="prompt">
        <div className="prompt__text prompt__text--error">
          Falha ao gerar prompt
        </div>
      </div>
    );
  }

  return (
    <div className="prompt">
      <div className="prompt__by">
        Prompt de <ModelTag model={round.prompter} small />
      </div>
      <div className="prompt__text">{round.prompt}</div>
    </div>
  );
}

// â”€â”€ Contestant â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ContestantCard({
  task,
  voteCount,
  totalVotes,
  isWinner,
  showVotes,
  voters,
  viewerVotes,
  totalViewerVotes,
  votable,
  onVote,
  isMyVote,
}: {
  task: TaskInfo;
  voteCount: number;
  totalVotes: number;
  isWinner: boolean;
  showVotes: boolean;
  voters: VoteInfo[];
  viewerVotes?: number;
  totalViewerVotes?: number;
  votable?: boolean;
  onVote?: () => void;
  isMyVote?: boolean;
}) {
  const color = getColor(task.model.name, task.model.color);
  const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
  const showViewerVotes = showVotes && totalViewerVotes !== undefined && totalViewerVotes > 0;
  const viewerPct = showViewerVotes && totalViewerVotes > 0
    ? Math.round(((viewerVotes ?? 0) / totalViewerVotes) * 100)
    : 0;

  return (
    <div
      className={`contestant ${isWinner ? "contestant--winner" : ""} ${votable ? "contestant--votable" : ""} ${isMyVote ? "contestant--my-vote" : ""}`}
      style={{ "--accent": color } as React.CSSProperties}
      onClick={votable ? onVote : undefined}
      role={votable ? "button" : undefined}
      tabIndex={votable ? 0 : undefined}
      onKeyDown={votable ? (e) => { if (e.key === "Enter" || e.key === " ") onVote?.(); } : undefined}
    >
      <div className="contestant__head">
        <ModelTag model={task.model} />
        {isMyVote && !isWinner && <span className="my-vote-tag">SEU VOTO</span>}
        {isWinner && <span className="win-tag">VENCEU</span>}
      </div>

      <div className="contestant__body">
        {!task.finishedAt ? (
          <p className="answer answer--loading">
            <Dots />
          </p>
        ) : task.error ? (
          <p className="answer answer--error">{task.error}</p>
        ) : (
          <p className="answer">&ldquo;{task.result}&rdquo;</p>
        )}
      </div>

      {showVotes && (
        <div className="contestant__foot">
          <div className="vote-bar">
            <div
              className="vote-bar__fill"
              style={{ width: `${pct}%`, background: color }}
            />
          </div>
          <div className="vote-meta">
            <span className="vote-meta__count" style={{ color }}>
              {voteCount}
            </span>
            <span className="vote-meta__label">
              voto{voteCount !== 1 ? "s" : ""}
            </span>
            <span className="vote-meta__dots">
              {voters.map((v, i) => {
                const logo = getLogo(v.voter.name, v.voter.logoId);
                return logo ? (
                  <img
                    key={i}
                    src={logo}
                    alt={v.voter.name}
                    title={v.voter.name}
                    className="voter-dot"
                  />
                ) : (
                  <span
                    key={i}
                    className="voter-dot voter-dot--letter"
                    style={{ color: getColor(v.voter.name, v.voter.color) }}
                    title={v.voter.name}
                  >
                    {v.voter.name[0]}
                  </span>
                );
              })}
            </span>
          </div>
          {showViewerVotes && (
            <>
              <div className="vote-bar viewer-vote-bar">
                <div
                  className="vote-bar__fill viewer-vote-bar__fill"
                  style={{ width: `${viewerPct}%` }}
                />
              </div>
              <div className="vote-meta viewer-vote-meta">
                <span className="vote-meta__count viewer-vote-meta__count">
                  {viewerVotes ?? 0}
                </span>
                <span className="vote-meta__label">
                  voto{(viewerVotes ?? 0) !== 1 ? "s" : ""} da plateia
                </span>
                <span className="viewer-vote-meta__icon">👥</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// â”€â”€ Arena â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Arena({
  round,
  roundNumber,
  total,
  votingCountdown,
}: {
  round: RoundState;
  roundNumber: number;
  total: number | null;
  votingCountdown: VotingCountdownView | null;
}) {
  const [contA, contB] = round.contestants;
  const isSkipped = Boolean(round.skipped);
  const showVotes = !isSkipped && (round.phase === "voting" || round.phase === "done");
  const isDone = round.phase === "done";

  let votesA = 0,
    votesB = 0;
  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) votesA++;
    else if (v.votedFor?.name === contB.name) votesB++;
  }
  const totalVotes = votesA + votesB;
  const votersA = round.votes.filter((v) => v.votedFor?.name === contA.name);
  const votersB = round.votes.filter((v) => v.votedFor?.name === contB.name);
  const totalViewerVotes = (round.viewerVotesA ?? 0) + (round.viewerVotesB ?? 0);

  const showCountdown = round.phase === "voting" && Boolean(votingCountdown);
  const skipInfo = isSkipped ? parseSkipReason(round.skipReason) : null;

  const phaseText =
    isSkipped
      ? `Rodada pulada${skipInfo?.modelName ? ` - ${skipInfo.modelName}` : ""}`
      : round.phase === "prompting"
      ? "Escrevendo prompt"
      : round.phase === "answering"
        ? "Respondendo"
        : round.phase === "voting"
          ? ""
          : "Concluida";

  return (
    <div className="arena">
      <div className="arena__meta">
        <span className="arena__round">
          Rodada {roundNumber}
          {total ? <span className="dim">/{total}</span> : null}
        </span>
        <div className="arena__meta-right">
          <span className={`arena__phase ${showCountdown ? "arena__phase--timer" : ""}`}>
            {showCountdown && votingCountdown ? (
              <span className="arena__phase-time">{votingCountdown.display}</span>
            ) : (
              phaseText
            )}
          </span>

        </div>
      </div>

      {/* Countdown and skip notice stay attached to header meta-right, not floating in content */}

      <PromptCard round={round} />

      {round.phase === "voting" && (
        <div className="chat-vote-hint">
          Vote no chat: <strong>1</strong> para esquerda, <strong>2</strong> para direita
        </div>
      )}

      {round.phase !== "prompting" && round.skipType !== "prompt_error" && (
        <div className="showdown">
          <ContestantCard
            task={round.answerTasks[0]}
            voteCount={votesA}
            totalVotes={totalVotes}
            isWinner={isDone && !isSkipped && votesA > votesB}
            showVotes={showVotes}
            voters={votersA}
            viewerVotes={round.viewerVotesA}
            totalViewerVotes={totalViewerVotes}
          />
          <ContestantCard
            task={round.answerTasks[1]}
            voteCount={votesB}
            totalVotes={totalVotes}
            isWinner={isDone && !isSkipped && votesB > votesA}
            showVotes={showVotes}
            voters={votersB}
            viewerVotes={round.viewerVotesB}
            totalViewerVotes={totalViewerVotes}
          />
        </div>
      )}

      {isDone && !isSkipped && votesA === votesB && totalVotes > 0 && (
        <div className="tie-label">Empate</div>
      )}
    </div>
  );
}

// â”€â”€ Game Over â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function GameOver({
  scores,
  humanScores,
  humanVoteTotals,
  enabledModelNames,
}: {
  scores: Record<string, number>;
  humanScores: Record<string, number>;
  humanVoteTotals: Record<string, number>;
  enabledModelNames: string[];
}) {
  const allowedModelNames = new Set(enabledModelNames);
  const modelNames = collectRankingNames(
    scores,
    humanScores,
    humanVoteTotals,
    namesAsScoreRecord(enabledModelNames),
  );
  const iaChampion = rankByScore(scores, {}, modelNames, allowedModelNames)[0];
  const humanChampion = rankByScore(humanScores, humanVoteTotals, modelNames, allowedModelNames).find(
    (entry) => entry.score > 0,
  );

  return (
    <div className="game-over">
      <div className="game-over__label">Fim de jogo</div>
      {iaChampion && iaChampion.score > 0 && (
        <div className="game-over__winner">
          <span className="game-over__crown">👑</span>
          <span
            className="game-over__name"
            style={{ color: getColor(iaChampion.name) }}
          >
            {getLogo(iaChampion.name) && <img src={getLogo(iaChampion.name)!} alt="" />}
            {iaChampion.name}
          </span>
          <span className="game-over__sub">e a IA mais engracada</span>
        </div>
      )}
      <div className="game-over__winner game-over__winner--human">
        <span className="game-over__crown">👥</span>
        {humanChampion ? (
          <>
            <span
              className="game-over__name"
              style={{ color: getColor(humanChampion.name) }}
            >
              {getLogo(humanChampion.name) && <img src={getLogo(humanChampion.name)!} alt="" />}
              {humanChampion.name}
            </span>
            <span className="game-over__sub">campeao da votacao da plateia</span>
          </>
        ) : (
          <>
            <span className="game-over__name game-over__name--empty">Sem campeao da plateia</span>
            <span className="game-over__sub">ainda sem vitoria humana acumulada</span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Standings ────────────────────────────────────────────────────────────────

function Standings({
  scores,
  humanScores,
  humanVoteTotals,
  activeRound,
  enabledModelNames,
}: {
  scores: Record<string, number>;
  humanScores: Record<string, number>;
  humanVoteTotals: Record<string, number>;
  activeRound: RoundState | null;
  enabledModelNames: string[];
}) {
  const allowedModelNames = new Set(enabledModelNames);
  const modelNames = collectRankingNames(
    scores,
    humanScores,
    humanVoteTotals,
    namesAsScoreRecord(enabledModelNames),
  );
  const iaSorted = rankByScore(scores, {}, modelNames, allowedModelNames);
  const humanSorted = rankByScore(humanScores, humanVoteTotals, modelNames, allowedModelNames);
  const maxIaScore = iaSorted[0]?.score || 1;
  const maxHumanScore = humanSorted[0]?.score || 1;

  const competing = activeRound
    ? new Set([
        activeRound.contestants[0].name,
        activeRound.contestants[1].name,
      ])
    : new Set<string>();

  return (
    <aside className="standings">
      <div className="standings__head">
        <span className="standings__title">Ranking</span>
        <div className="standings__links">
          <a href="/history.html" className="standings__link">
            Historico
          </a>
          <a href="https://twitch.tv/tokenscomedyclub" target="_blank" rel="noopener noreferrer" className="standings__link">
            Twitch
          </a>
          <a href="https://github.com/JPSAUD501/TokensComedyClub" target="_blank" rel="noopener noreferrer" className="standings__link">
            GitHub
          </a>
        </div>
      </div>

      <div className="standings__section">
        <div className="standings__section-title">Ranking da Plateia</div>
        <div className="standings__list">
          {humanSorted.map((entry, i) => {
            const pct = maxHumanScore > 0 ? Math.round((entry.score / maxHumanScore) * 100) : 0;
            const color = getColor(entry.name);
            const active = competing.has(entry.name);
            return (
              <div
                key={`human-${entry.name}`}
                className={`standing ${active ? "standing--active" : ""}`}
              >
                <span className="standing__rank">
                  {i === 0 && entry.score > 0 ? "👥" : i + 1}
                </span>
                <ModelTag model={{ id: entry.name, name: entry.name }} small />
                <div className="standing__bar">
                  <div
                    className="standing__fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="standing__score">{entry.score}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="standings__section">
        <div className="standings__section-title">Ranking das IAs</div>
        <div className="standings__list">
          {iaSorted.map((entry, i) => {
            const pct = maxIaScore > 0 ? Math.round((entry.score / maxIaScore) * 100) : 0;
            const color = getColor(entry.name);
            const active = competing.has(entry.name);
            return (
              <div
                key={`ia-${entry.name}`}
                className={`standing ${active ? "standing--active" : ""}`}
              >
                <span className="standing__rank">
                  {i === 0 && entry.score > 0 ? "👑" : i + 1}
                </span>
                <ModelTag model={{ id: entry.name, name: entry.name }} small />
                <div className="standing__bar">
                  <div
                    className="standing__fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="standing__score">{entry.score}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
// â”€â”€ Conectando â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ConnectingScreen() {
  return (
    <div className="connecting">
      <div className="connecting__logo">
        <img src="/assets/logo.svg" alt="TokensComedyClub" />
      </div>
      <div className="connecting__sub">
        Conectando
        <Dots />
      </div>
    </div>
  );
}

// â”€â”€ App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function App() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const viewerIdRef = React.useRef<string | null>(null);
  const countdownTrackerRef = React.useRef(createVotingCountdownTracker());
  const ghostViewer = React.useMemo(() => isGhostViewer(), []);

  const liveState = useQuery(convexApi.live.getState, {}) as
    | { data: GameState; totalRounds: number | null; viewerCount: number }
    | undefined;
  const ensureStarted = useMutation(convexApi.live.ensureStarted);
  const heartbeat = useMutation(convexApi.viewers.heartbeat);

  const state = liveState?.data ?? null;
  const totalRounds = liveState?.totalRounds ?? null;
  const viewerCount = liveState?.viewerCount ?? 0;
  const completedRounds = state?.completedRounds ?? 0;
  const catalogModels = state?.models ?? [];
  useEffect(() => {
    syncModelCatalog(catalogModels);
  }, [catalogModels]);

  const enabledModelNames = React.useMemo(
    () => getEnabledModelNames(catalogModels),
    [catalogModels],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const viewerId = getOrCreateViewerId();
    viewerIdRef.current = viewerId;
    void ensureStarted({});

    if (ghostViewer) {
      return;
    }

    void heartbeat({ viewerId, page: "live" });
    const interval = setInterval(() => {
      void heartbeat({ viewerId, page: "live" });
    }, 10_000);
    return () => {
      clearInterval(interval);
    };
  }, [ensureStarted, heartbeat, ghostViewer]);

  if (!liveState || !state) return <ConnectingScreen />;

  const votingCountdown = countdownTrackerRef.current.compute(state.active, nowMs);

  const isNextPrompting =
    state.active?.phase === "prompting" && !state.active.prompt;
  const displayRound =
    isNextPrompting && state.lastCompleted
      ? state.lastCompleted
      : (state.active ?? state.lastCompleted ?? null);

  return (
    <div className="app">
      <div className="layout">
        <main className="main">
          <header className="header">
            <a href="/" className="logo">
              <img src="/assets/logo.svg" alt="TokensComedyClub" />
            </a>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {state.isPaused && (
                <div
                  className="viewer-pill"
                  style={{ color: "var(--text-muted)", borderColor: "var(--border)" }}
                >
                  Pausado
                </div>
              )}
              <div className="viewer-pill" aria-live="polite">
                <span className="viewer-pill__dot" />
                {viewerCount} espectador{viewerCount === 1 ? "" : "es"} assistindo
              </div>
            </div>
          </header>

          {state.done ? (
            <GameOver
              scores={state.scores}
              humanScores={state.humanScores ?? {}}
              humanVoteTotals={state.humanVoteTotals ?? {}}
              enabledModelNames={enabledModelNames}
            />
          ) : displayRound ? (
            <Arena
              round={displayRound}
              roundNumber={completedRounds}
              total={totalRounds}
              votingCountdown={votingCountdown}
            />
          ) : (
            <div className="waiting">
              Iniciando
              <Dots />
            </div>
          )}

          {isNextPrompting && state.lastCompleted && (
            <div className="next-toast">
              <ModelTag model={state.active!.prompter} small /> esta escrevendo o
              proximo prompt
              <Dots />
            </div>
          )}
        </main>

        <Standings
          scores={state.scores}
          humanScores={state.humanScores ?? {}}
          humanVoteTotals={state.humanVoteTotals ?? {}}
          activeRound={state.active}
          enabledModelNames={enabledModelNames}
        />
      </div>
    </div>
  );
}

// â”€â”€ Mount â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const root = createRoot(document.getElementById("root")!);
root.render(
  <ConvexProvider client={convex}>
    <App />
  </ConvexProvider>,
);
