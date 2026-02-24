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
  finalized?: boolean;
};

type ReasoningTrackState = {
  displayTokens: number;
  growthPerMs: number;
  correctionPerMs: number;
  correctionRemainingMs: number;
  sampleIntervalMs: number;
  lastTickAt: number;
  lastSeenAt: number;
  serverTokens: number;
  serverUpdatedAt: number;
  finalized: boolean;
};

export class ReasoningProgressEstimator {
  private tracks = new Map<string, ReasoningTrackState>();
  private readonly syncBlendMs: number;
  private readonly maxExtrapolationMs: number;
  private readonly maxRatePerMs: number;
  private readonly minSampleIntervalMs: number;
  private readonly maxSampleIntervalMs: number;

  constructor(options?: {
    syncBlendMs?: number;
    maxExtrapolationMs?: number;
    maxRatePerMs?: number;
    minSampleIntervalMs?: number;
    maxSampleIntervalMs?: number;
  }) {
    this.syncBlendMs = options?.syncBlendMs ?? 350;
    this.maxExtrapolationMs = options?.maxExtrapolationMs ?? 1_600;
    this.maxRatePerMs = options?.maxRatePerMs ?? 8;
    this.minSampleIntervalMs = options?.minSampleIntervalMs ?? 250;
    this.maxSampleIntervalMs = options?.maxSampleIntervalMs ?? 1_500;
  }

  private clampSampleInterval(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return this.syncBlendMs;
    return Math.max(this.minSampleIntervalMs, Math.min(this.maxSampleIntervalMs, value));
  }

  private clampRate(rate: number): number {
    if (!Number.isFinite(rate)) return 0;
    if (rate < 0) return 0;
    return Math.min(rate, this.maxRatePerMs);
  }

  private advanceTrack(state: ReasoningTrackState, now: number) {
    const elapsed = now - state.lastTickAt;
    if (!(elapsed > 0)) return;

    const extrapolationWindowMs = Math.max(
      this.maxExtrapolationMs,
      Math.floor(state.sampleIntervalMs * 1.25),
    );
    const canExtrapolate = !state.finalized && now - state.serverUpdatedAt <= extrapolationWindowMs;
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
        // Primeira estimativa de taxa para evitar "congelar e pular" entre os dois primeiros syncs.
        growthPerMs: this.clampRate(normalizedTokens / 1_000),
        correctionPerMs: 0,
        correctionRemainingMs: 0,
        sampleIntervalMs: this.syncBlendMs,
        lastTickAt: now,
        lastSeenAt: now,
        serverTokens: normalizedTokens,
        serverUpdatedAt: normalizedUpdatedAt,
        finalized: Boolean(sample.finalized),
      });
      return;
    }

    this.advanceTrack(existing, now);

    if (sample.finalized) {
      existing.finalized = true;
    }

    if (normalizedUpdatedAt > existing.serverUpdatedAt) {
      const deltaTokens = Math.max(0, normalizedTokens - existing.serverTokens);
      const deltaMs = normalizedUpdatedAt - existing.serverUpdatedAt;
      if (deltaMs > 0) {
        existing.sampleIntervalMs = this.clampSampleInterval(deltaMs);
        const sampleRate = this.clampRate(deltaTokens / deltaMs);
        existing.growthPerMs = sampleRate;
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
    } else if (existing.finalized) {
      const blendMs = Math.max(90, Math.floor(this.syncBlendMs * 0.35));
      existing.correctionRemainingMs = blendMs;
      existing.correctionPerMs = delta / blendMs;
    } else {
      // Distribui correção ao longo do intervalo real de amostragem para evitar saltos bruscos.
      const blendMs = this.clampSampleInterval(existing.sampleIntervalMs);
      existing.correctionRemainingMs = blendMs;
      existing.correctionPerMs = delta / blendMs;
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
