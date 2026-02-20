import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./frontend.css";

// ── Types (mirrors game.ts) ─────────────────────────────────────────────────

type Model = { id: string; name: string };
type TaskInfo = { model: Model; startedAt: number; finishedAt?: number; result?: string; error?: string };
type VoteInfo = { voter: Model; startedAt: number; finishedAt?: number; votedFor?: Model; error?: boolean };
type RoundState = {
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  prompter: Model;
  promptTask: TaskInfo;
  prompt?: string;
  contestants: [Model, Model];
  answerTasks: [TaskInfo, TaskInfo];
  votes: VoteInfo[];
  scoreA?: number;
  scoreB?: number;
};
type GameState = { completed: RoundState[]; active: RoundState | null; scores: Record<string, number>; done: boolean };
type ServerMessage = { type: "state"; data: GameState; totalRounds: number };

// ── Model Assets & Colors ───────────────────────────────────────────────────

const MODEL_COLORS: Record<string, string> = {
  "Gemini 3.1 Pro": "#4285F4",
  "Kimi K2": "#00E599",
  "DeepSeek 3.2": "#4D6BFE",
  "GLM-5": "#1F63EC",
  "GPT-5.2": "#10A37F",
  "Opus 4.6": "#D97757",
  "Sonnet 4.6": "#D97757",
  "Grok 4.1": "#FFFFFF",
};

function getColor(name: string): string {
  return MODEL_COLORS[name] ?? "#A1A1A1";
}

function getLogo(name: string): string | null {
  if (name.includes("Gemini")) return "/assets/logos/gemini.svg";
  if (name.includes("Kimi")) return "/assets/logos/kimi.svg";
  if (name.includes("DeepSeek")) return "/assets/logos/deepseek.svg";
  if (name.includes("GLM")) return "/assets/logos/glm.svg";
  if (name.includes("GPT")) return "/assets/logos/openai.svg";
  if (name.includes("Opus") || name.includes("Sonnet")) return "/assets/logos/claude.svg";
  if (name.includes("Grok")) return "/assets/logos/grok.svg";
  return null;
}

// ── Components ──────────────────────────────────────────────────────────────

