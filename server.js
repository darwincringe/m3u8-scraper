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
import { fetchCatflixStream } from "./utils/catflix.js";
import { Readable } from "stream";
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

// Simple in-memory cache to avoid re-fetching same query repeatedly (15 minutes)
const cache = new Map();

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
const DEFAULT_UPSTREAM_HEADERS = { Referer: "https://nextgencloudfabric.com/" };

function upstreamHeadersFor(url) {
  try {
    const host = new URL(url).hostname;
    const rule = UPSTREAM_HEADER_RULES.find((r) => r.test.test(host));
    if (rule) return rule.headers;
  } catch {}
  return DEFAULT_UPSTREAM_HEADERS;
}

// Largest RESOLUTION advertised by a master playlist, as {width, height,
// pixels} — all 0 when the text is a bare media playlist or advertises no
// resolutions. Ranking uses pixel count rather than height so a 1920x800
// scope-ratio film isn't out-ranked by a 1280x720 one.
function bestResolutionInMaster(text) {
  let best = { width: 0, height: 0, pixels: 0 };
  for (const m of text.matchAll(/RESOLUTION=(\d+)x(\d+)/gi)) {
    const width = parseInt(m[1], 10);
    const height = parseInt(m[2], 10);
    if (width * height > best.pixels) best = { width, height, pixels: width * height };
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
function qualityLabel({ width, height }) {
  if (!width && !height) return null;
  for (const [w, h] of QUALITY_TIERS) {
    if (width >= w * 0.95 || height >= h * 0.95) return `${h}p`;
  }
  return `${height}p`;
}

// The CDN mirrors upstream sources hand out are short-lived and
// occasionally dead on arrival, so we can't trust any URL blindly — probe
// every candidate in parallel and keep every one whose manifest actually
// responds, preserving input order. While the manifest is in hand, record
// the best rendition it advertises so /extract can rank sources by quality.
// "Reachable" here only means the manifest responded — some mirrors still
// misbehave downstream (bad segments, mid-stream drops), so callers get all
// of them and a player can fall back to the next mirror.
async function probeStreamUrls(streamUrls, timeoutMs = 5000) {
  const results = await Promise.all(
    streamUrls.map(async (url) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: upstreamHeadersFor(url),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trimStart().startsWith("#EXTM3U")) return null;
        return { url, ...bestResolutionInMaster(text) };
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
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

async function fetchVaplayerJSON(apiUrl) {
  const res = await fetch(apiUrl, {
    headers: {
      Referer: "https://nextgencloudfabric.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`streamdata API returned ${res.status}`);
  return res.json();
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

// Resolve the upstream episode index that actually matches TMDB's episode
// title for the requested season/episode. Falls back to the originally
// requested episode if TMDB is unavailable or no matching index is found
// nearby.
async function resolveTVEpisodeIndex(tmdb_id, season, episode) {
  const tmdbTitle = await getTMDBEpisodeTitle(tmdb_id, season, episode);
  if (!tmdbTitle) return episode;

  const vaplayerUrl = (candidate) =>
    `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdb_id}&type=tv&season=${season}&episode=${candidate}`;

  try {
    const json = await fetchVaplayerJSON(vaplayerUrl(episode));
    if (fileNameMatchesTitle(json?.data?.file_name, tmdbTitle)) return episode;
  } catch {
    return episode;
  }

  console.warn(
    `[episode-resolve] tmdb=${tmdb_id} S${season}E${episode} title mismatch, searching nearby indices for "${tmdbTitle}"`
  );

  for (let offset = 1; offset <= EPISODE_SEARCH_RADIUS; offset++) {
    for (const candidate of [episode + offset, episode - offset]) {
      if (candidate < 1) continue;
      try {
        const json = await fetchVaplayerJSON(vaplayerUrl(candidate));
        if (fileNameMatchesTitle(json?.data?.file_name, tmdbTitle)) {
          console.warn(`[episode-resolve] corrected to E${candidate}`);
          return candidate;
        }
      } catch {
        // ignore and keep searching
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
    const json = await fetchVaplayerJSON(apiUrl);
    const streamUrls = json?.data?.stream_urls;

    if (!Array.isArray(streamUrls) || streamUrls.length === 0) {
      throw new Error("No stream URLs returned");
    }

    const streams = await probeStreamUrls(streamUrls);
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
async function scrapeCatflix(type, tmdb_id, season, episode) {
  try {
    const stream = await fetchCatflixStream(type, tmdb_id, season, episode);
    if (!stream) return [];
    const streams = await probeStreamUrls([stream.url]);
    return streams.map((s) => ({ ...s, source: "catflix" }));
  } catch (error) {
    console.error(`[catflix] ${error.message}`);
    return [];
  }
}

// Merge every reachable stream from all sources, best advertised rendition
// first. The sort is stable and vaplayer streams come first in the input, so
// on equal quality the long-standing source keeps priority (its mirrors are
// known-good and its CDN is the one this proxy has been tuned against).
function rankStreams(...streamLists) {
  return streamLists
    .flat()
    .map((s, index) => ({ ...s, index }))
    .sort((a, b) => b.pixels - a.pixels || a.index - b.index)
    .map(({ index, ...s }) => s);
}

// Some CDN mirrors (e.g. startupscalingsystem.website) intermittently drop
// connections on individual segment requests. Retry a couple of times
// before giving up, since one dropped connection shouldn't kill playback.
async function fetchUpstreamWithRetry(target, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const upstream = await fetch(target, {
        headers: upstreamHeadersFor(target),
      });
      if (upstream.ok) return upstream;
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
      const text = Buffer.concat([head, ...rest]).toString("utf8");
      const baseUrl = new URL(target);
      const isMaster = text.includes("#EXT-X-STREAM-INF");
      const isVariant = req.query.variant === "1";

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

    const body = Readable.from(resumeStream(segmentHead, iterator, done));
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

  const cacheKey = JSON.stringify(req.query);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    console.log("Serving from cache");
    return res.json(cached.response);
  }

  try {
    // Both sources are independent, so resolve them concurrently. vaplayer
    // also supplies title/imdb_id/subtitles used further down, so it always
    // runs even when Catflix ends up winning on quality.
    const [result, catflixStreams] = await Promise.all([
      (async () => {
        const resolvedEpisode =
          type === "tv" ? await resolveTVEpisodeIndex(tmdb_id, season, episode) : episode;
        return scrapeVaplayerAPI(type, tmdb_id, season, resolvedEpisode);
      })(),
      scrapeCatflix(type, tmdb_id, season, episode),
    ]);

    const streams = rankStreams(result.streams, catflixStreams);
    const best = streams[0] || null;
    if (best) {
      console.log(
        `[extract] ${streams.length} stream(s): ` +
          streams.map((s) => `${s.source}@${qualityLabel(s) || "?"}`).join(", ")
      );
    }

    const proxied = (url) =>
      `${req.protocol}://${req.get("host")}/hls-proxy?url=${encodeURIComponent(url)}`;
    const proxiedHlsUrl = best ? proxied(best.url) : null;
    // Every reachable stream from every source, proxied the same way as
    // hls_url — hls_url is always mirrors[0], kept as its own field for
    // backward compatibility with existing consumers that only read hls_url.
    const proxiedMirrors = streams.map((s) => proxied(s.url));

    // Subtitles: append Wyzie ON TOP of whatever the extractor returned ("the
    // other subtitles") — Wyzie ALWAYS runs for both movies and TV (it's a
    // fast, cached, multi-language API), so it is never gated behind a fallback.
    const extractorSubs = Array.isArray(result.subtitles) ? result.subtitles : [];
    const host = `${req.protocol}://${req.get("host")}`;
    let subtitles = [...extractorSubs];
    let errored = false;

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
      errored = true;
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
          errored = true;
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
          errored = true;
        }
        if (subtitles.length === 0 && addic7edFailed) {
          subtitles = [
            `${host}/tv-subtitle-srt-fallback?title=${encodeURIComponent(result.title)}&season=${season}&episode=${episode}`,
          ];
        }
      }
    }

    // Don't cache a transient lookup failure that left us with nothing.
    const subtitleLookupFailed = subtitles.length === 0 && errored;

    const response = {
      success: !!best,
      hls_url: proxiedHlsUrl,
      mirrors: proxiedMirrors,
      source: best ? best.source : null,
      quality: best ? qualityLabel(best) : null,
      subtitles,
      error: best ? null : result.error || "No stream found",
    };

    // Don't cache a transient subtitle-lookup failure as if it were a
    // final answer — that would keep serving "no subtitles" for the rest
    // of the 15-minute window even though a retry would likely succeed.
    if (response.success && !subtitleLookupFailed) {
      cache.set(cacheKey, {
        timestamp: Date.now(),
        response,
      });
    }

    res.json(response);
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
