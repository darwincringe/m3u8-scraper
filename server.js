import "dotenv/config";
import express, { json } from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT, getTVSubtitleSRT } from "./utils/tvSubtitles.js";
import {
  findEnglishSubtitleZips,
  downloadZipSubtitleAsVTT,
  downloadZipSubtitleAsSRT,
} from "./utils/movieSubtitles.js";
import {
  findTVSubtitleCandidates,
  downloadSubtitleSRT,
} from "./utils/addic7edSubtitles.js";
import {
  findWyzieTVSubtitleCandidates,
  findWyzieMovieSubtitleCandidates,
  downloadWyzieSubtitleSRT,
} from "./utils/wyzieSubtitles.js";
import {
  searchOpenSubtitles,
  downloadOpenSubtitlesSrt,
  opensubtitlesConfigured,
} from "./utils/opensubtitles.js";
import { registerSyncRoutes, requireAuth, requirePremium } from "./srctvSync.js";
import { fetchCatflixStream, fetchFlixhqStreams, fetchOphimStreams } from "./utils/catflix.js";
import { fetchMovyStreams } from "./utils/wecollege.js";
import { Readable } from "stream";
import { readFileSync } from "fs";
import http from "http";
import https from "https";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
dotenv.config();

const app = express();
// Behind nginx: trust the first proxy so req.ip is the real client IP
// (correct per-user rate limiting) and req.protocol is https, so proxy
// URLs are built as https (no mixed-content stalls on the web player).
app.set("trust proxy", 1);
const PORT = process.env.PORT || 4000;
export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json({ limit: "64kb" }));

// Surge / cost protection: cap noisy clients before they reach scrapers.
// /hls-proxy is intentionally looser (many segment requests per viewer).
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down" },
  skip: (req) => req.path === "/hls-proxy",
});
const extractLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Extract rate limit exceeded" },
  keyGenerator: (req, res) => (req.userId ? `u:${req.userId}` : ipKeyGenerator(req, res)),
});
app.use(globalLimiter);

registerSyncRoutes(app);

// Expensive scrape/subtitle routes: Bearer + active premium (admin does not bypass).
const requirePremiumAccess = [requireAuth, requirePremium];

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// /extract response cache. Cold scrapes (Movy city race + probes) can take
// 10–20s; warm hits should be instant. Source pin (?source=) is applied on
// the way out so one entry serves every picker variant. Short TTL when a
// secondary source flaked so the next viewer retries for a better mirror.
const CACHE_TTL_MS = 1000 * 60 * 15;
const CACHE_TTL_TRANSIENT_MS = 1000 * 60 * 2;
const extractCache = new Map();
const extractInflight = new Map();
const cacheEntryExpired = (entry, now = Date.now()) =>
  now - entry.timestamp >= (entry.ttl ?? CACHE_TTL_MS);
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of extractCache) {
    if (cacheEntryExpired(entry, now)) extractCache.delete(key);
  }
}, 60 * 1000).unref();

function extractCacheKey({ type, tmdb_id, season, episode }) {
  return JSON.stringify({
    type,
    tmdb_id: String(tmdb_id),
    season: season == null || season === "" ? null : String(season),
    episode: episode == null || episode === "" ? null : String(episode),
  });
}

