import fetch from "node-fetch";
import { decodeSubtitleBuffer } from "./subtitleEncoding.js";
import { extractReleaseTag } from "./releaseTag.js";

// Wyzie is a hosted subtitle API (sub.wyzie.io) keyed by TMDB/IMDb id. It's
// series-friendly (takes season/episode) and returns ready-to-download SRT
// URLs, so we use it as the primary TV subtitle source ahead of the
// addic7ed/tvsubtitles.net scrapers.
const WYZIE_SEARCH_URL = "https://sub.wyzie.io/search";
// Read lazily at call time, not module load: server.js runs dotenv.config()
// after its imports, so process.env.WYZIE_API_KEY isn't populated yet when
// this module is first evaluated.
const getApiKey = () => process.env.WYZIE_API_KEY;

// Wyzie's results currently resolve to opensubtitles.org, which serves a
// Cloudflare challenge to obviously-scripted clients — send a browser-like
// User-Agent so the download proxy isn't turned away.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// The Wyzie account has a 1000-request/day cap on the *search* endpoint, so
// we cache candidate lists aggressively. Subtitles for a given episode never
// change, so a long TTL is safe: a popular episode is looked up from Wyzie
// once and then reused by every other viewer and on back-navigation/rewatch
// for the rest of the day, keeping us well under the daily limit.
const SEARCH_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const searchCache = new Map(); // `${id}:${season}:${episode}` -> { timestamp, candidates }

// Downloads hit opensubtitles.org (not counted against the Wyzie limit), but
// caching the decoded SRT still avoids re-fetching the same file for every
// viewer / player reload.
const SRT_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const srtCache = new Map(); // downloadUrl -> { timestamp, srt }

// Same idea as the addic7ed scraper's diversifyByRelease: prefer one
// candidate per release/source (BluRay, WEB-DL, HDTV, ...) before filling
// remaining slots by popularity, so the 10 we return aren't all the same
// release group.
function diversifyByRelease(sortedCandidates, limit) {
  const found = [];
  const usedTags = new Set();

  for (const candidate of sortedCandidates) {
    if (found.length >= limit) break;
    if (usedTags.has(candidate.release)) continue;
    found.push(candidate);
    usedTags.add(candidate.release);
  }

  for (const candidate of sortedCandidates) {
    if (found.length >= limit) break;
    if (found.includes(candidate)) continue;
    found.push(candidate);
  }

  return found;
}

// Returns up to `limit` English subtitle candidates for a TV episode,
// diversified by release and ranked by download count, shaped as
// [{ downloadUrl, release }, ...] to match the addic7ed/movie candidate
// consumers in server.js. `id` is a TMDB (or IMDb) id. Cached per episode.
export async function findWyzieTVSubtitleCandidates(id, season, episode, limit = 10) {
  if (!id || season == null || episode == null) return [];

  const apiKey = getApiKey();
  if (!apiKey) throw new Error("WYZIE_API_KEY is not set");

  const cacheKey = `${id}:${season}:${episode}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SEARCH_TTL_MS) {
    return cached.candidates.slice(0, limit);
  }

  const url =
    `${WYZIE_SEARCH_URL}?id=${encodeURIComponent(id)}` +
    `&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}` +
    `&language=en&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Wyzie search returned ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Wyzie returned an unexpected payload");

  const seen = new Set();
  const candidates = data
    .filter((s) => s && s.language === "en" && s.url && s.format === "srt")
    .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
    .map((s) => ({
      downloadUrl: s.url,
      release: extractReleaseTag(s.release || s.fileName || s.origin || ""),
    }))
    .filter((c) => {
      if (seen.has(c.downloadUrl)) return false;
      seen.add(c.downloadUrl);
      return true;
    });

  // Cache the full diversified list (not just `limit`) so a later request
  // with a larger limit is still served from cache.
  const diversified = diversifyByRelease(candidates, Math.max(limit, 10));
  searchCache.set(cacheKey, { timestamp: Date.now(), candidates: diversified });

  return diversified.slice(0, limit);
}

// Downloads a Wyzie subtitle URL and returns decoded SRT text. Cached by URL.
export async function downloadWyzieSubtitleSRT(downloadUrl) {
  const cached = srtCache.get(downloadUrl);
  if (cached && Date.now() - cached.timestamp < SRT_TTL_MS) {
    return cached.srt;
  }

  const res = await fetch(downloadUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.opensubtitles.org/",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Subtitle download returned ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const srt = decodeSubtitleBuffer(buffer);

  srtCache.set(downloadUrl, { timestamp: Date.now(), srt });
  return srt;
}
