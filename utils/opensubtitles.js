// Official OpenSubtitles.com REST API helpers for user-driven subtitle search.
// Scraping www.opensubtitles.org from the droplet hits Anubis/CF challenges
// (same class of problem as the bipuldey19 unofficial scraper), so we use
// api.opensubtitles.com with OPENSUB_API_KEY instead.
import fetch from "node-fetch";
import { decodeSubtitleBuffer } from "./subtitleEncoding.js";

const API_BASE = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "srctv v1.0";
const SEARCH_TTL_MS = 1000 * 60 * 10;
const SRT_TTL_MS = 1000 * 60 * 60 * 6;

const searchCache = new Map();
const srtCache = new Map();
const downloadLinkCache = new Map(); // file_id -> { at, link }

function getApiKey() {
  return process.env.OPENSUB_API_KEY || "";
}

function apiHeaders(extra = {}) {
  const key = getApiKey();
  if (!key) {
    const err = new Error(
      "OPENSUB_API_KEY is not set. Create a free consumer key at https://www.opensubtitles.com/en/consumers"
    );
    err.status = 503;
    throw err;
  }
  return {
    Accept: "application/json",
    "Api-Key": key,
    "User-Agent": USER_AGENT,
    ...extra,
  };
}

function normalizeLang(lang) {
  if (!lang) return "en";
  const s = String(lang).trim().toLowerCase();
  // Map common 3-letter codes from the unofficial API docs → ISO 639-1.
  const map = {
    eng: "en",
    fre: "fr",
    fra: "fr",
    ger: "de",
    deu: "de",
    spa: "es",
    por: "pt",
    pob: "pt-br",
    ita: "it",
    dut: "nl",
    nld: "nl",
    rus: "ru",
    jpn: "ja",
    chi: "zh-cn",
    zht: "zh-tw",
    kor: "ko",
    ara: "ar",
    hin: "hi",
    tur: "tr",
    pol: "pl",
    swe: "sv",
    nor: "no",
    dan: "da",
    fin: "fi",
    hun: "hu",
    cze: "cs",
    ces: "cs",
    rum: "ro",
    ron: "ro",
    gre: "el",
    ell: "el",
    heb: "he",
    vie: "vi",
    tha: "th",
    ind: "id",
    may: "ms",
    all: "",
  };
  if (s === "all") return "";
  return map[s] || s;
}

function mediaType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "movie" || t === "movies") return "movie";
  if (t === "tv" || t === "series" || t === "episode" || t === "show") return "episode";
  return undefined;
}

/**
 * Search OpenSubtitles. Supports free-text `query` and/or exact ids.
 * Returns normalized rows ready for a picker UI.
 */
export async function searchOpenSubtitles({
  query,
  languages = "en",
  type,
  season,
  episode,
  tmdb_id,
  parent_tmdb_id,
  imdb_id,
  parent_imdb_id,
  year,
  page = 1,
  limit = 40,
  order_by = "download_count",
  order_direction = "desc",
} = {}) {
  const langs = String(languages || "en")
    .split(",")
    .map((l) => normalizeLang(l.trim()))
    .filter(Boolean)
    .join(",");

  const params = new URLSearchParams();
  if (query) params.set("query", String(query).trim());
  if (langs) params.set("languages", langs);
  const mt = mediaType(type);
  if (mt) params.set("type", mt);
  if (season != null && season !== "") params.set("season_number", String(season));
  if (episode != null && episode !== "") params.set("episode_number", String(episode));
  if (tmdb_id) params.set("tmdb_id", String(tmdb_id).replace(/^tt/i, ""));
  if (parent_tmdb_id) params.set("parent_tmdb_id", String(parent_tmdb_id));
  if (imdb_id) params.set("imdb_id", String(imdb_id).replace(/^tt/i, ""));
  if (parent_imdb_id) params.set("parent_imdb_id", String(parent_imdb_id).replace(/^tt/i, ""));
  if (year) params.set("year", String(year));
  params.set("page", String(Math.max(1, parseInt(page, 10) || 1)));
  if (order_by) params.set("order_by", order_by);
  if (order_direction) params.set("order_direction", order_direction);

  if (
    !params.get("query") &&
    !params.get("tmdb_id") &&
    !params.get("parent_tmdb_id") &&
    !params.get("imdb_id") &&
    !params.get("parent_imdb_id")
  ) {
    const err = new Error("Provide q/query and/or tmdb_id/imdb_id (or parent_* for TV)");
    err.status = 400;
    throw err;
  }

  const cacheKey = params.toString();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.value;

  const res = await fetch(`${API_BASE}/subtitles?${params}`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenSubtitles search failed (${res.status}): ${text.slice(0, 180)}`);
    err.status = res.status;
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("OpenSubtitles returned non-JSON");
  }

  const max = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));
  const results = [];
  for (const item of json.data || []) {
    const attrs = item.attributes || {};
    const file = attrs.files?.[0];
    if (!file?.file_id) continue;
    const lang = attrs.language || "";
    results.push({
      id: item.id,
      file_id: file.file_id,
      file_name: file.file_name || null,
      language: lang,
      language_name: attrs.language || lang,
      release: attrs.release || attrs.feature_details?.title || file.file_name || null,
      title: attrs.feature_details?.title || attrs.release || null,
      year: attrs.feature_details?.year || null,
      season: attrs.feature_details?.season_number ?? null,
      episode: attrs.feature_details?.episode_number ?? null,
      downloads: attrs.download_count || 0,
      rating: attrs.ratings ?? attrs.rating ?? null,
      hearing_impaired: !!attrs.hearing_impaired,
      ai_translated: !!attrs.ai_translated,
      machine_translated: !!attrs.machine_translated,
      fps: attrs.fps || null,
      upload_date: attrs.upload_date || null,
      url: attrs.url || null,
    });
    if (results.length >= max) break;
  }

  const value = {
    results,
    total: json.total_count ?? results.length,
    page: json.page ?? 1,
    total_pages: json.total_pages ?? 1,
  };
  searchCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function getDownloadLink(file_id) {
  const id = String(file_id);
  const hit = downloadLinkCache.get(id);
  // Official download links are short-lived; keep a brief cache only.
  if (hit && Date.now() - hit.at < 60_000) return hit.link;

  const res = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ file_id: Number(file_id) || file_id }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenSubtitles download failed (${res.status}): ${text.slice(0, 180)}`);
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(text);
  if (!json?.link) throw new Error("OpenSubtitles download link missing");
  downloadLinkCache.set(id, { at: Date.now(), link: json.link });
  return json.link;
}

/** Fetch + decode an SRT for a given OpenSubtitles file_id. */
export async function downloadOpenSubtitlesSrt(file_id) {
  const key = String(file_id);
  const cached = srtCache.get(key);
  if (cached && Date.now() - cached.at < SRT_TTL_MS) return cached.srt;

  const link = await getDownloadLink(file_id);
  const res = await fetch(link, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Subtitle file fetch failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const srt = decodeSubtitleBuffer(buf);
  srtCache.set(key, { at: Date.now(), srt });
  return srt;
}

export function opensubtitlesConfigured() {
  return Boolean(getApiKey());
}
