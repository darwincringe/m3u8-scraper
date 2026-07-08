import express, { json } from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";
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

    const subtitles = Array.isArray(json.default_subs)
      ? json.default_subs
          .map((s) => (typeof s === "string" ? s : s?.url))
          .filter(Boolean)
      : [];

    return { hls_url: streamUrls[0], subtitles, error: null };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
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
    const upstream = await fetch(target, {
      headers: { Referer: "https://nextgencloudfabric.com/" },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send("Upstream fetch failed");
    }

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

    const response = {
      success: !!result.hls_url,
      hls_url: proxiedHlsUrl,
      subtitles: result.subtitles,
      error: result.error,
    };

    if (response.success) {
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