// Cached responses were built with whatever Host the first request used;
// rewrite absolute proxy URLs to the current request origin.
function rehostExtractResponse(response, origin) {
  const fix = (u) => {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return u;
    try {
      const parsed = new URL(u);
      if (!/\/(hls-proxy|tv-subtitle|movie-subtitle)/.test(parsed.pathname)) return u;
      return `${origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return u;
    }
  };
  return {
    ...response,
    hls_url: fix(response.hls_url),
    mirrors: (response.mirrors || []).map((m) => ({ ...m, hls_url: fix(m.hls_url) })),
    subtitles: (response.subtitles || []).map(fix),
  };
}

// Each upstream CDN wants to see the Referer of the player it was minted
// for. vaplayer.ru mirrors check for nextgencloudfabric.com; the Catflix
// chain (pwcloud.animanga.fun manifests, segments disguised as PNGs on
// tiktokcdn.com) is what vidnest's own proxy sends.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UPSTREAM_HEADER_RULES = [
  {
    test: /(^|\.)(animanga\.fun|tiktokcdn\.com|streamcasthub\.store)$/i,
    headers: {
      Referer: "https://pwcloud.animanga.fun/",
      "User-Agent": BROWSER_UA,
      Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
    },
  },
];
// Movy / wecollege CDNs hard-403 without the movy.sx Referer. Hostnames
// rotate (finalsignal, goldenkite, pulseatom, …); known hosts + path heuristic
// in upstreamHeadersFor cover the churn.
const MOVY_UPSTREAM_HEADERS = {
  Referer: "https://www.movy.sx/",
  Origin: "https://www.movy.sx",
  "User-Agent": BROWSER_UA,
  Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
};
UPSTREAM_HEADER_RULES.push({
  test: /(^|\.)(finalsignal\.top|goldenkite\.top|pulseatom\.top|wellsrobertsonkmlt\.workers\.dev)$/i,
  headers: MOVY_UPSTREAM_HEADERS,
});
// Everything else — vaplayer mirrors and the Cloudflare Workers fronting
// flixhq/ophim — gets vaplayer's Referer plus a browser User-Agent (some
// CDNs 403 node-fetch's default UA; none of ours mind a browser one).
const DEFAULT_UPSTREAM_HEADERS = {
  Referer: "https://nextgencloudfabric.com/",
  "User-Agent": BROWSER_UA,
};

// Shared keep-alive agents for every upstream request. node-fetch's default
// opens a brand-new TLS connection per request — for a proxy that fetches
// one segment every few seconds per viewer that means a handshake (and the
// per-connection TLS buffers) for each, which is most of this process's
// memory and CPU under load. Reusing connections per host amortises it.
const upstreamAgents = {
  "https:": new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30000 }),
  "http:": new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30000 }),
};
const upstreamAgent = (url) => upstreamAgents[url.protocol] || upstreamAgents["https:"];

// Fetch an upstream URL with the right per-host / per-cdn headers and the
// shared agent. `cdnHint` (e.g. "movy") wins over host heuristics.
function fetchUpstream(url, init = {}) {
  const { cdnHint, headers: extraHeaders, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: { ...upstreamHeadersFor(url, cdnHint), ...(extraHeaders || {}) },
    agent: upstreamAgent,
  });
}

// A response we're not going to read must have its body released, or the
// socket (and its buffers) stays pinned until the keep-alive timeout.
function discardBody(res) {
  try {
    res.body?.destroy();
  } catch {}
}

// Per-source CDN hints stamped on /hls-proxy URLs by /extract (`&cdn=movy`).
// Movy rotates hostnames constantly; the hint — not a host allowlist — is
// what permanently picks the right Referer for every playlist/segment hop.
const CDN_HINT_HEADERS = {
  movy: MOVY_UPSTREAM_HEADERS,
  catflix: UPSTREAM_HEADER_RULES[0].headers,
};

function upstreamHeadersFor(url, cdnHint) {
  if (cdnHint && CDN_HINT_HEADERS[cdnHint]) return CDN_HINT_HEADERS[cdnHint];
  try {
    const u = new URL(url);
    const host = u.hostname;
    const rule = UPSTREAM_HEADER_RULES.find((r) => r.test.test(host));
    if (rule) return rule.headers;
    // Fallback when an old client URL has no &cdn= stamp. Movy rotates
    // *.top hostnames and path prefixes (/vd/, /vdb/, /r6/, /fine/, …).
    if (
      /\.top$/i.test(host) &&
      (/^\/(vd|vdb|r6|fine)\b/i.test(u.pathname) || /\.(m4s|m3u8)$/i.test(u.pathname))
    ) {
      return MOVY_UPSTREAM_HEADERS;
    }
    if (/\.workers\.dev$/i.test(host) && /video\.m3u8/i.test(u.pathname)) {
      return MOVY_UPSTREAM_HEADERS;
    }
  } catch {}
  return DEFAULT_UPSTREAM_HEADERS;
}

// Fetch a playlist with a timeout; resolves to its text, or null when the
// response is missing, non-2xx, or not an M3U8.
// A definitive HTTP answer (404, 502, non-M3U8 body) is returned at once;
// timeouts and connection errors are retried, because the Catflix CDN
// (pwcloud.animanga.fun) regularly alternates sub-second responses with
// 15-20s stalls on the very same URL, and a single short attempt would
// drop a working 1080p source on a bad moment.
//
// Resolves to { status, text }:
//   ok      — playlist confirmed (text is the full body, or just its first
//             bytes when headOnly)
//   dead    — a definitive negative: non-2xx, or a body that isn't M3U8
//   unknown — every attempt timed out / failed to connect
// headOnly matters for rendition playlists: a 2h movie's 1080p playlist is
// ~1,700 segment lines that the vaplayer CDN generates on demand, and under
// load it trickles out over 15-20s. Reading just enough to see "#EXTM3U"
// (and then aborting) proves it's alive without waiting for all of it.
async function probePlaylist(url, timeoutMs, attempts = 1, { headOnly = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchUpstream(url, { signal: controller.signal });
      if (!res.ok) {
        discardBody(res);
        return { status: "dead" };
      }
      let text;
      if (headOnly) {
        const { head } = await peekStream(res.body, 16);
        text = head.toString("utf8");
        discardBody(res);
      } else {
        text = await res.text();
      }
      return text.trimStart().startsWith("#EXTM3U") ? { status: "ok", text } : { status: "dead" };
    } catch {
      // retry
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: "unknown" };
}

async function fetchPlaylistText(url, timeoutMs, attempts = 1) {
  const probe = await probePlaylist(url, timeoutMs, attempts);
  return probe.status === "ok" ? probe.text : null;
}

// Parse the renditions of a master playlist: for each #EXT-X-STREAM-INF,
// its absolute URL, the RESOLUTION (0s when absent), and the index of the
// URI line so the master can be rewritten without that entry.
function parseMasterVariants(text, baseUrl) {
  const lines = text.split("\n");
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
    if (j >= lines.length) break;
    const m = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
    const width = m ? parseInt(m[1], 10) : 0;
    const height = m ? parseInt(m[2], 10) : 0;
    let url;
    try {
      url = new URL(lines[j].trim(), baseUrl).toString();
    } catch {
      continue;
    }
    variants.push({ url, width, height, pixels: width * height, infLine: i, uriLine: j });
  }
  return variants;
}

// Masters sometimes advertise renditions whose media playlist is dead
// (Catflix has been seen listing a 1080p whose playlist 502s from every
// network while its 720p is fine). Probe each rendition's playlist head in
// parallel and record its status. Only a *definitive* failure marks a
// rendition dead; a timeout leaves it "unknown" and it is kept, since a
// slow CDN is not a broken stream and the player will simply buffer.
async function probeMasterVariants(text, baseUrl, timeoutMs, attempts = 1) {
  const variants = parseMasterVariants(text, baseUrl);
  await Promise.all(
    variants.map(async (v) => {
      const probe = await probePlaylist(v.url, timeoutMs, attempts, { headOnly: true });
      v.status = probe.status;
      v.ok = probe.status !== "dead";
    })
  );
  return variants;
}

// Highest-pixel rendition among those not known to be dead, as {width,
// height, pixels} — all 0 for a bare media playlist or one with no
// RESOLUTION tags. Ranking uses pixel count rather than height so a
// 1920x800 scope-ratio film isn't out-ranked by a 1280x720 one.
function bestWorkingResolution(variants) {
  let best = { width: 0, height: 0, pixels: 0 };
  for (const v of variants) {
    if (v.ok && v.pixels > best.pixels) best = { width: v.width, height: v.height, pixels: v.pixels };
  }
  return best;
}

// Human label for a rendition, snapped to the standard tier it belongs to
// (a 1920x800 letterboxed encode is still "1080p" to a viewer).
const QUALITY_TIERS = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720],
  [854, 480],
  [640, 360],
];
function qualityTier({ width, height }) {
  if (!width && !height) return 0;
  for (const [w, h] of QUALITY_TIERS) {
    if (width >= w * 0.95 || height >= h * 0.95) return h;
  }
  return height;
}
function qualityLabel(res) {
  const tier = qualityTier(res);
  return tier ? `${tier}p` : null;
}

// Movy city payloads label streams "2160p"/"1080p"/"Auto" even when the
// CDN hands back a bare media playlist with no RESOLUTION tags. Map those
// labels onto pixel dims so ranking / mirrors don't collapse to movy@null.
function claimedQualityDims(label) {
  const s = String(label || "").toLowerCase();
  if (!s || s === "auto") return null;
  if (/2160|4k|uhd/.test(s)) return { width: 3840, height: 2160, pixels: 3840 * 2160 };
  if (/1440|2k/.test(s)) return { width: 2560, height: 1440, pixels: 2560 * 1440 };
  if (/1080|fhd/.test(s)) return { width: 1920, height: 1080, pixels: 1920 * 1080 };
  if (/720/.test(s)) return { width: 1280, height: 720, pixels: 1280 * 720 };
  if (/480/.test(s)) return { width: 854, height: 480, pixels: 854 * 480 };
  if (/360/.test(s)) return { width: 640, height: 360, pixels: 640 * 360 };
  const m = /(\d{3,4})\s*p/.exec(s);
  if (m) {
    const height = parseInt(m[1], 10);
    const width = Math.round((height * 16) / 9);
    return { width, height, pixels: width * height };
  }
  return null;
}

// The CDN mirrors upstream sources hand out are short-lived and
// occasionally dead on arrival, so we can't trust any URL blindly — probe
// every candidate in parallel and keep every one whose manifest AND at
// least one rendition playlist actually respond, preserving input order.
// Record the best *working* rendition so /extract ranks sources by the
// quality a player can really get, not what the master claims. "Reachable"
// still only covers playlists — some mirrors misbehave at the segment level
// (bad segments, mid-stream drops), so callers get all of them and a player
// can fall back to the next mirror.
const PROBE_TIMEOUT_MS = 8000;
const PROBE_ATTEMPTS = 2;
async function probeStreamUrls(streamUrls, timeoutMs = PROBE_TIMEOUT_MS, attempts = PROBE_ATTEMPTS) {
  const results = await Promise.all(
    streamUrls.map(async (url) => {
      const text = await fetchPlaylistText(url, timeoutMs, attempts);
      if (text === null) return null;
      const variants = await probeMasterVariants(text, url, timeoutMs, attempts);
      if (variants.length && !variants.some((v) => v.ok)) return null;
      return { url, ...bestWorkingResolution(variants) };
    })
  );
  return results.filter(Boolean);
}

// vidapi.cloud subtitle URLs end in a descriptive filename like
// ".../Brazilian.por.srt". Downstream consumers key on a `release` query
// param, so derive it from that filename (sans .srt) and append it.
function appendReleaseParam(url) {
  try {
    const filename = url.split("?")[0].split("/").pop() || "";
    const release = filename.replace(/\.srt$/i, "");
    if (!release) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}release=${encodeURIComponent(release)}`;
  } catch {
    return url;
  }
}

async function fetchVaplayerJSON(apiUrl, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Referer: "https://nextgencloudfabric.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      discardBody(res);
      throw new Error(`streamdata API returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// streamdata.vaplayer.ru indexes a show's TV episodes by physical file
// position in its own library folder, not by TMDB's episode_number. Seasons
// with stray/duplicate files (common for The Office, whose double-length
// episodes sometimes exist as both one combined file and two individual
// ones) silently drift every later episode's index off of TMDB's numbering.
// The upstream API still hands back the real episode title embedded in its
// file_name though, so we cross-check that against TMDB and, on a
// mismatch, search nearby indices for the one whose file actually matches
// the requested episode.
function normalizeTitleWords(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function fileNameMatchesTitle(fileName, title) {
  if (!fileName || !title) return false;
  const fileWords = normalizeTitleWords(fileName);
  const titleWords = normalizeTitleWords(title);
  if (!titleWords) return false;
  return ` ${fileWords} `.includes(` ${titleWords} `);
}

// Season/episode tag embedded in a release filename (S01E14, s1e14,
// 1x14), as {season, episode} or null. Scene releases often carry no
// episode title at all ("flhd-supers01e14.mkv"), so this is the only
// signal we have for them — and it's a far more reliable one than title
// words when present.
function fileNameEpisodeTag(fileName) {
  if (!fileName) return null;
  // Only look at the actual file, not the enclosing season-pack folders
  // ("Supernatural.S01.PROPER.1080p…/flhd-supers01e14.mkv").
  const leaf = fileName.split("/").pop() || fileName;
  const m = /S(\d{1,2})[ ._-]?E(\d{1,3})(?!\d)/i.exec(leaf) || /(?:^|[^\d])(\d{1,2})x(\d{2,3})(?!\d)/i.exec(leaf);
  if (!m) return null;
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
}

// Does this upstream file correspond to the requested TMDB episode? An
// explicit SxxEyy tag is decisive either way; otherwise fall back to the
// TMDB title appearing in the filename.
function fileMatchesEpisode(fileName, season, episode, tmdbTitle) {
  const tag = fileNameEpisodeTag(fileName);
  if (tag) return tag.season === season && tag.episode === episode;
  return fileNameMatchesTitle(fileName, tmdbTitle);
}

async function getTMDBEpisodeMeta(tmdb_id, season, episode) {
  if (!TMDB_API_KEY) return null;
  try {
    const url = `https://api.themoviedb.org/3/tv/${tmdb_id}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return {
      name: json?.name || null,
      overview: json?.overview || null,
    };
  } catch {
    return null;
  }
}

