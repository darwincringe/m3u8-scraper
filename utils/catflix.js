// Stream sources behind the vidnest.fun embed (one of the six players
// hurawatch.cz iframes). vidnest's frontend offers a dozen backends, all
// served from https://new.vidnest.fun/<backend>/{movie|tv}/... and all
// answering {"data": "<blob>", "encrypted": true}. The "encryption" is just
// base64 with a shuffled alphabet, reproduced here from their bundle. We use
// two of them:
//
// - "Catflix" (/yflix): consistently exposes a 1920x1080 rendition where
//   vaplayer.ru tops out at 720p for the same file. Decoded JSON is
//   {url, headers}; url is an HLS master (usually proxied through
//   pwcloud.animanga.fun/hls/<base64 upstream>/master.m3u8).
// - "Superstream" (/superstream, backed by lookmovie2): decoded JSON is
//   {streams: [{quality: "1080p", url, type: "hls"}], subtitles: [...]}
//   where each url is a bare *media* playlist on *.laterascent.site. Its
//   1080p runs ~3.5 Mbps where vaplayer's "1080p" YTS re-encodes sit around
//   1 Mbps, so it's the better fallback when Catflix has no entry.
import fetch from "node-fetch";

const API_BASE = "https://new.vidnest.fun";

// new.vidnest.fun sits behind a Cloudflare WAF rule that hard-blocks
// datacenter IPs (403 "Sorry, you have been blocked" for DigitalOcean etc.),
// while the stream CDN it points at is open. Requests from Cloudflare Workers
// egress via Cloudflare's own network and pass that rule, so when the direct
// call is blocked we retry through a generic fetch-proxy Worker — the same
// one vidnest's own page uses to load third-party scripts. Override with
// CATFLIX_RELAY (a URL prefix the target URL is appended to, URL-encoded) if
// that worker goes away; set it to "off" to disable the fallback.
const RELAY_PREFIX =
  process.env.CATFLIX_RELAY || "https://fetch.streaming-1.workers.dev/fetch?url=";
const REQUEST_HEADERS = {
  Referer: "https://vidnest.fun/",
  Origin: "https://vidnest.fun",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
const CIPHER_ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

const CIPHER_TO_STD = new Map([...CIPHER_ALPHABET].map((ch, i) => [ch, STD_ALPHABET[i]]));

export function decodeVidnestCipher(blob) {
  let std = "";
  for (const ch of blob) std += CIPHER_TO_STD.get(ch) ?? ch;
  while (std.length % 4) std += "=";
  return Buffer.from(std, "base64").toString("utf8");
}

async function fetchJSON(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`vidnest API returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Successful lookups (including "nothing for this title") are remembered
// for a while: the manifest URLs the API hands out are stable, and the API
// rate-limits per source IP — through the relay that IP is shared with
// every other user of the Worker, so every call we can skip matters.
const LOOKUP_TTL_MS = 30 * 60 * 1000;
const lookupCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lookupCache) if (now - v.at >= LOOKUP_TTL_MS) lookupCache.delete(k);
}, 60 * 1000).unref();

function titlePath(backend, type, tmdb_id, season, episode) {
  return type === "tv"
    ? `/${backend}/tv/${tmdb_id}/${season}/${episode}`
    : `/${backend}/movie/${tmdb_id}`;
}

// Decoded payload for one backend/title, memoised. Network/parse errors
// are thrown so the caller can log them.
async function fetchVidnestPayload(path, timeoutMs) {
  const cached = lookupCache.get(path);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.value;
  const value = await lookupVidnestPayload(path, timeoutMs);
  lookupCache.set(path, { at: Date.now(), value });
  return value;
}

// Catflix: returns { url, headers } or null when the source has nothing
// for this title.
export async function fetchCatflixStream(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const payload = await fetchVidnestPayload(titlePath("yflix", type, tmdb_id, season, episode), timeoutMs);
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, headers: payload.headers || {} };
}

// Superstream: returns [{ url, quality, height }] (one media playlist per
// quality, best first) or null when the source has nothing for this title.
export async function fetchSuperstreamStreams(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const payload = await fetchVidnestPayload(
    titlePath("superstream", type, tmdb_id, season, episode),
    timeoutMs
  );
  const list = Array.isArray(payload?.streams) ? payload.streams : [];
  const streams = list
    .filter((s) => typeof s?.url === "string" && /^https?:\/\//i.test(s.url.trim()))
    .filter((s) => !s.type || /hls|m3u8/i.test(s.type))
    .map((s) => ({
      url: s.url.trim(),
      quality: String(s.quality || "").trim(),
      height: parseInt(/(\d{3,4})p/i.exec(s.quality || "")?.[1] || "0", 10),
    }))
    .sort((a, b) => b.height - a.height);
  return streams.length ? streams : null;
}

async function lookupVidnestPayload(path, timeoutMs) {
  const apiUrl = `${API_BASE}${path}`;
  let json;
  try {
    json = await fetchJSON(apiUrl, timeoutMs);
  } catch (directErr) {
    if (!RELAY_PREFIX || RELAY_PREFIX === "off") throw directErr;
    // A 404 means the title genuinely isn't there; anything else (403 from
    // the WAF, connection reset, timeout) is worth one retry via the relay.
    if (directErr.status === 404) throw directErr;
    try {
      json = await fetchJSON(`${RELAY_PREFIX}${encodeURIComponent(apiUrl)}`, timeoutMs);
    } catch (relayErr) {
      throw new Error(`direct: ${directErr.message}; relay: ${relayErr.message}`);
    }
  }

  let payload = json;
  if (json?.encrypted) {
    if (typeof json.data !== "string") throw new Error("vidnest response missing data");
    const decoded = decodeVidnestCipher(json.data);
    try {
      payload = JSON.parse(decoded);
    } catch {
      payload = { url: decoded };
    }
  }

  // The API wraps its own errors in the same "encrypted" envelope, e.g.
  // {"error":"IP blocked for excessive rate limiting. Try again in 7m49s."}
  // (it rate-limits per source IP, and the relay's egress IP is shared).
  // Surface those as throws so the caller treats them as transient rather
  // than "this title has no stream here".
  if (payload && typeof payload === "object" && payload.error) {
    const err = new Error(`vidnest API error: ${payload.error}`);
    err.status = /rate limit/i.test(payload.error) ? 429 : 502;
    throw err;
  }

  return payload;
}
