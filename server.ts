import type { ServerWebSocket } from "bun";
import indexHtml from "./index.html";
import historyHtml from "./history.html";
import { getRounds, getAllRounds } from "./db.ts";
import {
  MODELS,
  LOG_FILE,
  log,
  runGame,
  type GameState,
  type RoundState,
} from "./game.ts";

// ── Game state ──────────────────────────────────────────────────────────────

const runsArg = process.argv.find((a) => a.startsWith("runs="));
const runsStr = runsArg ? runsArg.split("=")[1] : "infinite";
const runs = runsStr === "infinite" ? Infinity : parseInt(runsStr || "infinite", 10);

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Error: Set OPENROUTER_API_KEY environment variable");
  process.exit(1);
}

const allRounds = getAllRounds();
const initialScores = Object.fromEntries(MODELS.map((m) => [m.name, 0]));

let initialCompleted: RoundState[] = [];
if (allRounds.length > 0) {
  for (const round of allRounds) {
    if (round.scoreA !== undefined && round.scoreB !== undefined) {
      if (round.scoreA > round.scoreB) {
        initialScores[round.contestants[0].name] = (initialScores[round.contestants[0].name] || 0) + 1;
      } else if (round.scoreB > round.scoreA) {
        initialScores[round.contestants[1].name] = (initialScores[round.contestants[1].name] || 0) + 1;
      }
    }
  }
  initialCompleted = [allRounds[allRounds.length - 1]];
}

const gameState: GameState = {
  completed: initialCompleted,
  active: null,
  scores: initialScores,
  done: false,
  isPaused: false,
};

// ── WebSocket clients ───────────────────────────────────────────────────────

const clients = new Set<ServerWebSocket<unknown>>();

function broadcast() {
  const msg = JSON.stringify({ type: "state", data: gameState, totalRounds: runs });
  for (const ws of clients) {
    ws.send(msg);
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "5109", 10); // 5109 = SLOP

const server = Bun.serve({
  port,
  routes: {
    "/": indexHtml,
    "/history": historyHtml,
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/assets/")) {
      const path = `./public${url.pathname}`;
      const file = Bun.file(path);
      return new Response(file);
    }
    if (url.pathname === "/api/pause") {
      const secret = url.searchParams.get("secret");
      if (process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET) {
        gameState.isPaused = true;
        broadcast();
        return new Response("Paused", { status: 200 });
      }
      return new Response("Unauthorized", { status: 401 });
    }
    if (url.pathname === "/api/resume") {
      const secret = url.searchParams.get("secret");
      if (process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET) {
        gameState.isPaused = false;
        broadcast();
        return new Response("Resumed", { status: 200 });
      }
      return new Response("Unauthorized", { status: 401 });
    }
    if (url.pathname === "/api/history") {
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      return new Response(JSON.stringify(getRounds(page)), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "state", data: gameState, totalRounds: runs }));
    },
    message(_ws, _message) {
      // Spectator-only, no client messages handled
    },
    close(ws) {
      clients.delete(ws);
    },
  },
  development: process.env.NODE_ENV === "production" ? false : {
    hmr: true,
    console: true,
  },
});

console.log(`\n🎮 Qwipslop Web — http://localhost:${server.port}`);
console.log(`📡 WebSocket — ws://localhost:${server.port}/ws`);
console.log(`🎯 ${runs} rounds with ${MODELS.length} models\n`);

log("INFO", "server", `Web server started on port ${server.port}`, {
  runs,
  models: MODELS.map((m) => m.id),
});

// ── Start game ──────────────────────────────────────────────────────────────

runGame(runs, gameState, broadcast).then(() => {
  console.log(`\n✅ Game complete! Log: ${LOG_FILE}`);
});