const EPISODE_SEARCH_RADIUS = 8;
// Fraction of TMDB title/overview content-words that must appear in a
// candidate's English sub. Overview text is short, so we use coverage
// (not Jaccard vs the whole SRT). Real matches for Always Sunny S04 land
// ~0.5–0.8; wrong neighbors stay under ~0.25.
const EPISODE_TMDB_MATCH = 0.4;
const EPISODE_TMDB_BEST_EFFORT = 0.28;

function vaplayerEnglishUrl(payload) {
  const list = Array.isArray(payload?.default_subs) ? payload.default_subs : [];
  const hit = list.find((s) => /English\.eng\.srt/i.test(s?.url || ""));
  return hit?.url || null;
}

function tmdbEpisodeRefWords(meta) {
  if (!meta) return new Set();
  return subtitleCueWords(`${meta.name || ""}. ${meta.overview || ""}`);
}

function refCoverage(refWords, candWords) {
  if (!refWords.size || !candWords.size) return 0;
  let hit = 0;
  for (const w of refWords) if (candWords.has(w)) hit++;
  return hit / refWords.size;
}

// Resolve the upstream episode *index* that carries the TMDB episode's
// actual content. Ground truth is TMDB title+overview — NOT Wyzie. Wyzie
// is often itself mis-indexed (Always Sunny S04E05 Wyzie pack is actually
// E07 "Who Pooped the Bed?"), and trusting it remapped us onto the wrong
// file while Movy/vaplayer E5 were correct. The corrected index is shared
// by every source (vaplayer/flixhq/movy/…) so they stay in sync.
async function resolveTVEpisodeIndex(tmdb_id, season, episode) {
  const vaplayerUrl = (candidate) =>
    `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdb_id}&type=tv&season=${season}&episode=${candidate}`;

  const [tmdbMeta, direct] = await Promise.all([
    getTMDBEpisodeMeta(tmdb_id, season, episode),
    fetchVaplayerJSON(vaplayerUrl(episode)).catch(() => null),
  ]);
  const tmdbTitle = tmdbMeta?.name || null;
  const refWords = tmdbEpisodeRefWords(tmdbMeta);

  const contentScore = async (payload) => {
    if (refWords.size < 3 || !payload) return null;
    const url = vaplayerEnglishUrl(payload);
    if (!url) return null;
    const vapText = await fetchTextHead(url, 5000);
    if (!vapText) return null;
    return refCoverage(refWords, subtitleCueWords(vapText));
  };

  const directScore = await contentScore(direct);
  if (directScore != null) {
    if (directScore >= EPISODE_TMDB_MATCH) return episode;

    console.warn(
      `[episode-resolve] tmdb=${tmdb_id} S${season}E${episode}` +
        (tmdbTitle ? ` "${tmdbTitle}"` : "") +
        ` TMDB coverage=${directScore.toFixed(2)}; searching nearby`
    );

    let best = { ep: episode, sim: directScore };
    for (let offset = 1; offset <= EPISODE_SEARCH_RADIUS; offset++) {
      const candidates = [episode + offset, episode - offset].filter((c) => c >= 1);
      const payloads = await Promise.all(
        candidates.map((c) => fetchVaplayerJSON(vaplayerUrl(c)).catch(() => null))
      );
      const scores = await Promise.all(payloads.map(contentScore));
      for (let i = 0; i < candidates.length; i++) {
        const sim = scores[i];
        if (sim == null) continue;
        if (sim > best.sim) best = { ep: candidates[i], sim };
        if (sim >= EPISODE_TMDB_MATCH) {
          console.warn(`[episode-resolve] TMDB-matched to E${candidates[i]} (cov=${sim.toFixed(2)})`);
          return candidates[i];
        }
      }
    }
    if (best.ep !== episode && best.sim >= EPISODE_TMDB_BEST_EFFORT) {
      console.warn(`[episode-resolve] best-effort E${best.ep} (cov=${best.sim.toFixed(2)})`);
      return best.ep;
    }
    // Direct pack is weak against TMDB but nothing nearby is better — keep
    // the requested index (Movy/filename often still right; don't chase
    // Wyzie-shaped ghosts).
    return episode;
  }

  // No subtitle signal: fall back to SxxEyy / TMDB title in the filename.
  if (!direct) return episode;
  const directFile = direct?.data?.file_name;
  if (!fileNameEpisodeTag(directFile) && !tmdbTitle) return episode;
  if (fileMatchesEpisode(directFile, season, episode, tmdbTitle)) return episode;

  console.warn(
    `[episode-resolve] tmdb=${tmdb_id} S${season}E${episode} got "${(directFile || "").split("/").pop()}", searching nearby indices`
  );

  for (let offset = 1; offset <= EPISODE_SEARCH_RADIUS; offset++) {
    const candidates = [episode + offset, episode - offset].filter((c) => c >= 1);
    const files = await Promise.all(
      candidates.map((c) => fetchVaplayerJSON(vaplayerUrl(c)).then((j) => j?.data?.file_name).catch(() => null))
    );
    for (let i = 0; i < candidates.length; i++) {
      if (fileMatchesEpisode(files[i], season, episode, tmdbTitle)) {
        console.warn(`[episode-resolve] filename-matched to E${candidates[i]}`);
        return candidates[i];
      }
    }
  }

  console.warn(`[episode-resolve] no matching index found, using requested E${episode}`);
  return episode;
}

// vaplayer.ru exposes its stream data through a plain JSON API
// (streamdata.vaplayer.ru). Its embed page's own JS aborts this same
// request when it detects a CDP/debugger connection (i.e. any Playwright
// browser), so we skip the browser entirely and hit the API directly.
async function scrapeVaplayerAPI(type, tmdb_id, season, episode) {
  console.log(`\nFetching stream data for tmdb_id=${tmdb_id}`);

  const apiUrl =
    type === "tv"
      ? `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdb_id}&type=tv&season=${season}&episode=${episode}`
      : `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdb_id}&type=movie`;

  try {
    // The API itself answers in well under a second normally; give it
    // longer than the default so a busy moment doesn't lose every mirror.
    const json = await fetchVaplayerJSON(apiUrl, 12000).catch((err) => {
      throw new Error(`streamdata API: ${err.message}`);
    });
    const streamUrls = json?.data?.stream_urls;

    if (!Array.isArray(streamUrls) || streamUrls.length === 0) {
      throw new Error("No stream URLs returned");
    }

    const streams = await probeStreamUrls(streamUrls, PROBE_TIMEOUT_MS, PROBE_ATTEMPTS);
    if (streams.length === 0) {
      throw new Error("All stream mirrors are unreachable");
    }

    const subtitles = Array.isArray(json.default_subs)
      ? json.default_subs
          .map((s) => (typeof s === "string" ? s : s?.url))
          .filter(Boolean)
          .map(appendReleaseParam)
      : [];

    return {
      streams: streams.map((s) => ({ ...s, source: "vaplayer" })),
      subtitles,
      imdb_id: json?.data?.imdb_id || null,
      title: json?.data?.title || null,
      error: null,
    };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return {
      streams: [],
      subtitles: [],
      imdb_id: null,
      title: null,
      error: error.message,
    };
  }
}

// Catflix (via vidnest.fun's API) is the source hurawatch-style embeds get
// their 1080p from: vaplayer.ru often only transcodes 360p/720p renditions
// even when its file_name says 1080p. Returns probed streams (possibly
// empty) — never throws, so a flaky secondary source can't break /extract.
//
// Returns { streams, transient }: `transient` is set when Catflix *had* a URL
// for this title but we couldn't confirm it in time (its CDN stalls for
// 15-20s at random), or the API itself errored — i.e. a retry might do
// better. (Unused since /extract stopped caching responses; kept so a
// caller can still tell "no entry" from "couldn't reach it".)
async function scrapeCatflix(type, tmdb_id, season, episode) {
  try {
    const stream = await fetchCatflixStream(type, tmdb_id, season, episode);
    if (!stream) return { streams: [], subtitles: [], transient: false };
    const streams = await probeStreamUrls([stream.url], PROBE_TIMEOUT_MS, PROBE_ATTEMPTS);
    if (!streams.length) console.warn(`[catflix] manifest unreachable: ${stream.url.slice(0, 80)}…`);
    return {
      streams: streams.map((s) => ({ ...s, source: "catflix" })),
      subtitles: [],
      transient: streams.length === 0,
    };
  } catch (error) {
    const noEntry = error.status === 404 || error.status === 502;
    console.error(`[catflix] ${noEntry ? `no entry for ${type} ${tmdb_id}` : error.message}`);
    return { streams: [], subtitles: [], transient: !noEntry };
  }
}

