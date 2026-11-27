// Stream sources behind the vidnest.fun embed (one of the six players
// hurawatch.cz iframes). vidnest's frontend offers a dozen backends, all
// served from https://promox.vidnest.fun/<backend>/{movie|tv}/... behind the
// same auth/envelope (see below). (Host was new.vidnest.fun until ~Nov 2026;
// that origin now 522s.) We use three of them:
//
// - "Catflix": prefers /yflix ({url, headers} on animanga/tiktokcdn), falls
//   back to /moviebox ({streams:[{url,quality}]} on media.bigbang.observer).
// - "flixhq": prefers /flixhq (often dead/502), falls back to /purstream
//   (vidnest "Beta") which returns Movy-proxied HLS via /movy/pl/... — rewrite
//   new.vidnest.fun → promox so the wrapper still answers.
// - "ophim" (/ophim, vidnest's "Lamda", aoneroom upstream): {streams:
//   [{language, quality, type, url}]} — one master per audio language, also
//   behind a Worker. Same speed class as flixhq, slightly less coverage.
//
// (Superstream — one bare media playlist per quality on a throttled CDN —
// was dropped in Oct 2026 when vidnest swapped it for a French-dub source
// whose CDN only answers vidnest's own proxy.)
import fetch from "node-fetch";
import crypto from "crypto";

// Current API host from vidnest's player bundle (promox.*). Keep the old
// host as a fallback in case they flip back. Override with VIDNEST_API_BASE
// (comma-separated) if they rotate again.
const API_BASES = (
  process.env.VIDNEST_API_BASE || "https://promox.vidnest.fun,https://new.vidnest.fun"
)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const API_BASE = API_BASES[0] || "https://promox.vidnest.fun";

// Purstream (and some other backends) still mint playlist wrappers on the
// retired new.vidnest.fun host; promox serves the same /movy/pl/ path.
function rewriteVidnestUrl(url) {
  if (typeof url !== "string") return url;
  return url.replace(/^https?:\/\/new\.vidnest\.fun(?=\/)/i, API_BASE);
}

