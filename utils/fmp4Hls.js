// Remux fMP4 HLS (movy / flixhq / ophim) into MPEG-TS HLS with stream
// copy. Tizen AVPlay is unreliable with EXT-X-MAP / moof fragments; TS
// plays. Copy remux runs ~20x realtime so we stay ahead of any player.
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const ROOT = process.env.FMP4_HLS_CACHE || "/tmp/srctv-fmp4hls";
const IDLE_MS = 1000 * 60 * 90;
const READY_TIMEOUT_MS = 1000 * 90;
/** Sources whose CDNs need Movy-style Referer (and cdn hint on child proxy). */
const MOVY_LIKE = new Set(["movy"]);

/** @type {Map<string, { child: import('child_process').ChildProcess|null, dir: string, playlist: string, ready: Promise<string>, lastUsed: number, failed?: string }>} */
const jobs = new Map();

function hashUrl(url) {
  return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 16);
}

export function fmp4HlsHash(url) {
  return hashUrl(url);
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

function fileReady(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 32) {
          const dir = path.dirname(file);
          const segs = fs.readdirSync(dir).filter((f) => /\.ts$/i.test(f));
          // ~12s of content is enough — copy remux stays ~20x ahead.
          if (segs.length >= 2 && playlistDurationSec(file) >= 8) return resolve(file);
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("fmp4→ts remux timed out waiting for playlist"));
      }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function clearDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

function inputUrlForFfmpeg(srcUrl, source) {
  // Prefer fetching via our own hls-proxy so CDN referers / cookies stay
  // correct and ffmpeg doesn't need per-CDN header hacks.
  const origin = process.env.PUBLIC_ORIGIN || "http://127.0.0.1:4000";
  const cdn =
    source && MOVY_LIKE.has(source)
      ? "&cdn=movy"
      : source === "catflix"
        ? "&cdn=catflix"
        : "";
  return `${origin}/hls-proxy?url=${encodeURIComponent(srcUrl)}${cdn}`;
}

function buildFfmpegArgs(input, dir, playlist) {
  // No PLAYLIST-TYPE / INDEPENDENT-SEGMENTS — Tizen AVPlay mishandles both.
  // omit_endlist until ffmpeg finishes, then we append ENDLIST ourselves.
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-user_agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_segment_type",
    "mpegts",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "omit_endlist",
    "-hls_segment_filename",
    path.join(dir, "seg_%04d.ts"),
    playlist,
  ];
}

/**
 * Start (or reuse) an fMP4→TS remux. Resolves once ~8s of TS is on disk.
 */
export async function ensureFmp4Hls(srcUrl, source = "") {
  const key = hashUrl(srcUrl);
  const dir = path.join(ROOT, key);
  const playlist = path.join(dir, "index.m3u8");

  let job = jobs.get(key);
  if (job?.failed) {
    jobs.delete(key);
    job = null;
  }
  if (job?.ready) {
    job.lastUsed = Date.now();
    return job.ready;
  }

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  job = { child: null, dir, playlist, ready, lastUsed: Date.now() };
  jobs.set(key, job);

  (async () => {
    try {
      if (playlistHasEnd(playlist) && playlistDurationSec(playlist) >= 60) {
        resolveReady(playlist);
        return;
      }

      if (fs.existsSync(dir)) {
        clearDir(dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }

      const input = inputUrlForFfmpeg(srcUrl, source);
      const child = spawn("ffmpeg", buildFfmpegArgs(input, dir, playlist), {
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
        if (fs.existsSync(playlist) && !playlistHasEnd(playlist) && dur >= 30) {
          try {
            fs.appendFileSync(playlist, "\n#EXT-X-ENDLIST\n");
          } catch {}
        }
        if (code && code !== 0 && dur < 30) {
          cur.failed = `ffmpeg exited ${code} after ${dur.toFixed(0)}s: ${stderr.trim()}`;
          console.error(`[fmp4-hls] ${cur.failed}`);
        } else {
          console.log(`[fmp4-hls] remux done ${key}: ${dur.toFixed(0)}s`);
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

export function readFmp4HlsFile(srcUrl, name) {
  const key = hashUrl(srcUrl);
  const job = jobs.get(key);
  if (job) job.lastUsed = Date.now();
  const dir = path.join(ROOT, key);
  if (!/^(index\.m3u8|seg_\d+\.ts)$/i.test(name)) return null;
  const full = path.join(dir, name);
  if (!full.startsWith(dir) || !fs.existsSync(full)) return null;
  return full;
}

/** Strip tags Tizen AVPlay often chokes on. */
export function sanitizeTizenPlaylist(text) {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^#EXT-X-PLAYLIST-TYPE:/i.test(t)) return false;
      if (/^#EXT-X-INDEPENDENT-SEGMENTS/i.test(t)) return false;
      return true;
    })
    .join("\n");
}

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