// flixhq and ophim (also via vidnest.fun's API) each hand out ordinary
// HLS masters served through Cloudflare Workers, so they go through the
// same master-aware probe as everything else. Same contract as
// scrapeCatflix: never throws; `transient` means the source *had* a URL
// (or the API errored) but nothing could be confirmed right now.
// `fetchMasters` returns { urls, subtitles } (or a bare url list for
// older callers); source-bundled subtitle tracks are passed through so
// /extract can append them under Wyzie.
async function scrapeVidnestMasters(source, fetchMasters, type, tmdb_id, season, episode) {
  try {
    const result = await fetchMasters(type, tmdb_id, season, episode);
    if (!result) return { streams: [], subtitles: [], transient: false };
    const masters = Array.isArray(result) ? result : result.urls;
    const subtitles = Array.isArray(result) ? [] : Array.isArray(result.subtitles) ? result.subtitles : [];
    if (!masters?.length) return { streams: [], subtitles, transient: false };
    const streams = await probeStreamUrls(masters, PROBE_TIMEOUT_MS, PROBE_ATTEMPTS);
    if (!streams.length) console.warn(`[${source}] manifest unreachable for ${type} ${tmdb_id}`);
    return {
      streams: streams.map((s) => ({ ...s, source })),
      subtitles,
      transient: streams.length === 0,
    };
  } catch (error) {
    // vidnest answers 502 for "no entry" and 404 for unknown routes; both
    // are definitive, not transient.
    const noEntry = error.status === 404 || error.status === 502;
    console.error(`[${source}] ${noEntry ? `no entry for ${type} ${tmdb_id}` : error.message}`);
    return { streams: [], subtitles: [], transient: !noEntry };
  }
}
const scrapeFlixhq = (...a) => scrapeVidnestMasters("flixhq", fetchFlixhqStreams, ...a);
const scrapeOphim = (...a) => scrapeVidnestMasters("ophim", fetchOphimStreams, ...a);

// TMDB metadata Movy's extractors want (title/year/imdb/seasons). Cached
// briefly so a burst of /extract calls doesn't burn the key.
const movyMetaCache = new Map();
async function fetchMovyMeta(type, tmdb_id) {
  const key = `${type}:${tmdb_id}`;
  const hit = movyMetaCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.meta;
  if (!TMDB_API_KEY) return null;
  try {
    const path = type === "tv" ? `tv/${tmdb_id}` : `movie/${tmdb_id}`;
    const url =
      `https://api.themoviedb.org/3/${path}?api_key=${TMDB_API_KEY}` +
      `&append_to_response=external_ids`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const meta = {
      title: type === "tv" ? j.name || j.original_name : j.title || j.original_title,
      year: Number(
        String(type === "tv" ? j.first_air_date : j.release_date || "").slice(0, 4)
      ) || undefined,
      imdbId: j.external_ids?.imdb_id || j.imdb_id || undefined,
      totalSeasons: type === "tv" ? j.number_of_seasons || undefined : undefined,
    };
    if (!meta.title) return null;
    movyMetaCache.set(key, { at: Date.now(), meta });
    return meta;
  } catch {
    return null;
  }
}

async function scrapeMovy(type, tmdb_id, season, episode) {
  try {
    let meta = await fetchMovyMeta(type, tmdb_id);
    // Fall back to vaplayer's title/imdb when TMDB is down — enough for most cities.
    if (!meta?.title) return { streams: [], subtitles: [], transient: false };
    // No extract-level budget: wait for the city race. Cache on /extract
    // makes the next hit cheap.
    const result = await fetchMovyStreams(type, tmdb_id, season, episode, meta, 30000);
    // Keep 1080p + 2K/4K only (drop 720/480/360). "Auto"/unlabeled still
    // probed in case the master actually carries 1080+.
    const candidates = (result?.streams || [])
      .filter((s) => s?.url && !/\.json(\?|$)/i.test(s.url))
      .filter((s) => {
        const claimed = claimedQualityDims(s.quality);
        if (!claimed) return true;
        return qualityTier(claimed) >= 1080;
      })
      .slice(0, 12);
    if (!candidates.length) return { streams: [], subtitles: [], transient: false };

    // Probe reachability in parallel. Prefer probe-measured RESOLUTION when
    // present; otherwise keep Movy's claimed label (2160p/1080p/…) so bare
    // media playlists from goldenkite still rank and show in mirrors.
    const claimedByUrl = new Map(candidates.map((s) => [s.url, s.quality]));
    const probed = await probeStreamUrls(
      candidates.map((s) => s.url),
      8000,
      1
    );
    const streams = probed
      .map((s) => {
        if (s.width || s.height) return { ...s, source: "movy" };
        const claimed = claimedQualityDims(claimedByUrl.get(s.url));
        return claimed ? { ...s, ...claimed, source: "movy" } : { ...s, source: "movy" };
      })
      .filter((s) => qualityTier(s) >= 1080);
    if (!streams.length) console.warn(`[movy] manifest unreachable for ${type} ${tmdb_id}`);
    return {
      streams,
      subtitles: [],
      transient: streams.length === 0,
    };
  } catch (error) {
    console.error(`[movy] ${error.message}`);
    return { streams: [], subtitles: [], transient: true };
  }
}

// Merge every reachable stream from all sources, ordered by source
// priority, then by highest working tier within a source. vaplayer is the
// default: it has an entry for nearly everything and its CDN is
// dependable (~1 MB/s from the droplet), so it is the safest autoplay.
// flixhq next: widest coverage of the alternatives, highest bitrates
// (1080p ~6-8 Mbps, 2160p on some films) and 10-90 MB/s from the droplet
// via Cloudflare Workers. Catflix: good 1080p encodes, spotty coverage,
// CDN stalls at random. ophim: same speed class as flixhq, same upstream
// family, slightly less coverage. Every source with a working stream is
// exposed in `mirrors` for the picker / ?source=.
const SOURCE_PRIORITY = { vaplayer: 0, movy: 1, flixhq: 2, catflix: 3, ophim: 4 };

// Re-point a finished /extract response at one specific source (the
// ?source= pin). `mirrors` is left intact so the client still sees every
// option; when the pinned source has no stream for this title the response
// says so instead of silently handing back another source.
function applySourceFilter(response, source) {
  if (!source || !response.success) return response;
  // mirrors are quality-ranked; first match is that source's best tier.
  const pick = response.mirrors.find((m) => m.source === source);
  if (!pick) {
    return {
      ...response,
      success: false,
      hls_url: null,
      source: null,
      quality: null,
      error: `No stream from source "${source}" for this title`,
    };
  }
  return { ...response, hls_url: pick.hls_url, source: pick.source, quality: pick.quality, error: null };
}
function rankStreams(...streamLists) {
  // Highest working resolution first; source priority only breaks ties so a
  // reliable 720p source (vaplayer) no longer beats a confirmed 1080p mirror.
  return streamLists
    .flat()
    .map((s, index) => ({ ...s, index, tier: qualityTier(s), prio: SOURCE_PRIORITY[s.source] ?? 9 }))
    .sort((a, b) => b.tier - a.tier || a.prio - b.prio || a.index - b.index)
    .map(({ index, tier, prio, ...s }) => s);
}

// Pull the first maxBytes of a subtitle URL so we can compare dialogue
// without downloading a whole season pack.
async function fetchTextHead(url, maxBytes = 2500, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA, Accept: "text/plain,*/*" },
    });
    if (!res.ok) {
      discardBody(res);
      return "";
    }
    const text = await res.text();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

// Common function words shared by unrelated English dialogue — strip them
// so Jaccard isn't inflated past the mismatch threshold.
const SUB_STOPWORDS = new Set(
  `the and you your yours have has had can will for that this with are was were
   not but his her hers they them she him don did get got all one out our just
   like what when from know yes yeah hey how who why too any been being about
   into over such than then there their would could should about here well
   come going gonna right okay alright`.split(/\s+/)
);

function subtitleCueWords(srtText) {
  return new Set(
    String(srtText || "")
      .replace(/\r/g, "")
      // Drop index lines, timestamps, tags, and Wyzie's free-plan banner.
      .replace(/^\d+\s*$/gm, "")
      .replace(/\d{2}:\d{2}:\d{2}[^\n]*/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/you're on the free plan[\s\S]*?wyzie\.io/gi, "")
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length > 3 && !SUB_STOPWORDS.has(w))
  );
}

function wordSetOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// True when vaplayer's English pack clearly does not cover the TMDB
// episode's title/overview. Prefer TMDB over Wyzie — Wyzie episode packs
// are themselves sometimes shifted. No signal → false (don't demote on
// flaky network / missing overview).
async function vaplayerPackMismatchesTmdb(extractorSubs, tmdbRefWords) {
  if (!tmdbRefWords || tmdbRefWords.size < 3) return false;
  const vap = extractorSubs.find((u) => /vidapi\.cloud\/subs\/[^/]+\/English\.eng\.srt/i.test(u));
  if (!vap) return false;
  const text = await fetchTextHead(vap, 5000);
  if (!text) return false;
  const cov = refCoverage(tmdbRefWords, subtitleCueWords(text));
  // Matching Always Sunny packs cover ~0.5+ of overview words; unrelated
  // packs sit near 0–0.15.
  return cov < 0.18;
}

