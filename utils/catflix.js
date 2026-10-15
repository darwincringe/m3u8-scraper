// Stream sources behind the vidnest.fun embed (one of the six players
// hurawatch.cz iframes). vidnest's frontend offers a dozen backends, all
// served from https://new.vidnest.fun/<backend>/{movie|tv}/... behind the
// same auth/envelope (see below). We use three of them:
//
// - "Catflix" (/yflix): good 1080p encodes but spotty coverage. Decoded
//   JSON is {url, headers}; url is an HLS master (usually proxied through
//   pwcloud.animanga.fun/hls/<base64 upstream>/master.m3u8), segments on
//   tiktokcdn.com disguised as PNGs.
// - "flixhq" (/flixhq, vidnest's "Beta"): {url, quality: "auto", subtitles}
//   where url is a master on a Cloudflare Worker (*.workers.dev) that
//   proxies the real CDN. Widest coverage of the three, highest bitrates
//   (1080p ~6-8 Mbps, 2160p on some films), and 10-90 MB/s from our host.
// - "ophim" (/ophim, vidnest's "Lamda", aoneroom upstream): {streams:
//   [{language, quality, type, url}]} — one master per audio language, also
//   behind a Worker. Same speed class as flixhq, slightly less coverage.
//
// (Superstream — one bare media playlist per quality on a throttled CDN —
// was dropped in Oct 2026 when vidnest swapped it for a French-dub source
// whose CDN only answers vidnest's own proxy.)
import fetch from "node-fetch";
import crypto from "crypto";

const API_BASE = "https://new.vidnest.fun";

// Since Oct 2026 the API rejects calls without a `_n` query param (403
// "missing or invalid nonce") and answers in a "v2" envelope
// {v: 2, d: <base64url iv||ciphertext||tag>, n: <nonce>} — AES-256-GCM with
// key SHA-256("<n>|<secret>"). The nonce is just 16 random bytes the client
// picks; the secret is a constant from their bundle (withStreamNonceUrl /
// decryptCipherResponse in vidnest's chunk). Override with VIDNEST_SECRET
// if they rotate it.
const V2_SECRET = process.env.VIDNEST_SECRET || "F9k2mR8vL4qP7wY1zN0fG3bS6tH5jC8d_x4R7vN2mP9qL1";
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

// new.vidnest.fun sits behind a Cloudflare WAF rule that hard-blocks
// datacenter IPs (403 "Sorry, you have been blocked" for DigitalOcean etc.),
// while the stream CDN it points at is open. Requests from Cloudflare Workers
// egress via Cloudflare's own network and pass that rule, so when the direct
// call is blocked we retry through a fetch-proxy Worker. CATFLIX_RELAY is a
// comma-separated list of URL prefixes (the target URL is appended,
// URL-encoded), tried in order — put our own relay (relay/vidnest-relay.
// worker.js) first and any third-party one after it as a spare. The
// default is the generic worker vidnest's own page uses, which went dark
// on 2026-10-15 (error 1101 on every call) and took every vidnest source
// down with it, so don't run prod on the default alone. "off" disables the
// fallback. CATFLIX_RELAY_KEY is sent as X-Relay-Key for relays that want
// one.
const RELAY_PREFIXES = (process.env.CATFLIX_RELAY || "https://fetch.streaming-1.workers.dev/fetch?url=")
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...REQUEST_HEADERS, ...extraHeaders }, signal: controller.signal });
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
    clearTimeout(timeout);
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

// Catflix: returns { url, headers } or null when the source has nothing
// for this title.
export async function fetchCatflixStream(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const payload = await fetchVidnestPayload(titlePath("yflix", type, tmdb_id, season, episode), timeoutMs);
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, headers: payload.headers || {} };
}

// flixhq: returns [masterUrl] or null when the source has nothing for this
// title. The payload is {status: "success", url, quality: "auto"}.
export async function fetchFlixhqStreams(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const payload = await fetchVidnestPayload(titlePath("flixhq", type, tmdb_id, season, episode), timeoutMs);
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return [url];
}

// ophim: returns [masterUrl, ...] (original-language first) or null. The
// payload is {streams: [{language, quality, type, url}]}, one master per
// audio language; dubs are skipped unless nothing else is offered.
export async function fetchOphimStreams(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const payload = await fetchVidnestPayload(titlePath("ophim", type, tmdb_id, season, episode), timeoutMs);
  const list = (Array.isArray(payload?.streams) ? payload.streams : [])
    .filter((s) => typeof s?.url === "string" && /^https?:\/\//i.test(s.url.trim()))
    .filter((s) => !s.type || /hls|m3u8/i.test(s.type));
  const original = list.filter((s) => /original|multi/i.test(s.language || ""));
  const chosen = original.length ? original : list;
  return chosen.length ? chosen.map((s) => s.url.trim()) : null;
}

async function lookupVidnestPayload(path, timeoutMs) {
  const apiUrl = `${API_BASE}${path}?_n=${newNonce()}`;
  let json;
  try {
    json = await fetchJSON(apiUrl, timeoutMs);
  } catch (directErr) {
    if (!RELAY_PREFIXES.length) throw directErr;
    // A 404/502 means the backend genuinely has nothing for the title (and
    // may have taken 10s+ scraping to say so); a relay would only ask it
    // the same question. Anything else (403 from the WAF, connection reset,
    // timeout) is worth retrying via the relays, in order. A relay that
    // answers 404/502 has reached vidnest and got its verdict — that is
    // final; anything else means the relay itself is broken, so move on
    // to the next one.
    if (isNoEntry(directErr)) throw directErr;
    const failures = [`direct: ${directErr.message}`];
    let verdict = null;
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
        if (isNoEntry(relayErr)) {
          verdict = relayErr.status;
          break;
        }
      }
    }
    if (!json) {
      const err = new Error(failures.join("; "));
      // Keep the verdict so callers can tell "not in catalogue" from a
      // transient failure.
      if (verdict) err.status = verdict;
      throw err;
    }
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
