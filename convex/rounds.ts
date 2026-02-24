import type { RoundState, VoteInfo } from "../shared/types";

function toClientVote(round: any, vote: any): VoteInfo {
  const votedFor =
    vote.votedForSide === "A"
      ? round.contestants[0]
      : vote.votedForSide === "B"
        ? round.contestants[1]
        : undefined;

  return {
    voter: vote.voter,
    startedAt: vote.startedAt,
    finishedAt: vote.finishedAt,
    votedFor,
    error: vote.error,
  };
}

export function toClientRound(round: any | null): RoundState | null {
  if (!round) return null;

  return {
    _id: round._id,
    num: round.num,
    phase: round.phase,
    skipped: round.skipped,
    skipReason: round.skipReason,
    skipType: round.skipType,
    prompter: round.prompter,
    promptTask: round.promptTask,
    prompt: round.prompt,
    contestants: [round.contestants[0]!, round.contestants[1]!],
    answerTasks: [round.answerTasks[0]!, round.answerTasks[1]!],
    votes: round.votes.map((vote: any) => toClientVote(round, vote)),
    scoreA: round.scoreA,
    scoreB: round.scoreB,
    viewerVotesA: round.viewerVotesA,
    viewerVotesB: round.viewerVotesB,
    viewerVotingEndsAt: round.viewerVotingEndsAt,
    viewerVotingWindowMs: round.viewerVotingWindowMs,
    viewerVotingMode: round.viewerVotingMode,
  };
}