// Some CDN mirrors (e.g. startupscalingsystem.website) intermittently drop
// connections on individual segment requests. Retry a couple of times
// before giving up, since one dropped connection shouldn't kill playback.
//
// `signal` aborts the in-flight attempt (the client went away); each attempt
// also gives up on its own if the upstream hasn't produced headers within
// UPSTREAM_HEADERS_TIMEOUT_MS, so a stalled CDN can't pin a socket open.
const UPSTREAM_HEADERS_TIMEOUT_MS = 20000;
async function fetchUpstreamWithRetry(target, attempts = 3, signal, cdnHint) {
  let lastError;
  let triedMovyFallback = Boolean(cdnHint === "movy");
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error("client disconnected");
    const attempt = new AbortController();
    const onAbort = () => attempt.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, UPSTREAM_HEADERS_TIMEOUT_MS);
    try {
      const upstream = await fetchUpstream(target, { signal: attempt.signal, cdnHint });
      if (upstream.ok) return upstream;
      // Untagged Movy CDNs often 403 on the vaplayer Referer. One shot with
      // Movy headers recovers rotating hostnames without a deploy.
      if (upstream.status === 403 && !triedMovyFallback) {
        discardBody(upstream);
        triedMovyFallback = true;
        const retry = await fetchUpstream(target, {
          signal: attempt.signal,
          cdnHint: "movy",
        });
        if (retry.ok) return retry;
        discardBody(retry);
        lastError = new Error(`Upstream fetch failed with status ${retry.status}`);
      } else {
        discardBody(upstream);
        lastError = new Error(`Upstream fetch failed with status ${upstream.status}`);
      }
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw new Error("client disconnected");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastError;
}

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

// Offset of the first MPEG-TS packet in buf: the first byte that is a sync
// byte and is followed by sync bytes at each 188-byte stride (as many strides
// as the buffer can show). Returns -1 when no TS packet structure is found,
// e.g. for fMP4 segments, which must be passed through untouched.
function findTsSyncOffset(buf) {
  const limit = Math.min(buf.length, 64 * 1024);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== TS_SYNC_BYTE) continue;
    let ok = true;
    let checked = 0;
    for (let k = 1; k <= 3 && i + k * TS_PACKET_SIZE < buf.length; k++) {
      checked++;
      if (buf[i + k * TS_PACKET_SIZE] !== TS_SYNC_BYTE) {
        ok = false;
        break;
      }
    }
    // A lone 0x47 in the tail of the sniffed head proves nothing — any
    // binary payload has them — so demand at least one verified stride
    // unless the whole payload is shorter than a packet.
    if (ok && (checked > 0 || buf.length <= TS_PACKET_SIZE)) return i;
  }
  return -1;
}

// ISO-BMFF sniff: every MP4/fMP4 payload opens with a box header whose
// type is one of a handful of four-letter codes.
const isFmp4Head = (buf) =>
  buf.length >= 8 && /^(ftyp|styp|moof|moov|sidx|free|skip|emsg|prft)$/.test(buf.toString("latin1", 4, 8));

// Pull at least minBytes off the front of a Readable so we can sniff the
// payload before deciding how to serve it, and hand back an iterator that
// continues from where we stopped.
async function peekStream(body, minBytes) {
  const iterator = body[Symbol.asyncIterator]();
  const chunks = [];
  let length = 0;
  let done = false;
  while (length < minBytes) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  return { head: Buffer.concat(chunks), iterator, done };
}

async function* resumeStream(head, iterator, done) {
  try {
    if (head.length) yield head;
    if (done) return;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Reached on early termination too (client went away), releasing the
    // upstream socket instead of letting it drain a multi-MB segment for
    // nobody.
    await iterator.return?.();
  }
}

// Upstream CDNs mislabel what they serve (anti-hotlink obfuscation):
// vaplayer.ru's mirrors tag media segments as text/html and send a
// spec-invalid CORS header combo (Allow-Credentials: true + Allow-Origin: *)
// that browsers reject whenever a player sends credentials; the Catflix
// chain names master playlists "master.txt" and hosts each TS segment on
// tiktokcdn.com as an "image" — a real 1x1 PNG stub with the MPEG-TS bytes
// appended after IEND. hls.js happens to scan past that stub, but native
// players (iOS, ExoPlayer) do not. This proxy sniffs the payload rather than
// trusting names or Content-Type, strips the stub, and re-serves the manifest
// chain and segments from our own origin with correct headers.
//
// The upstream's lifetime is tied to the client's from the first line:
// players abort segment requests all the time (seeks, quality switches),
// often while we're still waiting on a slow CDN. If that abort isn't
// propagated, the upstream body is never read or destroyed and the whole
// segment sits in kernel socket buffers (CLOSE_WAIT) plus node's stream
// buffers — about 1-10 MB per zombie — until the process restarts. That is
// exactly how a 1 GB host ends up swapped out after a couple of days.
app.get("/hls-proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url param");
  // Set by /extract for sources whose CDNs rotate hostnames (movy). Propagated
  // onto every rewritten child URL so segments keep the right Referer.
  const cdnHint =
    typeof req.query.cdn === "string" && CDN_HINT_HEADERS[req.query.cdn]
      ? req.query.cdn
      : undefined;
  const cdnQS = cdnHint ? `&cdn=${encodeURIComponent(cdnHint)}` : "";

  const client = new AbortController();
  let upstream = null;
  res.on("close", () => {
    client.abort();
    if (upstream) discardBody(upstream);
  });

  try {
    upstream = await fetchUpstreamWithRetry(target, 3, client.signal, cdnHint);
    if (res.destroyed) {
      discardBody(upstream);
      return;
    }
    const { head, iterator, done } = await peekStream(upstream.body, 4096);
    if (res.destroyed) {
      await iterator.return?.();
      discardBody(upstream);
      return;
    }

    const isPlaylist = head.toString("utf8", 0, 16).trimStart().startsWith("#EXTM3U");

    // Playlists are small and must be buffered so their segment URLs can be
    // rewritten to point back at this proxy.
    if (isPlaylist) {
      const rest = [];
      for await (const chunk of resumeStream(Buffer.alloc(0), iterator, done)) rest.push(chunk);
      let text = Buffer.concat([head, ...rest]).toString("utf8");
      const baseUrl = new URL(target);
      const isMaster = text.includes("#EXT-X-STREAM-INF");
      const isVariant = req.query.variant === "1";

      // Drop renditions whose media playlist is dead so the player never
      // selects one it can't load (hls.js would otherwise stall/retry on it;
      // native players may fail outright). If nothing survives, serve the
      // master untouched and let the player report the failure.
      if (isMaster) {
        const variants = await probeMasterVariants(text, baseUrl, 6000, 2);
        const dead = variants.filter((v) => !v.ok);
        if (dead.length && dead.length < variants.length) {
          const drop = new Set(dead.flatMap((v) => [v.infLine, v.uriLine]));
          text = text
            .split("\n")
            .filter((_, i) => !drop.has(i))
            .join("\n");
          console.warn(
            `[hls-proxy] dropped ${dead.length} dead rendition(s): ${dead
              .map((v) => `${v.width}x${v.height}`)
              .join(", ")}`
          );
        }
      }

      // Most titles hand back a master playlist (multi-quality, with
      // #EXT-X-STREAM-INF), but some — e.g. brand-new single-quality
      // releases — return a bare *media* playlist directly. Several players
      // only initialise their pipeline from a master and just show a black
      // screen (no error) for a raw media playlist. So when we get a bare
      // media playlist at the top level (no &variant flag yet), wrap it in a
      // minimal synthetic master pointing back at itself with &variant=1, so
      // every stream we serve has the same master -> media -> segment shape.
      if (!isMaster && !isVariant) {
        const selfUrl = `/hls-proxy?url=${encodeURIComponent(target)}&variant=1${cdnQS}`;
        const master = [
          "#EXTM3U",
          "#EXT-X-INDEPENDENT-SEGMENTS",
          "#EXT-X-STREAM-INF:BANDWIDTH=3000000",
          selfUrl,
        ].join("\n");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.send(master);
      }

      // Rewrite child URLs back through this proxy. Variant playlists inside
      // a master keep the &variant flag so the follow-up request is served
      // as media (and not wrapped again); segment URLs in a media playlist
      // need no flag. `&cdn=` rides along so Movy (etc.) keep their Referer
      // even when the playlist rewrites onto a brand-new CDN hostname.
      // fMP4 streams (flixhq/ophim) also reference an init segment via
      // #EXT-X-MAP:URI="..." — and AES streams a key via #EXT-X-KEY — which
      // must come through here too, or browsers hit a worker with no CORS.
      const childSuffix = isMaster ? `&variant=1${cdnQS}` : cdnQS;
      const proxyUrl = (ref, suffix = "") =>
        `/hls-proxy?url=${encodeURIComponent(new URL(ref, baseUrl).toString())}${suffix}`;
      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (/^#EXT-X-(MAP|KEY|MEDIA):/i.test(trimmed)) {
            return line.replace(
              /URI="([^"]+)"/i,
              (_, ref) => `URI="${proxyUrl(ref, isMaster ? `&variant=1${cdnQS}` : cdnQS)}"`
            );
          }
          if (trimmed.startsWith("#")) return line;
          return proxyUrl(trimmed, childSuffix);
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // Media segment: force the correct MIME type regardless of what the
    // upstream CDN claims, drop any wrapper bytes ahead of the first TS
    // packet, and STREAM the rest straight through. Buffering whole segments
    // (some 6MB+ on slow mirrors) delayed the first byte to the player by
    // several seconds, tripping native-player segment timeouts and showing a
    // black screen for titles served by slower mirrors.
    //
    // fMP4 (flixhq/ophim: ISO-BMFF init segment + styp/moof fragments,
    // often named *.jpg) is passed through byte-for-byte — never trimmed,
    // since a stray 0x47 inside a fragment is not a TS packet — and must
    // not be labelled as MPEG-TS or ExoPlayer/Safari pick the wrong demuxer.
    const isFmp4 = isFmp4Head(head);
    const syncOffset = isFmp4 ? -1 : findTsSyncOffset(head);
    const skip = syncOffset > 0 ? syncOffset : 0;
    const segmentHead = skip ? head.subarray(skip) : head;

    res.setHeader("Content-Type", isFmp4 ? "video/mp4" : "video/mp2t");
    const contentLength = parseInt(upstream.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength >= skip) {
      res.setHeader("Content-Length", String(contentLength - skip));
    }

    // Byte mode with a small high-water mark: Readable.from defaults to
    // object mode, where the mark counts chunks (16 × ~64KB ≈ 1MB buffered
    // per stream). A few hundred viewers on slow connections would each pin
    // that much, which is enough to swap out a 1GB host. 16KB matches what a
    // plain pipe() from the upstream socket would hold.
    const body = Readable.from(resumeStream(segmentHead, iterator, done), {
      objectMode: false,
      highWaterMark: 16 * 1024,
    });
    body.on("error", (err) => {
      console.error("[hls-proxy] Segment stream error:", err.message);
      res.destroy(err);
    });
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch (err) {
    if (res.destroyed) return; // client left; nothing to report or send
    console.error("[hls-proxy] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Proxy error");
  }
});

