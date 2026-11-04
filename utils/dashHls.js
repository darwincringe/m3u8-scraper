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

/** @type {Map<string, { child: import('child_process').ChildProcess|null, dir: string, playlist: string, ready: Promise<string>, lastUsed: number, failed?: string, expectedSec?: number }>} */
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

function playlistDurationSec(playlistPath) {
  try {
    const text = fs.readFileSync(playlistPath, "utf8");
    return [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  } catch {
    return 0;
  }
}

function playlistHasEnd(playlistPath) {
  try {
    return /#EXT-X-ENDLIST/i.test(fs.readFileSync(playlistPath, "utf8"));
  } catch {
    return false;
  }
}

function isRemuxComplete(playlistPath, expectedSec) {
  if (!fs.existsSync(playlistPath) || !playlistHasEnd(playlistPath)) return false;
  const dur = playlistDurationSec(playlistPath);
  if (expectedSec && expectedSec > 30) return dur >= expectedSec * 0.9;
  // Without an MPD duration, demand at least 2 minutes so a 30s stall
  // isn't treated as a finished episode.
  return dur >= 120;
}

async function fetchMpdDurationSec(mpdUrl) {
  try {
    const res = await fetch(mpdUrl, {
      headers: {
        Referer: "https://www.movy.sx/",
        Origin: "https://www.movy.sx",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const raw = (text.match(/mediaPresentationDuration="([^"]+)"/i) || [])[1];
    if (!raw) return null;
    // PT2725.499023S or PT1H5M25.5S
    const h = /([\d.]+)H/i.exec(raw);
    const m = /([\d.]+)M/i.exec(raw);
    const s = /([\d.]+)S/i.exec(raw);
    return (
      (h ? Number(h[1]) * 3600 : 0) +
      (m ? Number(m[1]) * 60 : 0) +
      (s ? Number(s[1]) : 0)
    );
  } catch {
    return null;
  }
}

function fileReady(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 32) {
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
  // Use -referer (not -headers): broken CR/LF headers made finalsignal EOF
  // after ~30s and ffmpeg wrote a truncated playlist with ENDLIST.
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-referer",
    "https://www.movy.sx/",
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

function clearDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Start (or reuse) an ffmpeg remux for this MPD. Resolves with the absolute
 * path to index.m3u8 once the first segment is on disk. Keeps encoding in
 * the background until the full episode is written.
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

  // Already started (encoding or complete) — reuse the same promise so
  // extract warm + /dash-hls hit don't spawn two ffmpegs into one dir.
  if (job?.ready) {
    job.lastUsed = Date.now();
    return job.ready;
  }

  // Reserve the slot synchronously before any await (MPD duration fetch).
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  job = {
    child: null,
    dir,
    playlist,
    ready,
    lastUsed: Date.now(),
  };
  jobs.set(key, job);

  (async () => {
    try {
      const expectedSec = await fetchMpdDurationSec(mpdUrl);
      job.expectedSec = expectedSec || undefined;

      if (isRemuxComplete(playlist, expectedSec)) {
        resolveReady(playlist);
        return;
      }

      if (fs.existsSync(dir)) {
        const dur = playlistDurationSec(playlist);
        console.warn(
          `[dash-hls] restarting remux ${key} (had ${dur.toFixed(0)}s` +
            (expectedSec ? `/${expectedSec.toFixed(0)}s` : "") +
            `, endlist=${playlistHasEnd(playlist)})`
        );
        clearDir(dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }

      const child = spawn("ffmpeg", buildFfmpegArgs(mpdUrl, dir, playlist), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      job.child = child;
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });

      child.on("exit", (code) => {
        const cur = jobs.get(key);
        if (!cur) return;
        cur.child = null;
        const dur = playlistDurationSec(playlist);
        const complete = isRemuxComplete(playlist, cur.expectedSec);
        if (code && code !== 0 && !complete) {
          cur.failed = `ffmpeg exited ${code} after ${dur.toFixed(0)}s: ${stderr.trim()}`;
          console.error(`[dash-hls] ${cur.failed}`);
          return;
        }
        if (complete && fs.existsSync(playlist) && !playlistHasEnd(playlist)) {
          try {
            fs.appendFileSync(playlist, "\n#EXT-X-ENDLIST\n");
          } catch {}
        }
        if (!complete) {
          cur.failed =
            `ffmpeg ended early after ${dur.toFixed(0)}s` +
            (cur.expectedSec ? ` (expected ~${cur.expectedSec.toFixed(0)}s)` : "") +
            (stderr ? `: ${stderr.trim()}` : "");
          console.error(`[dash-hls] ${cur.failed}`);
        } else {
          console.log(`[dash-hls] remux complete ${key}: ${dur.toFixed(0)}s`);
        }
      });

      await fileReady(playlist, READY_TIMEOUT_MS);
      resolveReady(playlist);
    } catch (err) {
      try {
        job.child?.kill("SIGKILL");
      } catch {}
      job.failed = err?.message || String(err);
      rejectReady(err);
    }
  })();

  return ready;
}

export function readDashHlsFile(mpdUrl, name) {
  const key = hashUrl(mpdUrl);
  const job = jobs.get(key);
  if (job) job.lastUsed = Date.now();
  const dir = path.join(ROOT, key);
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
