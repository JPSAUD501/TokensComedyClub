import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
const convexInternal = internal as any;
import {
  PLATFORM_VIEWER_POLL_INTERVAL_MS,
  TWITCH_API_BATCH_SIZE,
  YOUTUBE_API_BATCH_SIZE,
} from "./constants";
import { getOrCreateEngineState } from "./state";

type Platform = "twitch" | "youtube";

type PollTarget = {
  _id: string;
  platform: Platform;
  target: string;
};

type PollUpdate = {
  targetId: string;
  viewerCount: number;
  isLive: boolean;
  lastError?: string;
};

function getPollIntervalMs(): number {
  const raw = Number.parseInt(process.env.PLATFORM_VIEWER_POLL_INTERVAL_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return PLATFORM_VIEWER_POLL_INTERVAL_MS;
  return raw;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    output.push(arr.slice(i, i + size));
  }
  return output;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getTwitchAccessToken(): Promise<string> {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET missing");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetch(`https://id.twitch.tv/oauth2/token?${params.toString()}`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Twitch auth failed (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Twitch auth missing access token");
  }
  return body.access_token;
}

async function pollTwitchTargets(targets: PollTarget[]): Promise<PollUpdate[]> {
  if (targets.length === 0) return [];
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  if (!clientId) {
    return targets.map((target) => ({
      targetId: target._id,
      viewerCount: 0,
      isLive: false,
      lastError: "TWITCH_CLIENT_ID missing",
    }));
  }

  try {
    const token = await getTwitchAccessToken();
    const updates = new Map<string, PollUpdate>();
    for (const group of chunk(targets, TWITCH_API_BATCH_SIZE)) {
      const params = new URLSearchParams();
      for (const target of group) {
        params.append("user_login", target.target);
      }

      const response = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
        headers: {
          "Client-ID": clientId,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Twitch streams failed (${response.status})`);
      }

      const body = (await response.json()) as {
        data?: Array<{ user_login?: string; viewer_count?: number }>;
      };
      const liveByLogin = new Map<string, number>();
      for (const stream of body.data ?? []) {
        const login = (stream.user_login ?? "").toLowerCase();
        if (!login) continue;
        liveByLogin.set(login, Number(stream.viewer_count ?? 0));
      }

      for (const target of group) {
        const count = liveByLogin.get(target.target.toLowerCase()) ?? 0;
        updates.set(target._id, {
          targetId: target._id,
          viewerCount: count,
          isLive: count > 0,
        });
      }
    }
    return [...updates.values()];
  } catch (error) {
    const message = toErrorMessage(error);
    return targets.map((target) => ({
      targetId: target._id,
      viewerCount: 0,
      isLive: false,
      lastError: message,
    }));
  }
}

async function pollYouTubeTargets(targets: PollTarget[]): Promise<PollUpdate[]> {
  if (targets.length === 0) return [];
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    return targets.map((target) => ({
      targetId: target._id,
      viewerCount: 0,
      isLive: false,
      lastError: "YOUTUBE_API_KEY missing",
    }));
  }

  try {
    const updates = new Map<string, PollUpdate>();
    for (const group of chunk(targets, YOUTUBE_API_BATCH_SIZE)) {
      const ids = group.map((target) => target.target).join(",");
      const params = new URLSearchParams({
        part: "liveStreamingDetails",
        id: ids,
        key: apiKey,
      });
      const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`YouTube videos.list failed (${response.status})`);
      }

      const body = (await response.json()) as {
        items?: Array<{
          id?: string;
          liveStreamingDetails?: { concurrentViewers?: string };
        }>;
      };
      const liveByVideoId = new Map<string, number>();
      for (const item of body.items ?? []) {
        const videoId = item.id ?? "";
        if (!videoId) continue;
        const concurrent = Number.parseInt(item.liveStreamingDetails?.concurrentViewers ?? "", 10);
        const count = Number.isFinite(concurrent) && concurrent > 0 ? concurrent : 0;
        liveByVideoId.set(videoId, count);
      }

      for (const target of group) {
        const count = liveByVideoId.get(target.target) ?? 0;
        updates.set(target._id, {
          targetId: target._id,
          viewerCount: count,
          isLive: count > 0,
        });
      }
    }
    return [...updates.values()];
  } catch (error) {
    const message = toErrorMessage(error);
    return targets.map((target) => ({
      targetId: target._id,
      viewerCount: 0,
      isLive: false,
      lastError: message,
    }));
  }
}

export const listEnabledTargets = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    return await ctx.db
      .query("viewerTargets")
      .withIndex("by_enabled", (q: any) => q.eq("enabled", true))
      .collect();
  },
});

export const applyPollUpdates = internalMutation({
  args: {
    updates: v.array(
      v.object({
        targetId: v.id("viewerTargets"),
        viewerCount: v.number(),
        isLive: v.boolean(),
        lastError: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const update of args.updates) {
      const row = await ctx.db.get(update.targetId);
      if (!row) continue;
      await ctx.db.patch(update.targetId, {
        viewerCount: Math.max(0, update.viewerCount),
        isLive: update.isLive,
        lastError: update.lastError,
        lastPolledAt: now,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const ensurePollingStarted = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const interval = getPollIntervalMs();
    const state = await getOrCreateEngineState(ctx as any);
    if (!state.platformPollScheduledAt || state.platformPollScheduledAt <= now) {
      await ctx.scheduler.runAfter(0, convexInternal.platformViewers.pollTargets, {});
      await ctx.db.patch(state._id, {
        platformPollScheduledAt: now + interval,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const scheduleNextPoll = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const interval = getPollIntervalMs();
    const state = await getOrCreateEngineState(ctx as any);
    await ctx.scheduler.runAfter(interval, convexInternal.platformViewers.pollTargets, {});
    await ctx.db.patch(state._id, {
      platformPollScheduledAt: now + interval,
      updatedAt: now,
    });
    return null;
  },
});

export const pollTargets = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    try {
      const enabled = (await ctx.runQuery(convexInternal.platformViewers.listEnabledTargets, {})) as PollTarget[];
      const twitchTargets = enabled.filter((target) => target.platform === "twitch");
      const youtubeTargets = enabled.filter((target) => target.platform === "youtube");

      const [twitchUpdates, youtubeUpdates] = await Promise.all([
        pollTwitchTargets(twitchTargets),
        pollYouTubeTargets(youtubeTargets),
      ]);

      const updates = [...twitchUpdates, ...youtubeUpdates];
      if (updates.length > 0) {
        await ctx.runMutation(convexInternal.platformViewers.applyPollUpdates, {
          updates: updates.map((update) => ({
            targetId: update.targetId as any,
            viewerCount: update.viewerCount,
            isLive: update.isLive,
            lastError: update.lastError,
          })),
        });
        await ctx.runMutation(convexInternal.engine.maybeShortenVotingWindow, {});
      }
    } finally {
      await ctx.runMutation(convexInternal.platformViewers.scheduleNextPoll, {});
    }

    return null;
  },
});