//Extract endpoint for m3u8 scraper
app.get("/extract", ...requirePremiumAccess, extractLimiter, async (req, res) => {
  const type = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season = req.query.season ? parseInt(req.query.season) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode) : undefined;

  if (!tmdb_id) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id query param is required",
      hls_url: null,
      mirrors: [],
      subtitles: [],
    });
  }

  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({
      success: false,
      error: "season and episode query params are required for TV shows",
      hls_url: null,
      mirrors: [],
      subtitles: [],
    });
  }

  // Optional source pin: ?source=vaplayer|flixhq|catflix|ophim makes hls_url
  // come from that source instead of the best-ranked one. `mirrors` always
  // lists every source that has a stream, so a UI can offer a picker.
  const wantedSource = req.query.source;
  if (wantedSource !== undefined && !(wantedSource in SOURCE_PRIORITY)) {
    return res.status(400).json({
      success: false,
      error: `Unknown source "${wantedSource}"; expected one of ${Object.keys(SOURCE_PRIORITY).join(", ")}`,
      hls_url: null,
      mirrors: [],
      subtitles: [],
    });
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const cacheKey = extractCacheKey({ type, tmdb_id, season, episode });
  const cached = extractCache.get(cacheKey);
  if (cached && !cacheEntryExpired(cached)) {
    console.log(`[extract] cache hit ${cacheKey}`);
    return res.json(
      applySourceFilter(rehostExtractResponse(cached.response, origin), wantedSource)
    );
  }

  // Coalesce concurrent cold lookups for the same title so Movy's city race
  // only runs once when several viewers hit play together.
  let inflight = extractInflight.get(cacheKey);
  if (!inflight) {
    inflight = (async () => {
      try {
        return await buildExtractResponse({
          type,
          tmdb_id,
          season,
          episode,
          origin,
        });
      } finally {
        extractInflight.delete(cacheKey);
      }
    })();
    extractInflight.set(cacheKey, inflight);
  } else {
    console.log(`[extract] joining inflight ${cacheKey}`);
  }

  try {
    const { response, transient } = await inflight;
    if (response.success) {
      extractCache.set(cacheKey, {
        timestamp: Date.now(),
        ttl: transient ? CACHE_TTL_TRANSIENT_MS : CACHE_TTL_MS,
        response,
      });
    }
    res.json(applySourceFilter(rehostExtractResponse(response, origin), wantedSource));
  } catch (err) {
    console.error("[extract] Unexpected error:", err.message);
    res.status(500).json({
      success: false,
      error: "Unexpected server error",
      hls_url: null,
      mirrors: [],
      subtitles: [],
    });
  }
});