function Timer({ startedAt, finishedAt }: { startedAt: number; finishedAt?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (finishedAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [finishedAt]);
  const elapsed = ((finishedAt ?? now) - startedAt) / 1000;
  return <span className="timer">{elapsed.toFixed(1)}s</span>;
}

function ModelName({ model, className = "", showLogo = true }: { model: Model; className?: string, showLogo?: boolean }) {
  const logo = getLogo(model.name);
  const color = getColor(model.name);
  return (
    <span className={`model-name ${className}`} style={{ color }}>
      {showLogo && logo && <img src={logo} alt="" className="model-logo" />}
      {model.name}
    </span>
  );
}

function PromptCard({ round }: { round: RoundState }) {
  if (round.phase === "prompting" && !round.prompt) {
    return (
      <div className="prompt-card prompt-card--loading">
        <div className="prompt-card__by">
          <ModelName model={round.prompter} /> is cooking up a prompt…
        </div>
        <div className="prompt-card__text prompt-card__text--loading">
          <span className="dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      </div>
    );
  }

  if (round.promptTask.error) {
    return (
      <div className="prompt-card prompt-card--error">
        <div className="prompt-card__text" style={{ color: "#ef4444" }}>Prompt generation failed</div>
      </div>
    );
  }

  return (
    <div className="prompt-card">
      <div className="prompt-card__by">
        Prompted by <ModelName model={round.prompter} />
      </div>
      <div className="prompt-card__text">{round.prompt}</div>
    </div>
  );
}

function ContestantPanel({
  task,
  voteCount,
  totalVotes,
  isWinner,
  showVotes,
  voters,
}: {
  task: TaskInfo;
  voteCount: number;
  totalVotes: number;
  isWinner: boolean;
  showVotes: boolean;
  voters: VoteInfo[];
}) {
  const color = getColor(task.model.name);
  const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;

  return (
    <div className={`contestant ${isWinner ? "contestant--winner" : ""}`} style={{ borderColor: color }}>
      <div className="contestant__header">
        <div className="contestant__name">
          <ModelName model={task.model} />
        </div>
        {isWinner && <div className="contestant__winner-badge">WINNER</div>}
      </div>
      
      <div className="contestant__answer">
        {!task.finishedAt ? (
          <span className="contestant__thinking">
            <span className="dots"><span>.</span><span>.</span><span>.</span></span>
          </span>
        ) : task.error ? (
          <span className="contestant__error">✗ {task.error}</span>
        ) : (
          <span className="contestant__text">&ldquo;{task.result}&rdquo;</span>
        )}
      </div>

      {showVotes && (
        <div className="contestant__votes-container">
          <div className="contestant__votes">
            <div className="vote-bar">
              <div className="vote-bar__fill" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="vote-bar__label">
              <span className="vote-bar__count" style={{ color }}>{voteCount}</span>
              <span className="vote-bar__pct">{pct}%</span>
            </div>
          </div>
          <div className="contestant__voters">
            {voters.map((v, i) => (
               <div key={i} className="voter-badge">
                 <ModelName model={v.voter} showLogo={true} />
               </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PendingVotes({ votes }: { votes: VoteInfo[] }) {
  if (votes.length === 0) return null;
  return (
    <div className="pending-votes">
      {votes.map((v, i) => (
        <div key={i} className={`voter-badge ${!v.finishedAt ? 'voter-badge--pending' : 'voter-badge--error'}`}>
          <ModelName model={v.voter} showLogo={true} /> 
          {!v.finishedAt ? " deliberating…" : " abstained"}
        </div>
      ))}
    </div>
  );
}

function Arena({ round, total }: { round: RoundState; total: number }) {
  const [contA, contB] = round.contestants;
  const showVotes = round.phase === "voting" || round.phase === "done";
  const isDone = round.phase === "done";

  let votesA = 0,
    votesB = 0;
  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) votesA++;
    else if (v.votedFor?.name === contB.name) votesB++;
  }
  const totalVotes = votesA + votesB;
  
  const votersA = round.votes.filter(v => v.votedFor?.name === contA.name);
  const votersB = round.votes.filter(v => v.votedFor?.name === contB.name);
  const pendingOrAbstained = round.votes.filter(v => !v.finishedAt || v.error || !v.votedFor);

  const phaseLabel =
    round.phase === "prompting"
      ? "✍️ WRITING PROMPT"
      : round.phase === "answering"
        ? "💭 ANSWERING"
        : round.phase === "voting"
          ? "🗳️ JUDGES VOTING"
          : "✅ ROUND COMPLETE";

  return (
    <div className="arena">
      <div className="arena__header-row">
        <div className="arena__round-badge">
          ROUND {round.num} <span className="arena__round-of">/ {total}</span>
        </div>
        <div className="arena__phase">{phaseLabel}</div>
      </div>

      <PromptCard round={round} />

      {round.phase !== "prompting" && (
        <>
          <div className="showdown">
            <ContestantPanel
              task={round.answerTasks[0]}
              voteCount={votesA}
              totalVotes={totalVotes}
              isWinner={isDone && votesA > votesB}
              showVotes={showVotes}
              voters={votersA}
            />
            <ContestantPanel
              task={round.answerTasks[1]}
              voteCount={votesB}
              totalVotes={totalVotes}
              isWinner={isDone && votesB > votesA}
              showVotes={showVotes}
              voters={votersB}
            />
          </div>

          {showVotes && <PendingVotes votes={pendingOrAbstained} />}

          {isDone && votesA === votesB && (
            <div className="round-result">IT&rsquo;S A TIE!</div>
          )}
        </>
      )}
    </div>
  );
}

function PastRoundMini({ round }: { round: RoundState }) {
  const [contA, contB] = round.contestants;
  let votesA = 0, votesB = 0;
  for (const v of round.votes) {
    if (v.votedFor?.name === contA.name) votesA++;
    else if (v.votedFor?.name === contB.name) votesB++;
  }
  const winner = votesA > votesB ? contA : votesB > votesA ? contB : null;

  return (
    <div className="past-round-mini">
      <div className="past-round-mini__top">
        <span className="past-round-mini__num">R{round.num}</span>
        <span className="past-round-mini__prompt">"{round.prompt}"</span>
      </div>
      <div className="past-round-mini__winner">
        {winner ? <><ModelName model={winner} showLogo={true} className="small-model-name" /> won</> : <span className="past-round-mini__tie">Tie</span>}
      </div>
    </div>
  );
}

function GameOver({ scores }: { scores: Record<string, number> }) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const champion = sorted[0];

  return (
    <div className="game-over">
      <div className="game-over__title">GAME OVER</div>
      {champion && champion[1] > 0 && (
        <div className="game-over__champion">
          <div className="game-over__crown">👑</div>
          <div className="game-over__name" style={{ color: getColor(champion[0]) }}>
            {getLogo(champion[0]) && <img src={getLogo(champion[0])!} alt="" />}
            {champion[0]}
          </div>
          <div className="game-over__subtitle">is the funniest AI!</div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ scores, activeRound, completed }: { scores: Record<string, number>; activeRound: RoundState | null; completed: RoundState[] }) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const maxScore = sorted[0]?.[1] || 1;

  const competing = activeRound
    ? new Set([activeRound.contestants[0].name, activeRound.contestants[1].name])
    : new Set<string>();
  const judging = activeRound ? new Set(activeRound.votes.map((v) => v.voter.name)) : new Set<string>();
  const prompting = activeRound?.prompter.name ?? null;

  return (
    <aside className="sidebar">
      <div className="sidebar__section">
        <div className="sidebar__header">STANDINGS</div>
        <div className="sidebar__list">
          {sorted.map(([name, score], i) => {
            const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
            const color = getColor(name);
            const isActive = competing.has(name);
            const isJudging = judging.has(name);
            const isPrompting = name === prompting;

            let role = "";
            if (isActive) role = "⚔️";
            else if (isPrompting) role = "✍️";
            else if (isJudging) role = "🗳️";

            return (
              <div key={name} className={`standing ${isActive ? "standing--active" : ""}`}>
                <div className="standing__rank">{i === 0 && score > 0 ? "👑" : `${i + 1}.`}</div>
                <div className="standing__info">
                  <div className="standing__name-row">
                    <ModelName model={{id: name, name}} />
                    {role && <span className="standing__role">{role}</span>}
                  </div>
                  <div className="standing__bar-row">
                    <div className="standing__bar">
                      <div className="standing__bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="standing__score">{score}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {activeRound && (
          <div className="sidebar__legend">
            <span>⚔️ COMPETING</span>
            <span>✍️ PROMPTING</span>
            <span>🗳️ JUDGING</span>
          </div>
        )}
      </div>

      {completed.length > 0 && (
        <div className="sidebar__section sidebar__section--history">
          <div className="sidebar__header">PAST ROUNDS</div>
          <div className="sidebar__history-list">
            {[...completed].reverse().map(round => (
              <PastRoundMini key={round.num} round={round} />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function ConnectingScreen() {
  return (
    <div className="connecting">
      <div className="connecting__logo">QUIPSLOP</div>
      <div className="connecting__text">Connecting<span className="dots"><span>.</span><span>.</span><span>.</span></span></div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [totalRounds, setTotalRounds] = useState(5);
  const [connected, setConnected] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wsUrl = `ws://${window.location.host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
        if (msg.type === "state") {
          setState(msg.data);
          setTotalRounds(msg.totalRounds);
        }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  if (!connected || !state) {
    return <ConnectingScreen />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="header__logo">QUIPSLOP</h1>
        <p className="header__tagline">AI vs AI Comedy Showdown</p>
      </header>

      <div className="layout">
        <main className="main" ref={mainRef}>
          {state.active && <Arena round={state.active} total={totalRounds} />}

          {!state.active && !state.done && state.completed.length > 0 && (
            <div className="arena-waiting">
              Next round starting<span className="dots"><span>.</span><span>.</span><span>.</span></span>
            </div>
          )}

          {!state.active && !state.done && state.completed.length === 0 && (
            <div className="arena-waiting">
              Game starting<span className="dots"><span>.</span><span>.</span><span>.</span></span>
            </div>
          )}

          {state.done && <GameOver scores={state.scores} />}
        </main>

        <Sidebar scores={state.scores} activeRound={state.active} completed={state.completed} />
      </div>
    </div>
  );
}

// ── Mount ───────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById("root")!);
root.render(<App />);