// Since Oct 2026 the API rejects calls without a `_n` query param (403
// "missing or invalid nonce") and answers in a "v2" envelope
// {v: 2, d: <base64url iv||ciphertext||tag>, n: <nonce>} — AES-256-GCM with
// key SHA-256("<n>|<secret>"). The nonce is just 16 random bytes the client
// picks; the secret is a constant from their bundle (withStreamNonceUrl /
// decryptCipherResponse in vidnest's chunk). Override with VIDNEST_SECRET
// if they rotate it.
// Rotated on vidnest's frontend ~Oct 2026 (was F9k2mR8v…); override with
// VIDNEST_SECRET if they rotate again.
const V2_SECRET = process.env.VIDNEST_SECRET || "K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2";
const newNonce = () => crypto.randomBytes(16).toString("base64url");
function decryptV2(d, n) {
  const key = crypto.createHash("sha256").update(`${n}|${V2_SECRET}`).digest();
  const buf = Buffer.from(d, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Datacenter IPs sometimes get CF WAF 403 on the vidnest API; the stream CDN
// it points at is open. Requests from Cloudflare Workers egress via CF's own
// network and pass that rule, so when the direct call is blocked we retry
// through a fetch-proxy Worker. CATFLIX_RELAY is a comma-separated list of
// URL prefixes (the target URL is appended, URL-encoded), tried in order —
// put our own relay (relay/vidnest-relay.worker.js) first. Default public
// relay went dark 2026-10-15; leave CATFLIX_RELAY empty/"off" when the
// current host (promox) answers the droplet directly. CATFLIX_RELAY_KEY is
// sent as X-Relay-Key for relays that want one.
const RELAY_PREFIXES = (process.env.CATFLIX_RELAY || "off")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s && s !== "off");
const RELAY_KEY = process.env.CATFLIX_RELAY_KEY || "";
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

async function fetchJSON(url, timeoutMs, extraHeaders) {
  // timeoutMs <= 0 → wait as long as the upstream needs. Durable /extract
  // cache covers repeat plays; aborting mid-scrape was surfacing as
  // "cancelled" in the player with nothing cached.
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const res = await fetch(url, {
      headers: { ...REQUEST_HEADERS, ...extraHeaders },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      // Release the socket: an unread body keeps it (and its buffers) alive.
      try {
        res.body?.destroy();
      } catch {}
      const err = new Error(`vidnest API returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Successful lookups (including "nothing for this title") are remembered
// for a while: the manifest URLs the API hands out are stable, and the API
// rate-limits per source IP — through the relay that IP is shared with
// every other user of the Worker, so every call we can skip matters.
const LOOKUP_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // see fetchVidnestPayload
const lookupCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of lookupCache) {
    if (now - v.at >= (v.error ? NEGATIVE_TTL_MS : LOOKUP_TTL_MS)) lookupCache.delete(k);
  }
}, 60 * 1000).unref();

function titlePath(backend, type, tmdb_id, season, episode) {
  return type === "tv"
    ? `/${backend}/tv/${tmdb_id}/${season}/${episode}`
    : `/${backend}/movie/${tmdb_id}`;
}

// Decoded payload for one backend/title, memoised. Network/parse errors
// are thrown so the caller can log them.
//
// "No entry" answers (404, or the 502 vidnest returns when a backend has
// nothing for the title) are memoised too, for a shorter while: their
// backends scrape on demand and a miss can take 10s+, so without this a
// title that Catflix lacks would re-pay that on every /extract. Timeouts,
// rate limits and other failures are never cached.
const isNoEntry = (err) => err?.status === 404 || err?.status === 502;
async function fetchVidnestPayload(path, timeoutMs) {
  const cached = lookupCache.get(path);
  if (cached) {
    const ttl = cached.error ? NEGATIVE_TTL_MS : LOOKUP_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
  }
  // One lookup per title at a time: a viewer retrying while the first
  // request is still waiting on vidnest should join it, not start another.
  let pending = inflight.get(path);
  if (!pending) {
    pending = lookupVidnestPayload(path, timeoutMs)
      .then((value) => {
        lookupCache.set(path, { at: Date.now(), value });
        return value;
      })
      .catch((error) => {
        if (isNoEntry(error)) lookupCache.set(path, { at: Date.now(), error });
        throw error;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}
const inflight = new Map();

// Try backends in order. Catalogue misses (404/502) advance to the next;
// other errors (rate-limit, decrypt, network) abort immediately.
async function fetchFirstBackend(backends, type, tmdb_id, season, episode, timeoutMs) {
  let lastNoEntry = null;
  for (const backend of backends) {
    try {
      return await fetchVidnestPayload(titlePath(backend, type, tmdb_id, season, episode), timeoutMs);
    } catch (error) {
      if (isNoEntry(error)) {
        lastNoEntry = error;
        continue;
      }
      throw error;
    }
  }
  if (lastNoEntry) throw lastNoEntry;
  return null;
}

function qualityRank(q) {
  const m = String(q || "").match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

// Normalize either legacy {url, headers} or {streams:[{url,quality,headers}]}
// into { urls (best quality first), headers, subtitles }.
function normalizeStreamPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  if (typeof payload.url === "string" && /^https?:\/\//i.test(payload.url.trim())) {
    return {
      urls: [rewriteVidnestUrl(payload.url.trim())],
      headers: payload.headers || {},
      subtitles,
    };
  }
  const list = (Array.isArray(payload.streams) ? payload.streams : [])
    .filter((s) => typeof s?.url === "string" && /^https?:\/\//i.test(s.url.trim()))
    .filter((s) => !s.type || /hls|m3u8/i.test(s.type))
    .map((s) => ({ ...s, url: rewriteVidnestUrl(s.url.trim()) }))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
  if (!list.length) return null;
  return {
    urls: list.map((s) => s.url),
    headers: list[0].headers || payload.headers || {},
    subtitles,
  };
}

// Catflix: returns { url, headers, subtitles } or null when the source has
// nothing for this title. Tries /yflix then /moviebox.
export async function fetchCatflixStream(type, tmdb_id, season, episode, timeoutMs = 0) {
  const payload = await fetchFirstBackend(
    ["yflix", "moviebox"],
    type,
    tmdb_id,
    season,
    episode,
    timeoutMs
  );
  const normalized = normalizeStreamPayload(payload);
  if (!normalized?.urls?.length) return null;
  return {
    url: normalized.urls[0],
    headers: normalized.headers,
    subtitles: normalized.subtitles,
  };
}

// Normalize flixhq's {lang, url} (or bare URL) tracks into proxy-ready
// absolute URLs with a `release=flixhq.<lang>` label so the player can
// tell them apart from Wyzie / vaplayer entries.
function normalizeFlixhqSubtitles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const url = typeof s === "string" ? s.trim() : typeof s?.url === "string" ? s.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const lang = (typeof s === "object" && s?.lang ? String(s.lang) : "und").toLowerCase();
    const sep = url.includes("?") ? "&" : "?";
    out.push(`${url}${sep}release=${encodeURIComponent(`flixhq.${lang}`)}`);
  }
  return out;
}

// flixhq: returns { urls, subtitles } or null. Tries /flixhq then /purstream
// (vidnest remapped "Beta" after /flixhq went dark on promox).
export async function fetchFlixhqStreams(type, tmdb_id, season, episode, timeoutMs = 0) {
  const payload = await fetchFirstBackend(
    ["flixhq", "purstream"],
    type,
    tmdb_id,
    season,
    episode,
    timeoutMs
  );
  const normalized = normalizeStreamPayload(payload);
  if (!normalized?.urls?.length) return null;
  return {
    urls: normalized.urls,
    subtitles: normalizeFlixhqSubtitles(normalized.subtitles),
  };
}

// ophim: returns { urls, subtitles } (original-language first) or null. The
// payload is {streams: [{language, quality, type, url}]}, one master per
// audio language; dubs are skipped unless nothing else is offered. ophim
// does not ship subtitle tracks.
export async function fetchOphimStreams(type, tmdb_id, season, episode, timeoutMs = 0) {
  const payload = await fetchVidnestPayload(titlePath("ophim", type, tmdb_id, season, episode), timeoutMs);
  const normalized = normalizeStreamPayload(payload);
  if (!normalized?.urls?.length) return null;
  const list = (Array.isArray(payload?.streams) ? payload.streams : [])
    .filter((s) => typeof s?.url === "string" && /^https?:\/\//i.test(s.url.trim()))
    .filter((s) => !s.type || /hls|m3u8/i.test(s.type));
  const original = list.filter((s) => /original|multi/i.test(s.language || ""));
  const chosen = original.length ? original : list;
  return chosen.length
    ? { urls: chosen.map((s) => rewriteVidnestUrl(s.url.trim())), subtitles: [] }
    : null;
}

async function lookupVidnestPayload(path, timeoutMs) {
  let json;
  const failures = [];
  let verdict = null;
  let lastErr = null;

  // Try each API base (promox, then legacy new.*). 404/502 from a live host
  // is a definitive "no entry" and stops the search; 5xx/WAF/network moves on.
  for (const base of API_BASES) {
    const apiUrl = `${base}${path}?_n=${newNonce()}`;
    try {
      json = await fetchJSON(apiUrl, timeoutMs);
      break;
    } catch (directErr) {
      lastErr = directErr;
      failures.push(`${new URL(base).host}: ${directErr.message}`);
      if (isNoEntry(directErr) && !/522|523|521/.test(String(directErr.status))) {
        // Real catalogue miss from a reachable host.
        throw directErr;
      }
      // 522/523 = CF couldn't reach origin (dead host). Try next base / relay.
      if (!RELAY_PREFIXES.length) continue;
      for (const prefix of RELAY_PREFIXES) {
        try {
          json = await fetchJSON(
            `${prefix}${encodeURIComponent(apiUrl)}`,
            timeoutMs,
            RELAY_KEY ? { "X-Relay-Key": RELAY_KEY } : undefined
          );
          break;
        } catch (relayErr) {
          failures.push(`relay ${new URL(prefix).host}: ${relayErr.message}`);
          if (isNoEntry(relayErr) && !/522|523|521/.test(String(relayErr.status))) {
            verdict = relayErr.status;
            break;
          }
        }
      }
      if (json || verdict) break;
    }
  }

  if (!json) {
    if (verdict) {
      const err = new Error(failures.join("; ") || "vidnest no entry");
      err.status = verdict;
      throw err;
    }
    throw lastErr || new Error(failures.join("; ") || "vidnest unreachable");
  }

  let payload = json;
  if (json?.v === 2 && typeof json.d === "string") {
    let decoded;
    try {
      decoded = decryptV2(json.d, json.n);
    } catch (e) {
      throw new Error(`vidnest v2 decrypt failed (${e.message}); secret rotated?`);
    }
    try {
      payload = JSON.parse(decoded);
    } catch {
      payload = { url: decoded };
    }
  } else if (json?.encrypted) {
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