async function buildExtractResponse({ type, tmdb_id, season, episode, origin }) {
  try {
    // Wyzie is independent of everything below, so start it now and collect
    // it after the sources instead of paying its ~0.8s on top of them.
    const wyziePromise = (
      type === "movie"
        ? findWyzieMovieSubtitleCandidates(tmdb_id)
        : type === "tv"
        ? findWyzieTVSubtitleCandidates(tmdb_id, season, episode)
        : Promise.resolve([])
    ).catch((err) => {
      console.error("[extract] Wyzie subtitle lookup failed:", err.message);
      return [];
    });

    // No per-source budget: wait for every scraper. /extract response cache
    // + inflight coalesce keep repeat plays fast. Movy / flixhq / ophim /
    // catflix key by TMDB S/E (not vaplayer's remapped index), so start them
    // with the original episode while episode-resolve runs for vaplayer.
    const movyPromise = scrapeMovy(type, tmdb_id, season, episode);
    const flixhqPromise = scrapeFlixhq(type, tmdb_id, season, episode);
    const ophimPromise = scrapeOphim(type, tmdb_id, season, episode);
    const catflixPromise = scrapeCatflix(type, tmdb_id, season, episode);

    const tmdbMetaPromise =
      type === "tv" ? getTMDBEpisodeMeta(tmdb_id, season, episode).catch(() => null) : Promise.resolve(null);
    const resolvedEpisode =
      type === "tv" ? await resolveTVEpisodeIndex(tmdb_id, season, episode) : episode;

    const [result, catflix, flixhq, ophim, movy, tmdbMeta] = await Promise.all([
      scrapeVaplayerAPI(type, tmdb_id, season, resolvedEpisode),
      catflixPromise,
      flixhqPromise,
      ophimPromise,
      movyPromise,
      tmdbMetaPromise,
    ]);

    // Subtitles first (needed before ranking): Wyzie first for languages;
    // vaplayer pack is demoted when its English dialogue doesn't cover the
    // TMDB episode synopsis (wrong file / wrong show). Source tracks stay
    // appended under Wyzie so extra languages remain selectable.
    const extractorSubs = Array.isArray(result.subtitles) ? result.subtitles : [];
    const flixhqSubs = Array.isArray(flixhq.subtitles) ? flixhq.subtitles : [];
    const sourceSubs = [...extractorSubs, ...flixhqSubs];
    const wcands = await wyziePromise;
    const wyzieSubs = wcands.map(
      ({ downloadUrl, release }) => `${downloadUrl}&release=${encodeURIComponent(release)}`
    );
    const tmdbRefWords = tmdbEpisodeRefWords(tmdbMeta);
    const vapUntrusted = await vaplayerPackMismatchesTmdb(extractorSubs, tmdbRefWords);
    if (vapUntrusted) {
      console.warn(
        `[extract] vaplayer subtitle pack mismatches TMDB for ${type} ${tmdb_id}` +
          (type === "tv" ? ` S${season}E${episode}` : "") +
          "; demoting vaplayer"
      );
    }

    // Wyzie first (episode-accurate); source-bundled tracks always at the
    // bottom (deduped). Wrong English packs stay selectable but last.
    const seenSub = new Set(wyzieSubs);
    const appendedSourceSubs = sourceSubs.filter((u) => {
      if (seenSub.has(u)) return false;
      seenSub.add(u);
      return true;
    });
    let subtitles = [...wyzieSubs, ...appendedSourceSubs];

    const vapStreams = vapUntrusted ? [] : result.streams;
    const demotedVap = vapUntrusted ? result.streams : [];
    const streams = [
      ...rankStreams(vapStreams, movy.streams, catflix.streams, flixhq.streams, ophim.streams),
      ...demotedVap.map((s) => ({ ...s, source: "vaplayer" })),
    ];
    // Deduplicate URLs if demotion somehow double-counted (shouldn't).
    const seenUrls = new Set();
    const uniqueStreams = streams.filter((s) => {
      if (seenUrls.has(s.url)) return false;
      seenUrls.add(s.url);
      return true;
    });
    const best = uniqueStreams[0] || null;
    if (best) {
      console.log(
        `[extract] ${uniqueStreams.length} stream(s): ` +
          uniqueStreams.map((s) => `${s.source}@${qualityLabel(s) || "?"}`).join(", ") +
          (vapUntrusted ? " (vaplayer demoted)" : "")
      );
    }

    // Stamp &cdn= so /hls-proxy doesn't depend on hostname allowlists for
    // sources that rotate CDNs (Movy). Child playlist rewrites preserve it.
    const proxied = (s) => {
      const cdn =
        s.source === "movy" ? "&cdn=movy" : s.source === "catflix" ? "&cdn=catflix" : "";
      return `${origin}/hls-proxy?url=${encodeURIComponent(s.url)}${cdn}`;
    };
    const proxiedHlsUrl = best ? proxied(best) : null;
    // One entry per source+quality. Movy only keeps 1080p/2160p; other
    // sources usually expose a single master. hls_url is mirrors[0] unless
    // ?source= pins another source.
    const mirrors = [];
    for (const s of uniqueStreams) {
      const quality = qualityLabel(s);
      if (mirrors.some((m) => m.source === s.source && m.quality === quality)) continue;
      mirrors.push({ hls_url: proxied(s), source: s.source, quality });
    }

    // The heavy scrapers (YIFY zip-validation for movies, addic7ed for TV) take
    // ~10s, so they stay a FALLBACK — only run when we STILL have nothing —
    // otherwise every playback start that already has Wyzie/extractor subtitles
    // would eat that delay.
    if (subtitles.length === 0) {
      if (type === "movie" && result.imdb_id) {
        try {
          const candidates = await findEnglishSubtitleZips(result.imdb_id, 10);
          subtitles = candidates.map(
            ({ zipUrl, release }) =>
              `${origin}/movie-subtitle-srt?url=${encodeURIComponent(zipUrl)}&release=${encodeURIComponent(release)}`
          );
        } catch (err) {
          console.error("[extract] YIFY subtitle fallback failed:", err.message);
        }
      } else if (type === "tv" && result.title) {
        let addic7edFailed = false;
        try {
          const candidates = await findTVSubtitleCandidates(result.title, season, episode, 10);
          subtitles = candidates.map(
            ({ downloadUrl, release }) =>
              `${origin}/tv-subtitle-srt?url=${encodeURIComponent(downloadUrl)}&release=${encodeURIComponent(release)}`
          );
        } catch (err) {
          console.error("[extract] addic7ed subtitle fallback failed:", err.message);
          addic7edFailed = true;
        }
        if (subtitles.length === 0 && addic7edFailed) {
          subtitles = [
            `${origin}/tv-subtitle-srt-fallback?title=${encodeURIComponent(result.title)}&season=${season}&episode=${episode}`,
          ];
        }
      }
    }

    const response = {
      success: !!best,
      hls_url: proxiedHlsUrl,
      mirrors,
      source: best ? best.source : null,
      quality: best ? qualityLabel(best) : null,
      subtitles,
      error: best ? null : result.error || "No stream found",
    };
    const transient = !!(
      catflix.transient ||
      flixhq.transient ||
      ophim.transient ||
      movy.transient
    );
    return { response, transient };
  } catch (err) {
    console.error("[extract] build failed:", err.message);
    throw err;
  }
}

/**
 * 🎯 TMDB -> IMDb (for movies only)
 */
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Failed to fetch IMDb ID from TMDB");
  const json = await response.json();
  return json.imdb_id || null;
}

/**
 * 🧠 Unified Subtitle Search (for movies only)
 */
async function searchSubtitles(imdb_id) {
  // Movie: Only fetch page 1 from OpenSubtitles
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`,
    {
      headers: {
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": "Cinemi v1.0.0",
      },
    }
  );

  if (!res.ok) {
    console.error("[OpenSubtitles] Request failed");
    return [];
  }

  const json = await res.json();
  const seen = new Set();
  if (json.data.length === 0) {
    return [];
  }

  return (json.data || [])
    .filter(
      (item) =>
        item.attributes?.files?.[0]?.file_id &&
        COMMON_LANGUAGES.includes(item.attributes.language)
    )
    .map((item) => {
      const file = item.attributes.files[0];
      const lang = item.attributes.language;
      return {
        language: lang,
        language_name: LANGUAGE_NAMES[lang] || lang,
        file_id: file.file_id,
        download_count: item.attributes.download_count || 0,
      };
    })
    .sort((a, b) => b.download_count - a.download_count)
    .slice(0, 2);
}

/**
 * 🧠 Get Download URL from OpenSubtitles (for Movies only)
 */
async function getSubtitleDownloadUrl(file_id) {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": OPENSUB_API_KEY,
      "User-Agent": "Cinemi v1.0.0",
    },
    body: JSON.stringify({ file_id }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[OpenSubtitles] Failed to get download link:", text);
    throw new Error("Subtitle download URL fetch failed");
  }

  const json = await res.json();
  return json.link;
}

/**
 * 🔥 Subtitles Endpoint (for movies only)
 */
app.get("/movie-subtitles", ...requirePremiumAccess, async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;

  if (!tmdb_id) {
    return res
      .status(400)
      .json({ success: false, error: "tmdb_id is required" });
  }

  try {
    const imdb_id = await getIMDbIdFromTMDB(tmdb_id, type);
    if (!imdb_id) {
      return res
        .status(404)
        .json({ success: false, error: "IMDb ID not found" });
    }

    const baseList = await searchSubtitles(imdb_id);

    const subtitles = await Promise.all(
      baseList.map(async (sub) => {
        if (sub.url) return sub;
        try {
          const url = await getSubtitleDownloadUrl(sub.file_id);
          return {
            language: sub.language,
            language_name: sub.language_name,
            url,
          };
        } catch {
          return null;
        }
      })
    );

    res.json({
      success: true,
      subtitles: subtitles.filter(Boolean),
      meta: {
        tmdb_id,
        imdb_id,
        type,
      },
    });
  } catch (err) {
    console.error("[/subtitles] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * User-driven OpenSubtitles search (official REST API).
 * Same idea as bipuldey19/Opensubtitles-Unofficial-API (free-text + S/E
 * filters), but via api.opensubtitles.com — HTML scraping is blocked from
 * our droplet. Requires OPENSUB_API_KEY.
 *
 *   GET /opensubtitles/search?q=The+Last+of+Us&season=1&episode=1&lang=en
 *   GET /opensubtitles/search?tmdb_id=100088&type=tv&season=1&episode=1
 *   GET /opensubtitles/search?parent_tmdb_id=100088&season=1&episode=1&lang=en
 *
 * Each result includes `srt_url` pointing at /opensubtitles/srt?file_id=…
 * so the player can load the pick without hitting OpenSubtitles directly.
 */
app.get("/opensubtitles/search", ...requirePremiumAccess, async (req, res) => {
  if (!opensubtitlesConfigured()) {
    return res.status(503).json({
      success: false,
      error:
        "OPENSUB_API_KEY is not configured. Create a free key at https://www.opensubtitles.com/en/consumers and set it in .env",
    });
  }

  const q = req.query.q || req.query.query;
  const lang = req.query.lang || req.query.languages || "en";
  const type = req.query.type;
  const season = req.query.season ?? req.query.s;
  const episode = req.query.episode ?? req.query.e;
  const tmdb_id = req.query.tmdb_id;
  const parent_tmdb_id = req.query.parent_tmdb_id;
  const imdb_id = req.query.imdb_id;
  const parent_imdb_id = req.query.parent_imdb_id;
  const year = req.query.year;
  const page = req.query.page || 1;
  const limit = req.query.limit || 40;

  try {
    // Convenience: for TV, tmdb_id without parent_ means the show id.
    let parentTmdb = parent_tmdb_id;
    let featureTmdb = tmdb_id;
    const isTv =
      mediaLooksLikeTv(type) || (season != null && season !== "") || (episode != null && episode !== "");
    if (isTv && tmdb_id && !parent_tmdb_id) {
      parentTmdb = tmdb_id;
      featureTmdb = undefined;
    }

    const data = await searchOpenSubtitles({
      query: q,
      languages: lang,
      type: isTv ? "episode" : type || "movie",
      season,
      episode,
      tmdb_id: featureTmdb,
      parent_tmdb_id: parentTmdb,
      imdb_id,
      parent_imdb_id,
      year,
      page,
      limit,
    });

    const origin = `${req.protocol}://${req.get("host")}`;
    const results = data.results.map((r) => ({
      ...r,
      srt_url: `${origin}/opensubtitles/srt?file_id=${encodeURIComponent(r.file_id)}`,
    }));

    res.json({
      success: true,
      results,
      total: data.total,
      page: data.page,
      total_pages: data.total_pages,
    });
  } catch (err) {
    console.error("[opensubtitles/search]", err.message);
    res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({
      success: false,
      error: err.message,
    });
  }
});

