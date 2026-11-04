// Remux Nashville/finalsignal DASH (VP9+Opus WebM) into HLS (H.264+AAC TS)
// so Tizen / hls.js clients can actually play it. One ffmpeg job per source
// URL, shared across viewers, cached on disk until idle expiry.
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const ROOT = process.env.DASH_HLS_CACHE || "/tmp/srctv-dashhls";
const IDLE_MS = 1000 * 60 * 90;
const READY_TIMEOUT_MS = 1000 * 90;

/** @type {Map<string, { child: import('child_process').ChildProcess, dir: string, playlist: string, ready: Promise<string>, lastUsed: number, failed?: string }>} */
const jobs = new Map();

function hashUrl(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

export function dashHlsHash(url) {
  return hashUrl(url);
}

export function dashHlsDir(url) {
  return path.join(ROOT, hashUrl(url));
}

function fileReady(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 32) {
          // Wait until at least one segment exists so players don't stall on
          // an empty VOD playlist.
          const dir = path.dirname(file);
          const segs = fs.readdirSync(dir).filter((f) => /\.ts$/i.test(f));
          if (segs.length >= 1) return resolve(file);
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("dash→hls remux timed out waiting for playlist"));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function buildFfmpegArgs(mpdUrl, dir, playlist) {
  // Prefer 720p to keep a 1GB droplet alive; ultrafast for startup latency.
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-headers",
    "Referer: https://www.movy.sx/\r\nOrigin: https://www.movy.sx/\r\n",
    "-user_agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "-i",
    mpdUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-vf",
    "scale=-2:'min(720,ih)'",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_playlist_type",
    "event",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    path.join(dir, "seg_%04d.ts"),
    playlist,
  ];
}

/**
 * Start (or reuse) an ffmpeg remux for this MPD. Resolves with the absolute
 * path to index.m3u8 once the first segment is on disk.
 */
export async function ensureDashHls(mpdUrl) {
  const key = hashUrl(mpdUrl);
  const dir = path.join(ROOT, key);
  const playlist = path.join(dir, "index.m3u8");

  let job = jobs.get(key);
  if (job?.failed) {
    jobs.delete(key);
    job = null;
  }
  if (job) {
    job.lastUsed = Date.now();
    return job.ready;
  }

  fs.mkdirSync(dir, { recursive: true });
  // Resume if a previous process left a usable playlist behind.
  if (fs.existsSync(playlist)) {
    try {
      const segs = fs.readdirSync(dir).filter((f) => /\.ts$/i.test(f));
      if (segs.length >= 1) {
        const ready = Promise.resolve(playlist);
        jobs.set(key, {
          child: null,
          dir,
          playlist,
          ready,
          lastUsed: Date.now(),
        });
        return ready;
      }
    } catch {}
  }

  const child = spawn("ffmpeg", buildFfmpegArgs(mpdUrl, dir, playlist), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });

  const ready = fileReady(playlist, READY_TIMEOUT_MS).catch((err) => {
    try {
      child.kill("SIGKILL");
    } catch {}
    const wrapped = new Error(err.message + (stderr ? `: ${stderr.trim()}` : ""));
    const cur = jobs.get(key);
    if (cur) cur.failed = wrapped.message;
    throw wrapped;
  });

  job = { child, dir, playlist, ready, lastUsed: Date.now() };
  jobs.set(key, job);

  child.on("exit", (code) => {
    const cur = jobs.get(key);
    if (!cur) return;
    if (code && code !== 0 && !fs.existsSync(playlist)) {
      cur.failed = `ffmpeg exited ${code}: ${stderr.trim()}`;
    }
    cur.child = null;
  });

  return ready;
}

export function readDashHlsFile(mpdUrl, name) {
  const key = hashUrl(mpdUrl);
  const job = jobs.get(key);
  if (job) job.lastUsed = Date.now();
  const dir = path.join(ROOT, key);
  // Only allow plain segment / playlist names inside the job dir.
  if (!/^(index\.m3u8|seg_\d+\.ts)$/i.test(name)) return null;
  const full = path.join(dir, name);
  if (!full.startsWith(dir) || !fs.existsSync(full)) return null;
  return full;
}

// Drop idle remux dirs so /tmp doesn't fill up.
setInterval(() => {
  const now = Date.now();
  for (const [key, job] of jobs) {
    if (now - job.lastUsed < IDLE_MS) continue;
    try {
      job.child?.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(job.dir, { recursive: true, force: true });
    } catch {}
    jobs.delete(key);
  }
  // Also sweep orphan dirs
  try {
    if (!fs.existsSync(ROOT)) return;
    for (const name of fs.readdirSync(ROOT)) {
      if (jobs.has(name)) continue;
      const dir = path.join(ROOT, name);
      try {
        const st = fs.statSync(dir);
        if (now - st.mtimeMs > IDLE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}, 60 * 1000).unref?.();
