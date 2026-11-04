// Remux Nashville/finalsignal DASH (VP9+Opus WebM) into HLS (H.264+MP2 TS)
// so Tizen / hls.js clients can play it. Encode on a 1GB droplet is often
// slightly under realtime — we measure early speed and wait for a buffer
// large enough that playback cannot outrun the remux before ENDLIST.
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { withFfmpegSlot } from "./ffmpegSlot.js";

const ROOT = process.env.DASH_HLS_CACHE || "/tmp/srctv-dashhls";
const IDLE_MS = 1000 * 60 * 90;
/** Hard cap waiting for the adaptive pre-buffer before first playlist. */
const READY_TIMEOUT_MS = 1000 * 60 * 12;
const SPEED_SAMPLE_MS = 1000 * 45;
const SAFETY = 1.3;
const MIN_BUFFER_SEC = 180;
const MAX_BUFFER_SEC = 600;

/** @type {Map<string, { child: import('child_process').ChildProcess|null, dir: string, playlist: string, ready: Promise<string>, lastUsed: number, failed?: string, expectedSec?: number, startedAt?: number }>} */
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
  if (!fs.existsSync(playlistPath)) return false;
  const dur = playlistDurationSec(playlistPath);
  if (!(expectedSec && expectedSec > 30 ? dur >= expectedSec * 0.9 : dur >= 120)) {
    return false;
  }
  // Prefer ENDLIST, but a full-length playlist without it still counts.
  return true;
}

/** ffmpeg sometimes writes ENDLIST on crash despite omit_endlist — strip it. */
function stripPrematureEndlist(playlistPath, expectedSec) {
  try {
    if (!fs.existsSync(playlistPath)) return;
    const dur = playlistDurationSec(playlistPath);
    const longEnough =
      expectedSec && expectedSec > 30 ? dur >= expectedSec * 0.9 : dur >= 120;
    if (longEnough) return;
    const text = fs.readFileSync(playlistPath, "utf8");
    if (!/#EXT-X-ENDLIST/i.test(text)) return;
    fs.writeFileSync(
      playlistPath,
      text
        .split("\n")
        .filter((l) => !/^#EXT-X-ENDLIST/i.test(l.trim()))
        .join("\n")
    );
    console.warn(
      `[dash-hls] stripped premature ENDLIST at ${dur.toFixed(0)}s` +
        (expectedSec ? `/${expectedSec.toFixed(0)}s` : "")
    );
  } catch {}
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

function clearDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
}

function buildFfmpegArgs(mpdUrl, dir, playlist) {
  // 480p@24 + MP2 mono: AAC encode was the bottleneck (~0.4x). MP2 in
  // MPEG-TS is Tizen/DVB-native and leaves CPU for VP9→H.264 (~0.9x+).
  // No PLAYLIST-TYPE:EVENT / INDEPENDENT-SEGMENTS — both break AVPlay refresh.
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
    "-threads",
    "2",
    "-crf",
    "32",
    "-vf",
    "scale=-2:480,fps=24",
    "-g",
    "48",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "mp2",
    "-ac",
    "1",
    "-ar",
    "22050",
    "-b:a",
    "64k",
    "-f",
    "hls",
    "-hls_time",
    "6",
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
 * Required head-start so playback of `expectedSec` at 1x never outruns
 * an encoder running at `speed` (content-sec per wall-sec).
 * B >= E * (1 - r) * safety, clamped.
 */
function requiredBufferSec(expectedSec, speed) {
  const r = Math.max(0.05, Math.min(speed, 2));
  if (r >= 1.05) return MIN_BUFFER_SEC;
  const episode = expectedSec && expectedSec > 60 ? expectedSec : 2700;
  const need = episode * (1 - r) * SAFETY + 45;
  return Math.max(MIN_BUFFER_SEC, Math.min(MAX_BUFFER_SEC, need));
}

function waitUntilBuffered(playlist, expectedSec, startedAt, timeoutMs, getFailed) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let target = MIN_BUFFER_SEC;
    let sampled = false;

    const tick = () => {
      try {
        const fail = getFailed?.();
        if (fail) return reject(new Error(fail));
        stripPrematureEndlist(playlist, expectedSec);
        if (isRemuxComplete(playlist, expectedSec) && playlistHasEnd(playlist)) {
          return resolve(playlist);
        }
        const dur = playlistDurationSec(playlist);
        const wall = (Date.now() - startedAt) / 1000;
        if (!sampled && wall >= SPEED_SAMPLE_MS / 1000 && dur > 5) {
          const speed = dur / wall;
          target = requiredBufferSec(expectedSec, speed);
          sampled = true;
          console.log(
            `[dash-hls] speed=${speed.toFixed(2)}x → prebuffer ${target.toFixed(0)}s` +
              (expectedSec ? ` (episode ~${expectedSec.toFixed(0)}s)` : "")
          );
        }
        const segs = fs.existsSync(path.dirname(playlist))
          ? fs.readdirSync(path.dirname(playlist)).filter((f) => /\.ts$/i.test(f)).length
          : 0;
        if (segs >= 2 && dur >= target) return resolve(playlist);
      } catch {}
      if (Date.now() > deadline) {
        const dur = playlistDurationSec(playlist);
        if (dur >= MIN_BUFFER_SEC) {
          console.warn(
            `[dash-hls] prebuffer timeout with ${dur.toFixed(0)}s (wanted ${target.toFixed(0)}s) — serving anyway`
          );
          return resolve(playlist);
        }
        return reject(new Error("dash→hls remux timed out waiting for prebuffer"));
      }
      setTimeout(tick, 800);
    };
    tick();
  });
}

