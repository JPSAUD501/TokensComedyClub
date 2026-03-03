async function getViewerCountSummaryRow(ctx: any) {
  return await ctx.db
    .query("viewerCountSummary")
    .withIndex("by_key", (q: any) => q.eq("key", "main"))
    .first();
}

export async function ensureViewerCountSummary(ctx: any): Promise<void> {
  const existing = await getViewerCountSummaryRow(ctx);
  if (existing) return;
  await rebuildViewerCountSummary(ctx);
}

export async function getOrCreateViewerCountSummary(ctx: any) {
  const existing = await getViewerCountSummaryRow(ctx);
  if (existing) return existing;

  const now = Date.now();
  const id = await ctx.db.insert("viewerCountSummary", {
    key: "main",
    webViewerCount: 0,
    platformViewerCount: 0,
    totalViewerCount: 0,
    updatedAt: now,
  });
  return await ctx.db.get(id);
}

export async function readWebViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db.query("viewerCountShards").collect();
  return rows.reduce((sum: number, row: any) => sum + row.count, 0);
}

export async function readPlatformViewerCount(ctx: any): Promise<number> {
  const rows = await ctx.db
    .query("viewerTargets")
    .withIndex("by_enabled", (q: any) => q.eq("enabled", true))
    .collect();
  return rows.reduce((sum: number, row: any) => sum + (row.isLive ? row.viewerCount : 0), 0);
}

export async function readTotalViewerCount(ctx: any): Promise<number> {
  const summary = await getViewerCountSummaryRow(ctx);
  if (summary) {
    return Math.max(0, Number(summary.totalViewerCount ?? 0));
  }

  const [web, platforms] = await Promise.all([readWebViewerCount(ctx), readPlatformViewerCount(ctx)]);
  return web + platforms;
}

export async function applyViewerCountDelta(
  ctx: any,
  deltas: { webDelta?: number; platformDelta?: number },
): Promise<void> {
  const webDelta = Number.isFinite(deltas.webDelta) ? Math.floor(deltas.webDelta as number) : 0;
  const platformDelta = Number.isFinite(deltas.platformDelta) ? Math.floor(deltas.platformDelta as number) : 0;
  if (webDelta === 0 && platformDelta === 0) return;

  const summary = await getOrCreateViewerCountSummary(ctx);
  if (!summary) return;

  const nextWeb = Math.max(0, Number(summary.webViewerCount ?? 0) + webDelta);
  const nextPlatform = Math.max(0, Number(summary.platformViewerCount ?? 0) + platformDelta);
  const nextTotal = nextWeb + nextPlatform;
  if (
    nextWeb === Number(summary.webViewerCount ?? 0) &&
    nextPlatform === Number(summary.platformViewerCount ?? 0)
  ) {
    return;
  }

  await ctx.db.patch(summary._id, {
    webViewerCount: nextWeb,
    platformViewerCount: nextPlatform,
    totalViewerCount: nextTotal,
    updatedAt: Date.now(),
  });
}

export async function rebuildViewerCountSummary(ctx: any): Promise<void> {
  const [webViewerCount, platformViewerCount] = await Promise.all([
    readWebViewerCount(ctx),
    readPlatformViewerCount(ctx),
  ]);
  const totalViewerCount = webViewerCount + platformViewerCount;

  const summary = await getOrCreateViewerCountSummary(ctx);
  if (!summary) return;

  await ctx.db.patch(summary._id, {
    webViewerCount,
    platformViewerCount,
    totalViewerCount,
    updatedAt: Date.now(),
  });
}
