// Movy.sx stream API (api.wecollege.net). City-named extractors return an
// enc=2 payload that we decrypt with a short-lived /seed. Referer must be
// https://www.movy.sx/ both for the API and for finalsignal CDN hosts.
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

const STREAM_API = process.env.WECOLLEGE_API || "https://api.wecollege.net";
const ORIGIN = "https://www.movy.sx";
// UpCloud (and some other DC) IPs get CF 403 on api.wecollege.net. Optional
// SOCKS5 (e.g. socks5://165.22.111.114:8080) relays seed/city calls.
// Lazy: read env at call time so PM2/dotenv have already loaded .env.
let movyAgent;
let movyAgentUri;
function getMovyAgent() {
  const uri = process.env.MOVY_SOCKS || "";
  if (!uri) return undefined;
  if (movyAgent && movyAgentUri === uri) return movyAgent;
  movyAgentUri = uri;
  movyAgent = new SocksProxyAgent(uri);
  console.log(`[movy] API via SOCKS ${uri}`);
  return movyAgent;
}
const MAGIC = Buffer.from([109, 118, 109, 49]); // "mvm1"
const SHA_WORDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
];

// English / original-audio cities Movy lists first. Dubbed cities (munich,
// berlin, paris, delhi, cancun, austin) are skipped unless we add language UI.
//
// Nashville is intentionally NOT in the primary race: it often returns DASH
// (finalsignal) labeled "Auto", which is a worse default than HLS cities.
// Callers can request it alone as a last-resort fallback.
const CITIES = [
  "phoenix",
  "miami",
  "boise",
  "chicago",
  "seattle",
  "atlanta",
  "portland",
  "dallas",
  "reno",
  "oakland",
];
export const NASHVILLE_CITY = "nashville";

const API_HEADERS = {
  Origin: ORIGIN,
  Referer: `${ORIGIN}/`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
};

function murmur(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}
function rotl(e, a) {
  e >>>= 0;
  a &= 31;
  return a === 0 ? e >>> 0 : ((e << a) | (e >>> (32 - a))) >>> 0;
}
function evenParity(e) {
  return ((e * (e + 1)) & 1) === 0;
}

function makeState(seedStr, mediaId) {
  // Movy's length-parity branch is dead for normal seeds (n*(n+1) is always
  // even); we only implement the live 61-slot path.
  const S = Array(61);
  let n =
    murmur(
      (function (e) {
        let a = 0x811c9dc5;
        for (let t = 0; t < e.length; t++) a = Math.imul(a ^ e.charCodeAt(t), 0x1000193) >>> 0;
        return murmur(a);
      })(seedStr) ^ murmur((Number(mediaId) >>> 0) ^ 0x9e3779b9)
    ) >>> 0;
  for (let e = 0; e < 8; e++) {
    if (evenParity(e)) {
      const a = n % 61;
      n = rotl((n + 0x9e3779b9) >>> 0, 7 + (7 & e));
      S[a] = (n ^ murmur(n)) >>> 0;
      n = murmur((n + a) >>> 0);
    } else {
      S[e] = SHA_WORDS[15 & e];
    }
  }
  return { S, acc: murmur(0xa5a5a5a5 ^ n) >>> 0 };
}

function keystream(state, len) {
  const out = new Uint8Array(len);
  let step = 0;
  const st = { S: state.S.slice(), acc: state.acc };
  for (let e = 0; e < len; ) {
    const n = st.S;
    let acc = st.acc;
    const slot = acc % 61;
    const present = 0 - Number(slot in n);
    const slotVal = (n[slot] >>> 0) || 0;
    const mix = Math.imul(0x9e3779b9, step + 1) >>> 0;
    const xored = (slotVal ^ mix) >>> 0;
    let b = (((acc ^ xored) >>> 0) | ((acc & xored & present) >>> 0)) >>> 0;
    b = (rotl((b + acc) >>> 0, 31 & slot) ^ rotl(acc, 31 & Math.imul(slot, 7))) >>> 0;
    acc = murmur((b + 0x9e3779b9) >>> 0);
    n[slot] = acc >>> 0;
    st.acc = acc;
    const word = acc >>> 0;
    step++;
    out[e++] = word & 255;
    if (e < len) out[e++] = (word >>> 8) & 255;
    if (e < len) out[e++] = (word >>> 16) & 255;
    if (e < len) out[e++] = (word >>> 24) & 255;
  }
  return out;
}

