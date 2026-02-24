import type { Model, ModelCatalogEntry } from "./models";

export type TaskMetrics = {
  generationId: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  durationMsLocal: number;
  durationMsFinal: number;
  durationSource: "openrouter_latency" | "openrouter_generation_time" | "local";
  recordedAt: number;
};

export type TaskInfo = {
  model: Model;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  metrics?: TaskMetrics;
};

export type VoteInfo = {
  voter: Model;
  startedAt: number;
  finishedAt?: number;
  votedFor?: Model;
  error?: boolean;
};

export type RoundState = {
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
  viewerVotingWindowMs?: number;
  viewerVotingMode?: "active" | "idle";
};

export type GameState = {
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

export type LiveStatePayload = {
  data: GameState;
  totalRounds: number | null;
  viewerCount: number;
};

export type AdminSnapshot = {
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

export type ActiveReasoningProgressItem = {
  requestType: "prompt" | "answer";
  answerIndex?: number;
  modelId: string;
  estimatedReasoningTokens: number;
  updatedAt: number;
  finalized: boolean;
};
