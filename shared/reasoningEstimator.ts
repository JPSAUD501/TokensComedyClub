export type ReasoningProgressType = "prompt" | "answer";

export function reasoningProgressKey(
  roundId: string,
  requestType: ReasoningProgressType,
  answerIndex?: number,
): string {
  if (requestType === "prompt") return `${roundId}:prompt`;
  return `${roundId}:answer:${answerIndex ?? 0}`;
}

type ReasoningServerSample = {
  tokens: number;
  updatedAt: number;
};

type ReasoningTrackState = {
  displayTokens: number;
  growthPerMs: number;
  correctionPerMs: number;
  correctionRemainingMs: number;
  lastTickAt: number;
  lastSeenAt: number;
  serverTokens: number;
  serverUpdatedAt: number;
};

export class ReasoningProgressEstimator {
  private tracks = new Map<string, ReasoningTrackState>();
  private readonly syncBlendMs: number;
  private readonly maxExtrapolationMs: number;
  private readonly maxRatePerMs: number;

  constructor(options?: {
    syncBlendMs?: number;
    maxExtrapolationMs?: number;
    maxRatePerMs?: number;
  }) {
    this.syncBlendMs = options?.syncBlendMs ?? 350;
    this.maxExtrapolationMs = options?.maxExtrapolationMs ?? 1_600;
    this.maxRatePerMs = options?.maxRatePerMs ?? 8;
  }

  private clampRate(rate: number): number {
    if (!Number.isFinite(rate)) return 0;
    if (rate < 0) return 0;
    return Math.min(rate, this.maxRatePerMs);
  }

  private advanceTrack(state: ReasoningTrackState, now: number) {
    const elapsed = now - state.lastTickAt;
    if (!(elapsed > 0)) return;

    const canExtrapolate = now - state.serverUpdatedAt <= this.maxExtrapolationMs;
    const growth = canExtrapolate ? state.growthPerMs * elapsed : 0;

    let correction = 0;
    if (state.correctionRemainingMs > 0) {
      const correctionWindow = Math.min(elapsed, state.correctionRemainingMs);
      correction = state.correctionPerMs * correctionWindow;
      state.correctionRemainingMs = Math.max(0, state.correctionRemainingMs - elapsed);
      if (state.correctionRemainingMs <= 0) {
        state.correctionPerMs = 0;
      }
    }

    state.displayTokens = Math.max(0, state.displayTokens + growth + correction);
    if (state.correctionRemainingMs <= 0 && Math.abs(state.serverTokens - state.displayTokens) < 0.75) {
      state.displayTokens = state.serverTokens;
    }

    state.lastTickAt = now;
  }

  sync(key: string, sample: ReasoningServerSample, now = Date.now()) {
    const normalizedTokens = Math.max(0, Math.floor(sample.tokens));
    const normalizedUpdatedAt = Number.isFinite(sample.updatedAt) ? sample.updatedAt : now;
    const existing = this.tracks.get(key);

    if (!existing) {
      this.tracks.set(key, {
        displayTokens: normalizedTokens,
        growthPerMs: 0,
        correctionPerMs: 0,
        correctionRemainingMs: 0,
        lastTickAt: now,
        lastSeenAt: now,
        serverTokens: normalizedTokens,
        serverUpdatedAt: normalizedUpdatedAt,
      });
      return;
    }

    this.advanceTrack(existing, now);

    if (normalizedUpdatedAt > existing.serverUpdatedAt) {
      const deltaTokens = Math.max(0, normalizedTokens - existing.serverTokens);
      const deltaMs = normalizedUpdatedAt - existing.serverUpdatedAt;
      if (deltaMs > 0) {
        const sampleRate = this.clampRate(deltaTokens / deltaMs);
        existing.growthPerMs =
          existing.growthPerMs <= 0 ? sampleRate : this.clampRate(existing.growthPerMs * 0.35 + sampleRate * 0.65);
      }
      existing.serverUpdatedAt = normalizedUpdatedAt;
      existing.serverTokens = normalizedTokens;
    } else if (normalizedTokens > existing.serverTokens) {
      existing.serverTokens = normalizedTokens;
    }

    const target = existing.serverTokens;
    const delta = target - existing.displayTokens;
    if (Math.abs(delta) < 0.5) {
      existing.displayTokens = target;
      existing.correctionPerMs = 0;
      existing.correctionRemainingMs = 0;
    } else {
      existing.correctionRemainingMs = this.syncBlendMs;
      existing.correctionPerMs = delta / this.syncBlendMs;
    }

    existing.lastSeenAt = now;
  }

  tick(now = Date.now()) {
    for (const state of this.tracks.values()) {
      this.advanceTrack(state, now);
    }
  }

  get(key: string, now = Date.now()): number | null {
    const state = this.tracks.get(key);
    if (!state) return null;
    this.advanceTrack(state, now);
    return Math.max(0, Math.floor(state.displayTokens));
  }

  pruneOlderThan(maxAgeMs: number, now = Date.now()) {
    for (const [key, state] of this.tracks.entries()) {
      if (now - state.lastSeenAt > maxAgeMs) {
        this.tracks.delete(key);
      }
    }
  }

  clear() {
    this.tracks.clear();
  }
}
