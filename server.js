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
import { registerSyncRoutes } from "./srctvSync.js";
import { fetchCatflixStream, fetchSuperstreamStreams } from "./utils/catflix.js";
import { Readable } from "stream";
import http from "http";
import https from "https";
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
app.use(json());
registerSyncRoutes(app);

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

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
  // Superstream's CDN (lookmovie2) doesn't check Referer; just look like a
  // browser.
  {
    test: /(^|\.)laterascent\.site$/i,
    headers: { "User-Agent": BROWSER_UA },
  },
];
const DEFAULT_UPSTREAM_HEADERS = { Referer: "https://nextgencloudfabric.com/" };

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

// Fetch an upstream URL with the right per-host headers and the shared agent.
function fetchUpstream(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...upstreamHeadersFor(url), ...(init.headers || {}) },
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

function upstreamHeadersFor(url) {
  try {
    const host = new URL(url).hostname;
    const rule = UPSTREAM_HEADER_RULES.find((r) => r.test.test(host));
    if (rule) return rule.headers;
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
    if (!res.ok) throw new Error(`streamdata API returned ${res.status}`);
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

async function getTMDBEpisodeTitle(tmdb_id, season, episode) {
  if (!TMDB_API_KEY) return null;
  try {
    const url = `https://api.themoviedb.org/3/tv/${tmdb_id}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.name || null;
  } catch {
    return null;
  }
}

const EPISODE_SEARCH_RADIUS = 8;

// Resolve the upstream episode index that actually matches the requested
// season/episode (by SxxEyy tag, else TMDB title). Falls back to the
// originally requested episode if nothing nearby matches.
async function resolveTVEpisodeIndex(tmdb_id, season, episode) {
  const vaplayerUrl = (candidate) =>
    `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdb_id}&type=tv&season=${season}&episode=${candidate}`;

  // Fetch the TMDB title and the directly-indexed file together; an SxxEyy
  // tag in the filename settles it without the title at all.
  const [tmdbTitle, direct] = await Promise.all([
    getTMDBEpisodeTitle(tmdb_id, season, episode),
    fetchVaplayerJSON(vaplayerUrl(episode)).catch(() => null),
  ]);
  if (!direct) return episode;
  const directFile = direct?.data?.file_name;
  if (!fileNameEpisodeTag(directFile) && !tmdbTitle) return episode;
  if (fileMatchesEpisode(directFile, season, episode, tmdbTitle)) return episode;

  console.warn(
    `[episode-resolve] tmdb=${tmdb_id} S${season}E${episode} got "${(directFile || "").split("/").pop()}", searching nearby indices`
  );

  // Probe the neighbours in parallel per offset (±1, then ±2, …) so a
  // drift of N costs N round-trips rather than 2N, and a slow upstream
  // can't stall /extract for longer than a few timeouts.
  for (let offset = 1; offset <= EPISODE_SEARCH_RADIUS; offset++) {
    const candidates = [episode + offset, episode - offset].filter((c) => c >= 1);
    const files = await Promise.all(
      candidates.map((c) => fetchVaplayerJSON(vaplayerUrl(c)).then((j) => j?.data?.file_name).catch(() => null))
    );
    for (let i = 0; i < candidates.length; i++) {
      if (fileMatchesEpisode(files[i], season, episode, tmdbTitle)) {
        console.warn(`[episode-resolve] corrected to E${candidates[i]}`);
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
    if (!stream) return { streams: [], transient: false };
    const streams = await probeStreamUrls([stream.url], PROBE_TIMEOUT_MS, PROBE_ATTEMPTS);
    if (!streams.length) console.warn(`[catflix] manifest unreachable: ${stream.url.slice(0, 80)}…`);
    return {
      streams: streams.map((s) => ({ ...s, source: "catflix" })),
      transient: streams.length === 0,
    };
  } catch (error) {
    console.error(`[catflix] ${error.message}`);
    return { streams: [], transient: error.status !== 404 };
  }
}

// Superstream (also via vidnest.fun's API) hands out one bare media
// playlist per quality instead of a master, so a player given a single
// one of them would have no ABR. We probe each quality's playlist head,
// keep the live ones, and publish the lot as ONE stream whose `renditions`
// /extract turns into a synthetic master via /hls-master (see below).
// Nominal RESOLUTION/BANDWIDTH per advertised quality label — measured
// segment sizes put Superstream's 1080p at ~3.5 Mbps, 720p ~2.1, 480p ~1.2.
const SUPERSTREAM_TIERS = {
  2160: { width: 3840, height: 2160, bandwidth: 12_000_000 },
  1440: { width: 2560, height: 1440, bandwidth: 7_000_000 },
  1080: { width: 1920, height: 1080, bandwidth: 4_000_000 },
  720: { width: 1280, height: 720, bandwidth: 2_200_000 },
  480: { width: 854, height: 480, bandwidth: 1_200_000 },
  360: { width: 640, height: 360, bandwidth: 800_000 },
};
async function scrapeSuperstream(type, tmdb_id, season, episode) {
  try {
    const list = await fetchSuperstreamStreams(type, tmdb_id, season, episode);
    if (!list) return { streams: [], transient: false };
    const probed = await Promise.all(
      list.map(async (s) => {
        const probe = await probePlaylist(s.url, PROBE_TIMEOUT_MS, PROBE_ATTEMPTS, { headOnly: true });
        const tier = SUPERSTREAM_TIERS[s.height] || { width: 0, height: s.height, bandwidth: 1_500_000 };
        return { ...tier, url: s.url, status: probe.status };
      })
    );
    // Require at least one playlist to have answered: if the whole CDN is
    // timing out right now, don't rank it above a source that works.
    const renditions = probed.filter((r) => r.status !== "dead");
    if (!renditions.some((r) => r.status === "ok")) {
      console.warn(`[superstream] no reachable rendition for ${type} ${tmdb_id}`);
      return { streams: [], transient: true };
    }
    const best = renditions.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return {
      streams: [
        {
          url: best.url,
          width: best.width,
          height: best.height,
          pixels: best.width * best.height,
          source: "superstream",
          renditions: renditions.map(({ url, width, height, bandwidth }) => ({ url, width, height, bandwidth })),
        },
      ],
      transient: false,
    };
  } catch (error) {
    console.error(`[superstream] ${error.message}`);
    return { streams: [], transient: error.status !== 404 };
  }
}

// Encode a rendition list into the /hls-master query param.
const encodeRenditions = (renditions) =>
  Buffer.from(JSON.stringify(renditions), "utf8").toString("base64url");
function decodeRenditions(param) {
  try {
    const list = JSON.parse(Buffer.from(String(param), "base64url").toString("utf8"));
    if (!Array.isArray(list)) return null;
    const out = list.filter(
      (r) => r && typeof r.url === "string" && /^https?:\/\//i.test(r.url)
    );
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Merge every reachable stream from all sources. Catflix is always the
// primary source when it has any working stream: its encodes are the ones
// viewers judged better, and its 1080p sits at ~2.7 Mbps where vaplayer
// advertises ~6.8 Mbps — a rate ABR often refuses through this proxy,
// leaving the player parked on 720p. Superstream is next: real ~3.5 Mbps
// 1080p where vaplayer's "1080p" is often a ~1 Mbps YTS re-encode. vaplayer
// is the last fallback: it follows in `mirrors` for every title, and becomes
// hls_url only when neither of the others has anything (no entry, dead
// manifest, relay rate-limited). Within a source, higher working tier first.
const SOURCE_PRIORITY = { catflix: 0, superstream: 1, vaplayer: 2 };

// Re-point a finished /extract response at one specific source (the
// ?source= pin). `mirrors` is left intact so the client still sees every
// option; when the pinned source has no stream for this title the response
// says so instead of silently handing back another source.
function applySourceFilter(response, source) {
  if (!source || !response.success) return response;
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
  return streamLists
    .flat()
    .map((s, index) => ({ ...s, index, tier: qualityTier(s), prio: SOURCE_PRIORITY[s.source] ?? 9 }))
    .sort((a, b) => a.prio - b.prio || b.tier - a.tier || a.index - b.index)
    .map(({ index, tier, prio, ...s }) => s);
}

// Some CDN mirrors (e.g. startupscalingsystem.website) intermittently drop
// connections on individual segment requests. Retry a couple of times
// before giving up, since one dropped connection shouldn't kill playback.
async function fetchUpstreamWithRetry(target, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const upstream = await fetchUpstream(target);
      if (upstream.ok) return upstream;
      discardBody(upstream);
      lastError = new Error(`Upstream fetch failed with status ${upstream.status}`);
    } catch (err) {
      lastError = err;
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
    for (let k = 1; k <= 3 && i + k * TS_PACKET_SIZE < buf.length; k++) {
      if (buf[i + k * TS_PACKET_SIZE] !== TS_SYNC_BYTE) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

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
// Synthetic master for sources that publish one bare media playlist per
// quality (Superstream). `r` is the base64url JSON list of
// {url, width, height, bandwidth} /extract produced; each entry becomes a
// rendition served through /hls-proxy with &variant=1 so the media playlist
// isn't wrapped again. Renditions whose playlist is known-dead right now
// are dropped, the same way /hls-proxy prunes a real master.
app.get("/hls-master", async (req, res) => {
  const renditions = decodeRenditions(req.query.r);
  if (!renditions) return res.status(400).send("Missing or invalid r param");

  try {
    const probed = await Promise.all(
      renditions.map(async (r) => ({
        ...r,
        status: (await probePlaylist(r.url, 6000, 2, { headOnly: true })).status,
      }))
    );
    let live = probed.filter((r) => r.status !== "dead");
    if (!live.length) live = probed;
    live.sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));

    const lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (const r of live) {
      const attrs = [`BANDWIDTH=${Math.round(r.bandwidth || 1_500_000)}`];
      if (r.width && r.height) attrs.push(`RESOLUTION=${r.width}x${r.height}`);
      lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`);
      lines.push(`/hls-proxy?url=${encodeURIComponent(r.url)}&variant=1`);
    }
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("[hls-master]", err.message);
    res.status(502).send("Proxy error");
  }
});

