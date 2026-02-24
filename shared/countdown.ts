import {
  COUNTDOWN_SHORTENED_WINDOW_DETECT_DELTA_MS,
  VIEWER_VOTE_WINDOW_ACTIVE_MS,
  VIEWER_VOTE_WINDOW_IDLE_MS,
} from "../config";

export const VOTING_WINDOW_ACTIVE_MS = VIEWER_VOTE_WINDOW_ACTIVE_MS;
export const VOTING_WINDOW_IDLE_MS = VIEWER_VOTE_WINDOW_IDLE_MS;

export type VotingRoundLike = {
  _id?: string;
  num: number;
  phase: "prompting" | "answering" | "voting" | "done";
  viewerVotingEndsAt?: number;
};

export type VotingCountdownView = {
  remainingMs: number;
  totalMs: number;
  progress: number;
  display: string;
  label: "Votacao humana" | "Aguardando IAs";
  isZero: boolean;
  hasEndsAt: boolean;
};

function formatMMSS(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function createVotingCountdownTracker() {
  let currentRoundKey: string | null = null;
  let windowMs: number | null = null;
  let lastRemainingMs: number | null = null;
  let warnedMissingEndsAt = false;

  function reset() {
    currentRoundKey = null;
    windowMs = null;
    lastRemainingMs = null;
    warnedMissingEndsAt = false;
  }

  function compute(round: VotingRoundLike | null | undefined, now = Date.now()): VotingCountdownView | null {
    if (!round || round.phase !== "voting") {
      reset();
      return null;
    }

    const roundKey = round._id ?? String(round.num);
    if (roundKey !== currentRoundKey) {
      currentRoundKey = roundKey;
      windowMs = null;
      lastRemainingMs = null;
      warnedMissingEndsAt = false;
    }

    if (!round.viewerVotingEndsAt) {
      if (!warnedMissingEndsAt) {
        console.warn("[countdown] round in voting phase without viewerVotingEndsAt", {
          roundId: round._id,
          roundNum: round.num,
        });
        warnedMissingEndsAt = true;
      }
      return {
        remainingMs: 0,
        totalMs: VOTING_WINDOW_ACTIVE_MS,
        progress: 0,
        display: "--:--",
        label: "Votacao humana",
        isZero: false,
        hasEndsAt: false,
      };
    }

    const remainingMs = Math.max(0, round.viewerVotingEndsAt - now);
    if (remainingMs > VOTING_WINDOW_ACTIVE_MS) {
      windowMs = VOTING_WINDOW_IDLE_MS;
    } else if (windowMs === null) {
      windowMs = VOTING_WINDOW_ACTIVE_MS;
    } else if (
      windowMs === VOTING_WINDOW_IDLE_MS &&
      lastRemainingMs !== null &&
      lastRemainingMs - remainingMs > COUNTDOWN_SHORTENED_WINDOW_DETECT_DELTA_MS
    ) {
      // Window was shortened dynamically from 120s to 30s.
      windowMs = VOTING_WINDOW_ACTIVE_MS;
    }

    const resolvedTotalMs = windowMs ?? VOTING_WINDOW_ACTIVE_MS;
    lastRemainingMs = remainingMs;
    const isZero = remainingMs === 0;

    return {
      remainingMs,
      totalMs: resolvedTotalMs,
      progress: clamp01(remainingMs / resolvedTotalMs),
      display: formatMMSS(remainingMs),
      label: isZero ? "Aguardando IAs" : "Votacao humana",
      isZero,
      hasEndsAt: true,
    };
  }

  return { compute, reset };
}
