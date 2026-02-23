import puppeteer from "puppeteer";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Mode = "live" | "dryrun";

type SinkWriter = {
  write(chunk: Uint8Array): number;
  end(error?: Error): number;
};

const STREAM_FPS = 30;
const CAPTURE_BITRATE = 12_000_000;
const TARGET_WIDTH = "1920";
const TARGET_HEIGHT = "1080";
const VIDEO_BITRATE = "6000k";
const MAXRATE = "6000k";
const BUFSIZE = "12000k";
const GOP = "60";
const AUDIO_BITRATE = "160k";
const PLAYLIST_TRACKS = 20_000;

function usage(): never {
  console.error("Usage: bun scripts/stream-browser.ts <live|dryrun>");
  console.error("Required for live mode: STREAM_RTMP_TARGET");
  console.error("Required for audio: music/bg_1.mp3, music/bg_2.mp3, ...");
  process.exit(1);
}

function resolveMode(value: string | undefined): Mode {
  if (value === "live" || value === "dryrun") return value;
  return usage();
}

const mode = resolveMode(process.argv[2]);

const streamRtmpTarget = process.env.STREAM_RTMP_TARGET?.trim() ?? "";
const streamOutputTarget = streamRtmpTarget;
const broadcastUrl = process.env.BROADCAST_URL?.trim() || "http://127.0.0.1:5109/broadcast.html";
const redactionTokens = [
  broadcastUrl,
  streamRtmpTarget,
  streamOutputTarget,
].filter((token): token is string => Boolean(token));
const redactionWindow = Math.max(1, ...redactionTokens.map((token) => token.length));

function redactSensitive(value: string): string {
  let output = value;
  for (const token of redactionTokens) {
    output = output.split(token).join("[REDACTED]");
  }
  return output;
}

if (mode === "live" && !streamOutputTarget) {
  console.error("STREAM_RTMP_TARGET is not set.");
  process.exit(1);
}

function resolveMusicDir(): string {
  return path.resolve(process.cwd(), "music");
}

function compareTrackNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function pickRandomTrack(tracks: string[], previous: string | null): string {
  if (tracks.length === 1) return tracks[0]!;
  let picked = tracks[Math.floor(Math.random() * tracks.length)]!;
  while (picked === previous) {
    picked = tracks[Math.floor(Math.random() * tracks.length)]!;
  }
  return picked;
}

function buildRandomTrackSequence(tracks: string[], size: number): string[] {
  const sequence: string[] = [];
  let previous: string | null = null;
  for (let i = 0; i < size; i++) {
    const next = pickRandomTrack(tracks, previous);
    sequence.push(next);
    previous = next;
  }
  return sequence;
}

function escapeForConcatFile(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

async function getBackgroundTracks(): Promise<string[]> {
  const musicDir = resolveMusicDir();
  let names: string[];
  try {
    names = await readdir(musicDir);
  } catch {
    throw new Error(`Music directory not found: ${musicDir}`);
  }

  const tracks = names
    .filter((name) => /^bg_\d+\.mp3$/i.test(name))
    .sort(compareTrackNames)
    .map((name) => path.join(musicDir, name));

  if (tracks.length === 0) {
    throw new Error(`No tracks found in ${musicDir}. Add files like bg_1.mp3, bg_2.mp3...`);
  }

  return tracks;
}

async function writePlaylistFile(tracks: string[]): Promise<string> {
  const sequence = buildRandomTrackSequence(tracks, PLAYLIST_TRACKS);
  const filePath = path.join(
    tmpdir(),
    `tokenscomedyclub-bg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const body = sequence.map((track) => `file '${escapeForConcatFile(track)}'`).join("\n") + "\n";
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function assertBroadcastReachable(url: string) {
  const timeoutMs = 5_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach broadcast page (${redactSensitive(detail)}). Start the app server first (bun run preview:web or bun run dev:web).`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildFfmpegArgs(currentMode: Mode, playlistPath: string): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    "-f",
    "webm",
    "-i",
    "pipe:0",
    "-stream_loop",
    "-1",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    playlistPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAXRATE,
    "-bufsize",
    BUFSIZE,
    "-g",
    GOP,
    "-keyint_min",
    GOP,
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-ar",
    "44100",
    "-ac",
    "2",
  ];

  if (currentMode === "live") {
    args.push("-f", "flv", streamOutputTarget);
    return args;
  }

  args.push("-f", "mpegts", "pipe:1");
  return args;
}

async function pipeReadableToSink(
  readable: ReadableStream<Uint8Array>,
  sink: SinkWriter,
) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
    }
  } finally {
    sink.end();
  }
}