app.get("/hls-proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url param");

  try {
    const upstream = await fetchUpstreamWithRetry(target);
    const { head, iterator, done } = await peekStream(upstream.body, 4096);

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
        const selfUrl = `/hls-proxy?url=${encodeURIComponent(target)}&variant=1`;
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
      // need no flag.
      const childSuffix = isMaster ? "&variant=1" : "";
      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          const absoluteUrl = new URL(trimmed, baseUrl).toString();
          return `/hls-proxy?url=${encodeURIComponent(absoluteUrl)}${childSuffix}`;
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
    const syncOffset = findTsSyncOffset(head);
    const skip = syncOffset > 0 ? syncOffset : 0;
    const segmentHead = skip ? head.subarray(skip) : head;

    res.setHeader("Content-Type", "video/mp2t");
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
    console.error("[hls-proxy] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Proxy error");
  }
});

//Extract endpoint for m3u8 scraper
app.get("/extract", async (req, res) => {
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

  // Optional source pin: ?source=catflix|superstream|vaplayer makes hls_url
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

  // No response caching: every call re-resolves all sources so a viewer
  // always gets the live state of each CDN (what's up, what quality is
  // actually reachable right now) rather than a snapshot from minutes ago.
  try {
    // All sources are independent, so resolve them concurrently. vaplayer
    // also supplies title/imdb_id/subtitles used further down, so it always
    // runs even when another source ends up winning.
    const [result, catflix, superstream] = await Promise.all([
      (async () => {
        const resolvedEpisode =
          type === "tv" ? await resolveTVEpisodeIndex(tmdb_id, season, episode) : episode;
        return scrapeVaplayerAPI(type, tmdb_id, season, resolvedEpisode);
      })(),
      scrapeCatflix(type, tmdb_id, season, episode),
      scrapeSuperstream(type, tmdb_id, season, episode),
    ]);

    const streams = rankStreams(result.streams, catflix.streams, superstream.streams);
    const best = streams[0] || null;
    if (best) {
      console.log(
        `[extract] ${streams.length} stream(s): ` +
          streams.map((s) => `${s.source}@${qualityLabel(s) || "?"}`).join(", ")
      );
    }

    // A stream that is a set of per-quality media playlists (Superstream)
    // is served through /hls-master, which stitches them into one master so
    // the player still gets ABR; everything else goes straight to /hls-proxy.
    const origin = `${req.protocol}://${req.get("host")}`;
    const proxied = (s) =>
      s.renditions
        ? `${origin}/hls-master?r=${encodeRenditions(s.renditions)}`
        : `${origin}/hls-proxy?url=${encodeURIComponent(s.url)}`;
    const proxiedHlsUrl = best ? proxied(best) : null;
    // One entry per source that has a working stream, in priority order,
    // each pointing at that source's best stream. hls_url is always
    // mirrors[0].hls_url (unless ?source= pins another one).
    const mirrors = [];
    for (const s of streams) {
      if (mirrors.some((m) => m.source === s.source)) continue;
      mirrors.push({ hls_url: proxied(s), source: s.source, quality: qualityLabel(s) });
    }

    // Subtitles: append Wyzie ON TOP of whatever the extractor returned ("the
    // other subtitles") — Wyzie ALWAYS runs for both movies and TV (it's a
    // fast, cached, multi-language API), so it is never gated behind a fallback.
    const extractorSubs = Array.isArray(result.subtitles) ? result.subtitles : [];
    const host = `${req.protocol}://${req.get("host")}`;
    let subtitles = [...extractorSubs];

    try {
      const wcands =
        type === "movie"
          ? await findWyzieMovieSubtitleCandidates(tmdb_id)
          : type === "tv"
          ? await findWyzieTVSubtitleCandidates(tmdb_id, season, episode)
          : [];
      subtitles = subtitles.concat(
        wcands.map(({ downloadUrl, release }) => `${downloadUrl}&release=${encodeURIComponent(release)}`)
      );
    } catch (err) {
      console.error("[extract] Wyzie subtitle lookup failed:", err.message);
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
              `${host}/movie-subtitle-srt?url=${encodeURIComponent(zipUrl)}&release=${encodeURIComponent(release)}`
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
              `${host}/tv-subtitle-srt?url=${encodeURIComponent(downloadUrl)}&release=${encodeURIComponent(release)}`
          );
        } catch (err) {
          console.error("[extract] addic7ed subtitle fallback failed:", err.message);
          addic7edFailed = true;
        }
        if (subtitles.length === 0 && addic7edFailed) {
          subtitles = [
            `${host}/tv-subtitle-srt-fallback?title=${encodeURIComponent(result.title)}&season=${season}&episode=${episode}`,
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

    res.json(applySourceFilter(response, wantedSource));
  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Unexpected server error",
      hls_url: null,
      mirrors: [],
      subtitles: [],
    });
  }
});

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
app.get("/movie-subtitles", async (req, res) => {
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
 * Subtitles Endpoint (for TV Shows only)
 */
app.get("/tv-subtitles", async (req, res) => {
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
app.get("/wyzie-subtitle-srt", async (req, res) => {
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
app.get("/tv-subtitle-srt", async (req, res) => {
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
app.get("/tv-subtitle-srt-fallback", async (req, res) => {
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
app.get("/movie-subtitle-vtt", async (req, res) => {
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
app.get("/movie-subtitle-srt", async (req, res) => {
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
app.get("/subtitle-proxy", async (req, res) => {
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
app.get("/segments", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