export function decryptWecollegePayload(payloadB64, seed, mediaId) {
  const raw = Buffer.from(String(payloadB64).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const bytes = new Uint8Array(raw);
  const ks = keystream(makeState(String(seed), mediaId), bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= ks[i];
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("wecollege decrypt failed (bad seed)");
  }
  return Buffer.from(bytes.subarray(MAGIC.length)).toString("utf8");
}

async function fetchSeed(mediaId, timeoutMs) {
  // timeoutMs <= 0 → no abort (extract relies on durable cache instead).
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const agent = getMovyAgent();
    const res = await fetch(`${STREAM_API}/seed?mediaId=${encodeURIComponent(mediaId)}`, {
      headers: API_HEADERS,
      ...(agent ? { agent } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) throw new Error(`seed ${res.status}`);
    const json = await res.json();
    if (!json?.seed) throw new Error("seed missing");
    return json.seed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sourceQualityLabel(s) {
  const raw = s?.quality ?? s?.label ?? s?.resolution ?? s?.height ?? "";
  return String(raw || "").trim();
}

async function fetchCitySources(city, params, mediaId, seed, timeoutMs) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const url = new URL(`${STREAM_API}/${city}/sources`);
    for (const [k, v] of Object.entries({ ...params, enc: "2", seed })) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const agent = getMovyAgent();
    const res = await fetch(url, {
      headers: API_HEADERS,
      ...(agent ? { agent } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${city} ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 160);
      throw err;
    }
    const payload = text.trim().startsWith('"') ? JSON.parse(text.trim()) : text.trim();
    const json = JSON.parse(decryptWecollegePayload(payload, seed, mediaId));
    const sources = Array.isArray(json?.sources) ? json.sources : [];
    const streams = sources
      .map((s) => {
        const u = typeof s?.url === "string" ? s.url.trim() : "";
        if (!/^https?:\/\//i.test(u)) return null;
        return { url: u, quality: sourceQualityLabel(s), city };
      })
      .filter(Boolean);
    return {
      city,
      streams,
      subtitles: Array.isArray(json?.subtitles) ? json.subtitles : [],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Race Movy's English city extractors.
 * Returns { streams: [{url, quality, city}], urls, subtitles } or null.
 * `quality` is Movy's own label (often "2160p"/"1080p") — their CDNs frequently
 * serve bare media playlists with no RESOLUTION tags, so callers must keep it.
 * `meta` needs { title, year, imdbId, totalSeasons }.
 */
export async function fetchMovyStreams(
  type,
  tmdb_id,
  season,
  episode,
  meta,
  timeoutMs = 0,
  { cities = CITIES } = {}
) {
  if (!meta?.title || !tmdb_id) return null;
  const mediaType = type === "tv" ? "tv" : "movie";
  const params = {
    title: encodeURIComponent(meta.title),
    mediaType,
    year: meta.year || undefined,
    totalSeasons: mediaType === "tv" ? meta.totalSeasons || undefined : undefined,
    episodeId: mediaType === "tv" ? episode : 1,
    seasonId: mediaType === "tv" ? season : 1,
    tmdbId: Number(tmdb_id),
    imdbId: meta.imdbId || undefined,
    // Chinese / original titles help Nashville (and a few other cities) resolve
    // Asian dramas that English-only search misses.
    altTitle: meta.altTitle || meta.originalTitle || undefined,
  };

  // timeoutMs <= 0: no abort on seed or cities (durable /extract cache is
  // the latency budget). Positive values keep the old seed/city split.
  const noTimeout = !(timeoutMs > 0);
  const seedTimeout = noTimeout
    ? 0
    : Math.min(6000, Math.max(2500, Math.floor(timeoutMs * 0.35)));
  const seed = await fetchSeed(tmdb_id, seedTimeout);

  const cityTimeout = noTimeout ? 0 : Math.max(5000, timeoutMs - seedTimeout);
  const cityList = Array.isArray(cities) && cities.length ? cities : CITIES;
  const results = await Promise.all(
    cityList.map((city) =>
      fetchCitySources(city, params, tmdb_id, seed, cityTimeout).catch((err) => {
        if (!/no streams|not found|paused|blocked|SEED_INVALID/i.test(err.body || err.message)) {
          // keep noise low — most cities miss on any given title
        }
        return null;
      })
    )
  );

  const streams = [];
  const seen = new Set();
  const subtitles = [];
  for (const r of results) {
    if (!r) continue;
    for (const s of r.streams) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      streams.push(s);
    }
    for (const sub of r.subtitles) {
      const u = typeof sub === "string" ? sub : sub?.url;
      if (u && /^https?:\/\//i.test(u)) subtitles.push(u);
    }
  }
  if (!streams.length) return null;
  // Highest claimed quality first so probes / ranking see 2160p before "Auto".
  const rank = (q) => {
    const s = String(q || "").toLowerCase();
    if (/2160|4k|uhd/.test(s)) return 2160;
    if (/1440|2k/.test(s)) return 1440;
    if (/1080|fhd/.test(s)) return 1080;
    if (/720/.test(s)) return 720;
    if (/480/.test(s)) return 480;
    if (/360/.test(s)) return 360;
    return 0;
  };
  streams.sort((a, b) => rank(b.quality) - rank(a.quality));
  return {
    streams,
    // Back-compat for anything still reading `.urls`.
    urls: streams.map((s) => s.url),
    subtitles,
  };
}