async function pipeReadableToRedactedStderr(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const combined = carry + chunk;
      if (combined.length <= redactionWindow) {
        carry = combined;
        continue;
      }
      const flushUntil = combined.length - (redactionWindow - 1);
      const safeOutput = combined.slice(0, flushUntil);
      carry = combined.slice(flushUntil);
      if (safeOutput.length > 0) {
        process.stderr.write(redactSensitive(safeOutput));
      }
    }
    const trailing = carry + decoder.decode();
    if (trailing.length > 0) {
      process.stderr.write(redactSensitive(trailing));
    }
  } finally {
    reader.releaseLock();
  }
}

async function main() {
  await assertBroadcastReachable(broadcastUrl);
  const tracks = await getBackgroundTracks();
  const playlistPath = await writePlaylistFile(tracks);

  const ffmpegArgs = buildFfmpegArgs(mode, playlistPath);
  const ffmpeg = Bun.spawn(["ffmpeg", ...ffmpegArgs], {
    stdin: "pipe",
    stdout: mode === "dryrun" ? "pipe" : "inherit",
    stderr: "pipe",
  });
  void pipeReadableToRedactedStderr(ffmpeg.stderr);
  let ffmpegWritable = true;

  let ffplay: Bun.Subprocess | null = null;
  let ffplayPump: Promise<void> | null = null;
  if (mode === "dryrun") {
    ffplay = Bun.spawn(
      [
        "ffplay",
        "-hide_banner",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-framedrop",
        "-i",
        "pipe:0",
      ],
      {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const stdout = ffmpeg.stdout;
    if (!stdout || !ffplay.stdin) {
      throw new Error("Failed to pipe ffmpeg output into ffplay.");
    }
    if (typeof ffplay.stdin === "number") {
      throw new Error("ffplay stdin is not writable.");
    }
    ffplayPump = pipeReadableToSink(stdout, ffplay.stdin as SinkWriter);
  }

  let firstChunkResolve: (() => void) | null = null;
  let firstChunkReject: ((error: Error) => void) | null = null;
  const firstChunk = new Promise<void>((resolve, reject) => {
    firstChunkResolve = resolve;
    firstChunkReject = reject;
  });
  let shutdown: (() => Promise<void>) | null = null;

  const chunkServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/chunks" && req.method === "POST") {
        if (!ffmpegWritable || !ffmpeg.stdin || typeof ffmpeg.stdin === "number") {
          return new Response("stream closed", { status: 503 });
        }
        try {
          const payload = await req.arrayBuffer();
          ffmpeg.stdin.write(new Uint8Array(payload));
          firstChunkResolve?.();
          firstChunkResolve = null;
          firstChunkReject = null;
          return new Response("ok", { status: 200 });
        } catch (error) {
          ffmpegWritable = false;
          const detail = error instanceof Error ? error : new Error(String(error));
          firstChunkReject?.(detail);
          firstChunkResolve = null;
          firstChunkReject = null;
          void shutdown?.();
          return new Response("write failed", { status: 500 });
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--allow-running-insecure-content",
      "--disable-features=LocalNetworkAccessChecks",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  const captureUrl = new URL(broadcastUrl);
  captureUrl.searchParams.set("sink", `http://127.0.0.1:${chunkServer.port}/chunks`);
  captureUrl.searchParams.set("captureFps", String(STREAM_FPS));
  captureUrl.searchParams.set("captureBitrate", String(CAPTURE_BITRATE));

  await page.goto(captureUrl.toString(), { waitUntil: "networkidle2" });
  await page.waitForSelector("#broadcast-canvas", { timeout: 10_000 });

  const firstChunkTimer = setTimeout(() => {
    firstChunkReject?.(
      new Error("No media chunks received from headless browser within 10s."),
    );
  }, 10_000);

  await firstChunk.finally(() => clearTimeout(firstChunkTimer));
  console.log(`Streaming broadcast in ${mode} mode`);

  let shuttingDown = false;
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ffmpegWritable = false;
    try {
      chunkServer.stop(true);
    } catch {}
    try {
      await browser.close();
    } catch {}
    try {
      ffmpeg.stdin?.end();
    } catch {}
    try {
      ffmpeg.kill();
    } catch {}
    if (ffplay) {
      try {
        if (ffplay.stdin && typeof ffplay.stdin !== "number") {
          ffplay.stdin.end();
        }
      } catch {}
      try {
        ffplay.kill();
      } catch {}
    }
    try {
      await unlink(playlistPath);
    } catch {}
  };

  const ffmpegExit = ffmpeg.exited.then((code) => {
    ffmpegWritable = false;
    void shutdown?.();
    return code;
  });

  process.on("SIGINT", () => {
    void shutdown?.();
  });
  process.on("SIGTERM", () => {
    void shutdown?.();
  });

  const exitCode = await ffmpegExit;
  if (ffplayPump) {
    await ffplayPump.catch(() => {
      // Ignore downstream pipe failures on shutdown.
    });
  }
  if (ffplay) {
    await ffplay.exited;
  }
  await shutdown?.();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(redactSensitive(detail));
  process.exit(1);
});
