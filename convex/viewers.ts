import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import {
  VIEWER_PRESENCE_REAPER_MAX_LIMIT,
  VIEWER_REAPER_BATCH,
  VIEWER_SESSION_TTL_MS,
  VIEWER_SHARD_COUNT,
  hashToShard,
} from "./constants";
import { getEngineState } from "./state";
import { applyViewerCountDelta } from "./viewerCount";

async function getViewerReaperState(ctx: any) {
  return await ctx.db
    .query("viewerReaperState")
    .withIndex("by_key", (q: any) => q.eq("key", "main"))
    .first();
}

async function getOrCreateViewerReaperState(ctx: any) {
  const existing = await getViewerReaperState(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("viewerReaperState", {
    key: "main",
    updatedAt: Date.now(),
  });
  return await ctx.db.get(id);
}

async function adjustCountShard(ctx: any, shard: number, delta: number): Promise<number> {
  const row = await ctx.db
    .query("viewerCountShards")
    .withIndex("by_shard", (q: any) => q.eq("shard", shard))
    .first();

  const now = Date.now();
  if (!row) {
    if (delta <= 0) return 0;
    await ctx.db.insert("viewerCountShards", {
      shard,
      count: delta,
      updatedAt: now,
    });
    return delta;
  }

  const nextCount = Math.max(0, row.count + delta);
  const appliedDelta = nextCount - row.count;
  if (appliedDelta === 0) {
    return 0;
  }

  await ctx.db.patch(row._id, {
    count: nextCount,
    updatedAt: now,
  });
  return appliedDelta;
}

async function adjustVoteTally(
  ctx: any,
  roundId: any,
  generation: number,
  side: "A" | "B",
  shard: number,
  delta: number,
) {
  const row = await ctx.db
    .query("viewerVoteTallies")
    .withIndex("by_round_side_shard", (q: any) =>
      q.eq("roundId", roundId).eq("side", side).eq("shard", shard),
    )
    .first();

  const now = Date.now();
  if (!row) {
    if (delta <= 0) return;
    await ctx.db.insert("viewerVoteTallies", {
      generation,
      roundId,
      side,
      shard,
      count: delta,
      updatedAt: now,
    });
    return;
  }

  await ctx.db.patch(row._id, {
    count: Math.max(0, row.count + delta),
    updatedAt: now,
  });
}

async function getEarliestPresenceExpiresAt(ctx: any): Promise<number | null> {
  const earliest = await ctx.db.query("viewerPresence").withIndex("by_expiresAt").take(1);
  if (earliest.length === 0) return null;
  const expiresAt = earliest[0]?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null;
}

async function scheduleReaperAt(
  ctx: any,
  reaperState: any,
  runAt: number,
  limit: number,
) {
  const now = Date.now();
  const safeRunAt = Math.max(now, runAt);
  const currentScheduledAt =
    typeof reaperState?.scheduledAt === "number" && Number.isFinite(reaperState.scheduledAt)
      ? reaperState.scheduledAt
      : null;

  if (
    currentScheduledAt !== null &&
    currentScheduledAt > now &&
    currentScheduledAt <= safeRunAt
  ) {
    return;
  }

  await ctx.scheduler.runAfter(Math.max(0, safeRunAt - now), convexInternal.viewers.reapExpired, { limit });
  if (reaperState) {
    await ctx.db.patch(reaperState._id, {
      scheduledAt: safeRunAt,
      updatedAt: now,
    });
  }
}

async function scheduleReaperFromPresence(
  ctx: any,
  reaperState: any,
  limit: number,
) {
  const earliestExpiresAt = await getEarliestPresenceExpiresAt(ctx);
  if (earliestExpiresAt === null) {
    if (reaperState?.scheduledAt !== undefined) {
      await ctx.db.patch(reaperState._id, {
        scheduledAt: undefined,
        updatedAt: Date.now(),
      });
    }
    return;
  }
  await scheduleReaperAt(ctx, reaperState, earliestExpiresAt, limit);
}

export const heartbeat = mutation({
  args: {
    viewerId: v.string(),
    page: v.union(v.literal("live"), v.literal("broadcast")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.page === "broadcast") {
      return null;
    }

    const engineState = await getEngineState(ctx as any);
    if (engineState?.isPaused) {
      return null;
    }

    const now = Date.now();
    const shard = hashToShard(args.viewerId, VIEWER_SHARD_COUNT);
    const existing = await ctx.db
      .query("viewerPresence")
      .withIndex("by_viewerId", (q: any) => q.eq("viewerId", args.viewerId))
      .first();

    const expiresAt = now + VIEWER_SESSION_TTL_MS;

    if (!existing) {
      await ctx.db.insert("viewerPresence", {
        viewerId: args.viewerId,
        page: args.page,
        expiresAt,
        lastSeenAt: now,
        countShard: shard,
        updatedAt: now,
      });
      const appliedDelta = await adjustCountShard(ctx, shard, 1);
      await applyViewerCountDelta(ctx, { webDelta: appliedDelta });
    } else {
      await ctx.db.patch(existing._id, {
        page: args.page,
        expiresAt,
        lastSeenAt: now,
        updatedAt: now,
      });
    }

    const reaperState = await getOrCreateViewerReaperState(ctx as any);
    await scheduleReaperFromPresence(ctx, reaperState, VIEWER_REAPER_BATCH);

    return null;
  },
});

export const castVote = mutation({
  args: {
    viewerId: v.string(),
    side: v.union(v.literal("A"), v.literal("B")),
  },
  returns: v.object({
    ok: v.boolean(),
    votedFor: v.union(v.literal("A"), v.literal("B"), v.null()),
    status: v.union(
      v.literal("accepted"),
      v.literal("updated"),
      v.literal("unchanged"),
      v.literal("inactive"),
    ),
  }),
  handler: async (ctx, args) => castVoteImpl(ctx, args),
});

export const castVoteInternal = internalMutation({
  args: {
    viewerId: v.string(),
    side: v.union(v.literal("A"), v.literal("B")),
  },
  returns: v.object({
    ok: v.boolean(),
    votedFor: v.union(v.literal("A"), v.literal("B"), v.null()),
    status: v.union(
      v.literal("accepted"),
      v.literal("updated"),
      v.literal("unchanged"),
      v.literal("inactive"),
    ),
  }),
  handler: async (ctx, args) => castVoteImpl(ctx, args),
});

async function castVoteImpl(
  ctx: any,
  args: { viewerId: string; side: "A" | "B" },
): Promise<{
  ok: boolean;
  votedFor: "A" | "B" | null;
  status: "accepted" | "updated" | "unchanged" | "inactive";
}> {
  const engine = await getEngineState(ctx as any);
  if (!engine?.activeRoundId) {
    return { ok: false, votedFor: null, status: "inactive" };
  }

  const round = await ctx.db.get(engine.activeRoundId);
  if (!round || round.phase !== "voting") {
    return { ok: false, votedFor: null, status: "inactive" };
  }

  if (!round.viewerVotingEndsAt || Date.now() > round.viewerVotingEndsAt) {
    return { ok: false, votedFor: null, status: "inactive" };
  }

  const shard = hashToShard(args.viewerId, VIEWER_SHARD_COUNT);
  const existing = await ctx.db
    .query("viewerVotes")
    .withIndex("by_round_and_viewer", (q: any) =>
      q.eq("roundId", round._id).eq("viewerId", args.viewerId),
    )
    .first();

  if (!existing) {
    await ctx.db.insert("viewerVotes", {
      generation: round.generation,
      roundId: round._id,
      viewerId: args.viewerId,
      side: args.side,
      shard,
      updatedAt: Date.now(),
    });
    await adjustVoteTally(ctx, round._id, round.generation, args.side, shard, 1);
    return { ok: true, votedFor: args.side, status: "accepted" };
  }

  if (existing.side === args.side) {
    return { ok: true, votedFor: args.side, status: "unchanged" };
  }

  await ctx.db.patch(existing._id, {
    side: args.side,
    updatedAt: Date.now(),
  });

  await adjustVoteTally(ctx, round._id, round.generation, existing.side, existing.shard, -1);
  await adjustVoteTally(ctx, round._id, round.generation, args.side, existing.shard, 1);

  return { ok: true, votedFor: args.side, status: "updated" };
}

export const reapExpired = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? VIEWER_REAPER_BATCH, VIEWER_PRESENCE_REAPER_MAX_LIMIT));

    const expired = await ctx.db
      .query("viewerPresence")
      .withIndex("by_expiresAt", (q: any) => q.lte("expiresAt", now))
      .take(limit);

    let processed = 0;
    let webDelta = 0;
    for (const session of expired) {
      if (session.expiresAt > now) continue;
      const appliedDelta = await adjustCountShard(ctx, session.countShard, -1);
      webDelta += appliedDelta;
      await ctx.db.delete(session._id);
      processed += 1;
    }
    await applyViewerCountDelta(ctx, { webDelta });

    const reaperState = await getOrCreateViewerReaperState(ctx as any);
    await scheduleReaperFromPresence(ctx, reaperState, limit);

    return { processed };
  },
});
