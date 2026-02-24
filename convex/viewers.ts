import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import {
  VIEWER_PRESENCE_REAPER_MAX_LIMIT,
  VIEWER_REAPER_BATCH,
  VIEWER_REAPER_INTERVAL_MS,
  VIEWER_SESSION_TTL_MS,
  VIEWER_SHARD_COUNT,
  hashToShard,
} from "./constants";
import { getOrCreateEngineState, resolveRuntimeRoundTiming } from "./state";
import { readTotalViewerCount } from "./viewerCount";

async function adjustCountShard(ctx: any, shard: number, delta: number) {
  const row = await ctx.db
    .query("viewerCountShards")
    .withIndex("by_shard", (q: any) => q.eq("shard", shard))
    .first();

  const now = Date.now();
  if (!row) {
    if (delta <= 0) return;
    await ctx.db.insert("viewerCountShards", {
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

    const now = Date.now();
    const shard = hashToShard(args.viewerId, VIEWER_SHARD_COUNT);
    let increasedCount = false;

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
      await adjustCountShard(ctx, shard, 1);
      increasedCount = true;
    } else {
      const wasExpired = existing.expiresAt <= now;
      await ctx.db.patch(existing._id, {
        page: args.page,
        expiresAt,
        lastSeenAt: now,
        updatedAt: now,
      });
      if (wasExpired) {
        await adjustCountShard(ctx, existing.countShard, 1);
        increasedCount = true;
      }
    }

    const engine = await getOrCreateEngineState(ctx as any);
    if (!engine.reaperScheduledAt || engine.reaperScheduledAt <= now) {
      await ctx.scheduler.runAfter(0, convexInternal.viewers.reapExpired, {
        limit: VIEWER_REAPER_BATCH,
      });
      await ctx.db.patch(engine._id, {
        reaperScheduledAt: now + VIEWER_REAPER_INTERVAL_MS,
      });
    }

    if (increasedCount && engine.activeRoundId) {
      const activeRound = await ctx.db.get(engine.activeRoundId);
      if (activeRound && activeRound.phase === "voting" && activeRound.viewerVotingEndsAt) {
        const timing = resolveRuntimeRoundTiming(engine);
        const shortenNow = Date.now();
        const remaining = activeRound.viewerVotingEndsAt - shortenNow;
        if (remaining > timing.viewerVoteWindowActiveMs) {
          const totalViewerCount = await readTotalViewerCount(ctx as any);
          if (totalViewerCount > 0) {
            await ctx.db.patch(activeRound._id, {
              viewerVotingEndsAt: shortenNow + timing.viewerVoteWindowActiveMs,
              viewerVotingWindowMs: timing.viewerVoteWindowActiveMs,
              viewerVotingMode: "active",
              updatedAt: shortenNow,
            });
          }
        }
      }
    }

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
  const engine = await getOrCreateEngineState(ctx as any);
  if (!engine.activeRoundId) {
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
    for (const session of expired) {
      if (session.expiresAt > now) continue;
      await adjustCountShard(ctx, session.countShard, -1);
      await ctx.db.delete(session._id);
      processed += 1;
    }

    const engine = await getOrCreateEngineState(ctx as any);
    const delayMs = expired.length === limit ? 0 : VIEWER_REAPER_INTERVAL_MS;
    await ctx.scheduler.runAfter(delayMs, convexInternal.viewers.reapExpired, { limit });
    await ctx.db.patch(engine._id, {
      reaperScheduledAt: now + delayMs,
      updatedAt: now,
    });

    return { processed };
  },
});