function mediaLooksLikeTv(type) {
  const t = String(type || "").toLowerCase();
  return t === "tv" || t === "series" || t === "episode" || t === "show";
}

/**
 * Proxy an OpenSubtitles file_id to decoded SRT text (CORS-safe for players).
 */
app.get("/opensubtitles/srt", ...requirePremiumAccess, async (req, res) => {
  const file_id = req.query.file_id;
  if (!file_id) return res.status(400).send("Missing file_id");
  if (!opensubtitlesConfigured()) {
    return res.status(503).send("OPENSUB_API_KEY is not configured");
  }

  try {
    const srt = await downloadOpenSubtitlesSrt(file_id);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(srt);
  } catch (err) {
    console.error("[opensubtitles/srt]", err.message);
    res.status(err.status && Number.isInteger(err.status) ? err.status : 500).send(err.message);
  }
});

/**
 * Subtitles Endpoint (for TV Shows only)
 */
app.get("/tv-subtitles", ...requirePremiumAccess, async (req, res) => {
  const { title, season, episode, type } = req.query;

  try {
    if (type === "tv") {
      const vtt = await getTVSubtitleVTT(title, season, episode);
      if (!vtt) return res.status(404).send("No subtitle found");
      return res.set("Content-Type", "text/vtt").send(vtt);
    }

    res.status(400).send("Invalid type provided");
  } catch (err) {
    console.error("❌ Subtitle API Error:", err.message);
    res.status(500).send("Internal server error");
  }
});

/**
 * Wyzie subtitle download URL -> raw .srt proxy (TV). The resolved URLs point
 * at opensubtitles.org, which we can't expose to the browser directly (no
 * CORS, Cloudflare), so we proxy + decode server-side. Downloads are cached
 * by URL in the Wyzie module.
 */
app.get("/wyzie-subtitle-srt", ...requirePremiumAccess, async (req, res) => {
  const downloadUrl = req.query.url;
  if (!downloadUrl) return res.status(400).send("Missing url param");

  try {
    const srt = await downloadWyzieSubtitleSRT(downloadUrl);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(srt);
  } catch (err) {
    console.error("[wyzie-subtitle-srt] Error:", err.message);
    res.status(500).send("Failed to fetch subtitle");
  }
});

/**
 * addic7ed subtitle download URL -> raw .srt proxy (TV, no API key needed)
 */
app.get("/tv-subtitle-srt", ...requirePremiumAccess, async (req, res) => {
  const downloadUrl = req.query.url;
  if (!downloadUrl) return res.status(400).send("Missing url param");

  try {
    const srt = await downloadSubtitleSRT(downloadUrl);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(srt);
  } catch (err) {
    console.error("[tv-subtitle-srt] Error:", err.message);
    res.status(500).send("Failed to fetch subtitle");
  }
});

/**
 * tvsubtitles.net fallback (used when addic7ed fails) — lazy, since the
 * full lookup chain takes 30-90s and would stall /extract if run inline.
 */
app.get("/tv-subtitle-srt-fallback", ...requirePremiumAccess, async (req, res) => {
  const { title, season, episode } = req.query;
  if (!title || !season || !episode) {
    return res.status(400).send("Missing title, season, or episode param");
  }

  try {
    const srt = await getTVSubtitleSRT(title, season, episode);
    if (!srt) return res.status(404).send("No subtitle found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(srt);
  } catch (err) {
    console.error("[tv-subtitle-srt-fallback] Error:", err.message);
    res.status(500).send("Failed to fetch subtitle");
  }
});

/**
 * YIFY/YTS subtitle zip -> VTT proxy (movies only, no API key needed)
 */
app.get("/movie-subtitle-vtt", ...requirePremiumAccess, async (req, res) => {
  const zipUrl = req.query.url;
  if (!zipUrl) return res.status(400).send("Missing url param");

  try {
    const vtt = await downloadZipSubtitleAsVTT(zipUrl);
    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    console.error("[movie-subtitle-vtt] Error:", err.message);
    res.status(500).send("Failed to fetch subtitle");
  }
});

/**
 * YIFY/YTS subtitle zip -> raw SRT proxy (movies only, no API key needed)
 */
app.get("/movie-subtitle-srt", ...requirePremiumAccess, async (req, res) => {
  const zipUrl = req.query.url;
  if (!zipUrl) return res.status(400).send("Missing url param");

  try {
    const srt = await downloadZipSubtitleAsSRT(zipUrl);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(srt);
  } catch (err) {
    console.error("[movie-subtitle-srt] Error:", err.message);
    res.status(500).send("Failed to fetch subtitle");
  }
});

/**
 * 📦 Subtitle Proxy to Convert .srt → .vtt (for movies only)
 */
app.get("/subtitle-proxy", ...requirePremiumAccess, async (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) return res.status(400).send("Missing subtitle URL");

  try {
    const subtitleRes = await fetch(fileUrl);
    const srt = await subtitleRes.text();

    const vtt =
      "WEBVTT\n\n" +
      srt
        .replace(/\r+/g, "")
        .replace(/^\s+|\s+$/g, "")
        .split("\n")
        .map((line) =>
          line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4")
        )
        .join("\n");

    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    console.error("Subtitle Proxy Error:", err.message);
    res.status(500).send("Failed to convert subtitle");
  }
});

app.get("/", (req, res) => {
  res.redirect("/login");
});

// Proxy for introdb.app skip-segments (recap/intro/outro). introdb only sends
// CORS for its own origin, so the web app can't call it directly — it calls
// this instead (our open CORS). Native still hits introdb directly.
app.get("/segments", ...requirePremiumAccess, async (req, res) => {
  const { imdb_id, season, episode } = req.query;
  if (!imdb_id) return res.status(400).json({ error: "imdb_id required" });
  try {
    const u = new URL("https://api.introdb.app/segments");
    u.searchParams.set("imdb_id", imdb_id);
    if (season != null) u.searchParams.set("season", String(season));
    if (episode != null) u.searchParams.set("episode", String(episode));
    const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
    const body = await r.text();
    res.status(r.status).type("application/json").send(body);
  } catch (e) {
    console.error("[segments] introdb proxy failed:", e.message);
    res.status(502).json({ error: "introdb fetch failed" });
  }
});

// Memory watchdog. PM2's --max-memory-restart compares RSS only, and once
// the host starts swapping, RSS *shrinks* (pages move to swap) while the
// process keeps growing — so the restart never fires and the box ends up
// thrashing with 10 MB free. Count RSS + swap from /proc instead and exit
// (PM2 restarts us) once we're over the line. Also report open upstream
// sockets so a leak is visible in the logs before it hurts.
const MEM_LIMIT_MB = parseInt(process.env.MEM_LIMIT_MB || "450", 10);
function processMemoryMB() {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const kb = (key) => parseInt(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] || "0", 10);
    const rss = kb("VmRSS");
    const swap = kb("VmSwap");
    return { rss: rss / 1024, swap: swap / 1024, total: (rss + swap) / 1024 };
  } catch {
    const rss = process.memoryUsage().rss / 1024 / 1024;
    return { rss, swap: 0, total: rss };
  }
}
function upstreamSocketCount() {
  let n = 0;
  for (const agent of Object.values(upstreamAgents)) {
    for (const list of Object.values(agent.sockets)) n += list.length;
    for (const list of Object.values(agent.freeSockets)) n += list.length;
  }
  return n;
}
setInterval(() => {
  const mem = processMemoryMB();
  if (mem.total > MEM_LIMIT_MB) {
    console.error(
      `[watchdog] memory ${mem.total.toFixed(0)} MB (rss ${mem.rss.toFixed(0)} + swap ${mem.swap.toFixed(0)}) ` +
        `exceeds ${MEM_LIMIT_MB} MB with ${upstreamSocketCount()} upstream sockets; exiting for restart`
    );
    process.exit(1);
  }
}, 30 * 1000).unref();
setInterval(() => {
  const mem = processMemoryMB();
  console.log(
    `[watchdog] mem ${mem.total.toFixed(0)} MB (rss ${mem.rss.toFixed(0)}, swap ${mem.swap.toFixed(0)}), ` +
      `upstream sockets ${upstreamSocketCount()}`
  );
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
