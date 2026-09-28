// "Catflix" stream source, as used by the vidnest.fun embed (one of the
// six players hurawatch.cz iframes). It consistently exposes a 1920x1080
// rendition where vaplayer.ru tops out at 720p for the same file.
//
// vidnest's frontend calls https://new.vidnest.fun/yflix/{movie|tv}/... and
// gets back {"data": "<blob>", "encrypted": true}. The "encryption" is just
// base64 with a shuffled alphabet, reproduced here from their bundle. The
// decoded JSON is {url, headers} where url is an HLS master playlist (usually
// proxied through pwcloud.animanga.fun/hls/<base64 upstream>/master.m3u8).
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
      const err = new Error(`catflix API returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Returns { url, headers } or null when the source has nothing for this
// title. Network/parse errors are thrown so the caller can log them.
export async function fetchCatflixStream(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const path =
    type === "tv"
      ? `/yflix/tv/${tmdb_id}/${season}/${episode}`
      : `/yflix/movie/${tmdb_id}`;

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
    if (typeof json.data !== "string") throw new Error("catflix response missing data");
    const decoded = decodeVidnestCipher(json.data);
    try {
      payload = JSON.parse(decoded);
    } catch {
      payload = { url: decoded };
    }
  }

  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, headers: payload.headers || {} };
}