/**
 * Start (or reuse) an ffmpeg remux for this MPD. Resolves once the adaptive
 * pre-buffer is on disk so Tizen cannot outrun the encoder.
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

      const startedAt = Date.now();
      job.startedAt = startedAt;

      // Encode under the global slot for the full job lifetime (so fMP4 copy
      // remuxes can't steal CPU mid-episode), but resolve ready as soon as
      // the adaptive pre-buffer is on disk so the player can start.
      const encodePromise = withFfmpegSlot(async () => {
        if (isRemuxComplete(playlist, expectedSec)) return;

        const child = spawn("ffmpeg", buildFfmpegArgs(mpdUrl, dir, playlist), {
          stdio: ["ignore", "ignore", "pipe"],
        });
        job.child = child;
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-2000);
        });

        await new Promise((resolve) => {
          child.on("exit", (code) => {
            const cur = jobs.get(key);
            if (cur) cur.child = null;
            const dur = playlistDurationSec(playlist);
            stripPrematureEndlist(playlist, cur?.expectedSec);
            const complete = isRemuxComplete(playlist, cur?.expectedSec);
            if (complete && fs.existsSync(playlist) && !playlistHasEnd(playlist)) {
              try {
                fs.appendFileSync(playlist, "\n#EXT-X-ENDLIST\n");
              } catch {}
            }
            if (!complete && dur < (cur?.expectedSec || 120) * 0.9) {
              const msg =
                `ffmpeg ended early after ${dur.toFixed(0)}s` +
                (cur?.expectedSec ? ` (expected ~${cur.expectedSec.toFixed(0)}s)` : "") +
                (code ? ` (exit ${code})` : "") +
                (stderr ? `: ${stderr.trim()}` : "");
              if (cur) cur.failed = msg;
              console.error(`[dash-hls] ${msg}`);
            } else if (complete) {
              console.log(`[dash-hls] remux complete ${key}: ${dur.toFixed(0)}s`);
            }
            resolve();
          });
        });
      });
      encodePromise.catch((err) => {
        console.error(`[dash-hls] encode slot error: ${err?.message || err}`);
      });

      await waitUntilBuffered(
        playlist,
        expectedSec,
        startedAt,
        READY_TIMEOUT_MS,
        () => job.failed
      );
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
