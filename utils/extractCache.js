// Durable /extract response cache. Survives PM2 restarts so a cancelled
// cold scrape on one visit still leaves a warm answer for the next.
import fs from "fs";
import path from "path";

const CACHE_TTL_MS = 1000 * 60 * 60 * 2; // fresh: 2h
const CACHE_TTL_TRANSIENT_MS = 1000 * 60 * 10; // flaky secondary: 10m
const CACHE_STALE_MS = 1000 * 60 * 60 * 48; // serve stale up to 48h
const CACHE_FILE =
  process.env.EXTRACT_CACHE_FILE || "/var/lib/srctv/extract-cache.json";

/** @type {Map<string, { timestamp: number, ttl: number, response: object }>} */
const mem = new Map();
let saveTimer = null;
let loaded = false;

function ensureDir() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  } catch {}
}

export function loadExtractCache() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const now = Date.now();
    let n = 0;
    for (const [key, entry] of Object.entries(raw?.entries || {})) {
      if (!entry?.response?.success || !entry.timestamp) continue;
      if (now - entry.timestamp >= CACHE_STALE_MS) continue;
      mem.set(key, {
        timestamp: entry.timestamp,
        ttl: entry.ttl || CACHE_TTL_MS,
        response: entry.response,
      });
      n++;
    }
    if (n) console.log(`[extract-cache] loaded ${n} entr${n === 1 ? "y" : "ies"} from disk`);
  } catch (err) {
    console.warn(`[extract-cache] load failed: ${err.message}`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDir();
      const entries = {};
      const now = Date.now();
      for (const [key, entry] of mem) {
        if (now - entry.timestamp >= CACHE_STALE_MS) continue;
        if (!entry.response?.success) continue;
        // Strip absolute origins — rehostExtractResponse rewrites on read.
        entries[key] = {
          timestamp: entry.timestamp,
          ttl: entry.ttl,
          response: entry.response,
        };
      }
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), entries }));
      fs.renameSync(tmp, CACHE_FILE);
    } catch (err) {
      console.warn(`[extract-cache] save failed: ${err.message}`);
    }
  }, 1500);
  saveTimer.unref?.();
}

export function extractCacheKey({ type, tmdb_id, season, episode }) {
  return JSON.stringify({
    type,
    tmdb_id: String(tmdb_id),
    season: season == null || season === "" ? null : String(season),
    episode: episode == null || episode === "" ? null : String(episode),
  });
}

export function cacheEntryFresh(entry, now = Date.now()) {
  return now - entry.timestamp < (entry.ttl ?? CACHE_TTL_MS);
}

export function cacheEntryUsable(entry, now = Date.now()) {
  return now - entry.timestamp < CACHE_STALE_MS;
}

export function getExtractCache(key) {
  loadExtractCache();
  const entry = mem.get(key);
  if (!entry) return null;
  if (!cacheEntryUsable(entry)) {
    mem.delete(key);
    scheduleSave();
    return null;
  }
  return entry;
}

export function rememberExtractSuccess(cacheKey, response, transient) {
  if (!response?.success) return;
  mem.set(cacheKey, {
    timestamp: Date.now(),
    ttl: transient ? CACHE_TTL_TRANSIENT_MS : CACHE_TTL_MS,
    response,
  });
  scheduleSave();
}

export function pruneExtractCache() {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of mem) {
    if (!cacheEntryUsable(entry, now)) {
      mem.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// Sweep every minute.
setInterval(pruneExtractCache, 60 * 1000).unref?.();

export { CACHE_TTL_MS, CACHE_TTL_TRANSIENT_MS, CACHE_STALE_MS };
