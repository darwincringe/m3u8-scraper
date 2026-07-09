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
  downloadWyzieSubtitleSRT,
} from "./utils/wyzieSubtitles.js";
dotenv.config();

const app = express();
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

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Simple in-memory cache to avoid re-fetching same query repeatedly (15 minutes)
const cache = new Map();

// The CDN mirrors vaplayer.ru hands out are short-lived and occasionally
// dead on arrival, so we can't trust stream_urls[0] blindly — probe each
// candidate and use the first one that actually responds.
async function pickReachableStreamUrl(streamUrls, timeoutMs = 5000) {
  for (const url of streamUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Referer: "https://nextgencloudfabric.com/" },
        signal: controller.signal,
      });
      if (res.ok) return url;
    } catch {
      // unreachable, try the next mirror
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
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
    const res = await fetch(apiUrl, {
      headers: {
        Referer: "https://nextgencloudfabric.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) throw new Error(`streamdata API returned ${res.status}`);

    const json = await res.json();
    const streamUrls = json?.data?.stream_urls;

    if (!Array.isArray(streamUrls) || streamUrls.length === 0) {
      throw new Error("No stream URLs returned");
    }

    const workingUrl = await pickReachableStreamUrl(streamUrls);
    if (!workingUrl) {
      throw new Error("All stream mirrors are unreachable");
    }

    const subtitles = Array.isArray(json.default_subs)
      ? json.default_subs
          .map((s) => (typeof s === "string" ? s : s?.url))
          .filter(Boolean)
      : [];

    return {
      hls_url: workingUrl,
      subtitles,
      imdb_id: json?.data?.imdb_id || null,
      title: json?.data?.title || null,
      error: null,
    };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return {
      hls_url: null,
      subtitles: [],
      imdb_id: null,
      title: null,
      error: error.message,
    };
  }
}

// Some CDN mirrors (e.g. startupscalingsystem.website) intermittently drop
// connections on individual segment requests. Retry a couple of times
// before giving up, since one dropped connection shouldn't kill playback.
async function fetchUpstreamWithRetry(target, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const upstream = await fetch(target, {
        headers: { Referer: "https://nextgencloudfabric.com/" },
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

// vaplayer.ru's CDN mislabels media segments as Content-Type: text/html
// (anti-hotlink obfuscation) and sends a spec-invalid CORS header combo
// (Allow-Credentials: true + Allow-Origin: *) on them, which browsers
// reject whenever a player sends credentials. This proxy re-serves the
// manifest chain and segments from our own origin with correct headers
// so any player can consume them.
app.get("/hls-proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url param");

  try {
    const upstream = await fetchUpstreamWithRetry(target);

    const buf = Buffer.from(await upstream.arrayBuffer());

    if (buf.toString("utf8", 0, 7) === "#EXTM3U") {
      const baseUrl = new URL(target);
      const rewritten = buf
        .toString("utf8")
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          const absoluteUrl = new URL(trimmed, baseUrl).toString();
          return `/hls-proxy?url=${encodeURIComponent(absoluteUrl)}`;
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // Media segment: force the correct MIME type regardless of what the
    // upstream CDN claims.
    res.setHeader("Content-Type", "video/mp2t");
    res.send(buf);
  } catch (err) {
    console.error("[hls-proxy] Error:", err.message);
    res.status(500).send("Proxy error");
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
      subtitles: [],
    });
  }

  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({
      success: false,
      error: "season and episode query params are required for TV shows",
      hls_url: null,
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
    const result = await scrapeVaplayerAPI(type, tmdb_id, season, episode);
    const proxiedHlsUrl = result.hls_url
      ? `${req.protocol}://${req.get("host")}/hls-proxy?url=${encodeURIComponent(result.hls_url)}`
      : null;

    let subtitles = result.subtitles;
    let subtitleLookupFailed = false;
    if (type === "movie" && subtitles.length === 0 && result.imdb_id) {
      try {
        const candidates = await findEnglishSubtitleZips(result.imdb_id, 10);
        subtitles = candidates.map(
          ({ zipUrl, release }) =>
            `${req.protocol}://${req.get("host")}/movie-subtitle-srt?url=${encodeURIComponent(zipUrl)}&release=${encodeURIComponent(release)}`
        );
      } catch (err) {
        console.error("[extract] YIFY subtitle fallback failed:", err.message);
        subtitleLookupFailed = true;
      }
    } else if (type === "tv" && subtitles.length === 0) {
      // Primary TV source: Wyzie (series-only). Keyed on tmdb_id (always
      // present) and internally cached for 24h, so popular episodes are
      // looked up from Wyzie's API at most once a day — keeping us under the
      // account's 1000 requests/day cap even across many viewers and
      // back-navigation.
      try {
        const wyzieCandidates = await findWyzieTVSubtitleCandidates(tmdb_id, season, episode, 10);
        subtitles = wyzieCandidates.map(
          ({ downloadUrl, release }) =>
            `${req.protocol}://${req.get("host")}/wyzie-subtitle-srt?url=${encodeURIComponent(downloadUrl)}&release=${encodeURIComponent(release)}`
        );
      } catch (err) {
        console.error("[extract] Wyzie subtitle lookup failed:", err.message);
      }

      // Fall back to the addic7ed scraper only if Wyzie found nothing.
      let addic7edFailed = false;
      if (subtitles.length === 0 && result.title) {
        try {
          const candidates = await findTVSubtitleCandidates(result.title, season, episode, 10);
          subtitles = candidates.map(
            ({ downloadUrl, release }) =>
              `${req.protocol}://${req.get("host")}/tv-subtitle-srt?url=${encodeURIComponent(downloadUrl)}&release=${encodeURIComponent(release)}`
          );
        } catch (err) {
          console.error("[extract] addic7ed subtitle fallback failed:", err.message);
          addic7edFailed = true;
        }
      }

      // addic7ed is a single third-party site and occasionally rate-limits
      // us outright (503s on every search, even unrelated ones) — fall back
      // to the tvsubtitles.net scraper so a single site being down doesn't
      // mean zero subtitles. That chain takes 30-90s (deliberate anti-bot
      // delays plus a slow site), far too long to resolve inline here, so
      // this is a lazy, unverified URL — resolved only when actually
      // requested, same tradeoff the original tvsubtitles.net-only design
      // accepted.
      if (subtitles.length === 0 && addic7edFailed) {
        subtitles = [
          `${req.protocol}://${req.get("host")}/tv-subtitle-srt-fallback?title=${encodeURIComponent(result.title)}&season=${season}&episode=${episode}`,
        ];
      }
    }

    const response = {
      success: !!result.hls_url,
      hls_url: proxiedHlsUrl,
      subtitles,
      error: result.error,
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
  res.send(
    "🎬 VidSrc Scraper API is running. Visit /subtitles or /extract to use."
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
