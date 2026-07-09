import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { decodeSubtitleBuffer } from "./subtitleEncoding.js";

// Not using the `addic7ed-api` npm package here: its HTML regexes were
// written against an older addic7ed.com markup (looking for `<strong>` tags
// around "Download" that no longer exist) and it silently returns an empty
// list against the current site. This is a from-scratch cheerio scraper
// against the current markup.

const BASE_URL = "https://www.addic7ed.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.181 Safari/537.36",
};

function pad(n) {
  const i = parseInt(n, 10);
  return i < 10 ? `0${i}` : `${i}`;
}

// vaplayer titles carry region/year tags addic7ed doesn't search on
// ("The Office (US) 2005") — but addic7ed itself lists region variants
// side by side ("The Office (UK)" vs "The Office (US)") with no built-in
// disambiguation between search hits, so blindly taking the first result
// can silently serve the wrong show. Pull out any "(TAG)" qualifier so we
// can require episode links to carry the same tag.
function extractRegionTag(title) {
  const match = title.match(/\(([^)]+)\)/);
  return match ? match[1].trim().toLowerCase() : null;
}

function stripNonSearchTerms(title) {
  return title
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(19|20)\d{2}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeShowSegment(segment) {
  return decodeURIComponent(segment).replace(/_/g, " ");
}

// addic7ed intermittently returns transient non-200s (304, 503) under
// automated traffic — retry a couple of times before giving up.
async function fetchHtml(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res.text();
      lastError = new Error(`addic7ed request failed: ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastError;
}

async function resolveEpisodePage(showTitle, season, episode) {
  const regionTag = extractRegionTag(showTitle);
  const cleanTitle = stripNonSearchTerms(showTitle);
  const searchTerm = `${cleanTitle} ${pad(season)} ${pad(episode)}`;
  const searchUrl = `${BASE_URL}/srch.php?search=${encodeURIComponent(searchTerm)}&Submit=Search`;

  const html = await fetchHtml(searchUrl);

  // A single exact match redirects straight to the episode page instead of
  // a results listing — detect that by the absence of a "results found"
  // banner and parse this page directly.
  if (!/\d+\s*results found/i.test(html)) {
    return html;
  }

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);
  const hrefPattern = new RegExp(`^/?serie/([^/]+)/${seasonNum}/${episodeNum}/`);

  const $ = cheerio.load(html);
  const candidates = [];
  $("a[href^='serie/'], a[href^='/serie/']").each((_, el) => {
    const href = $(el).attr("href");
    const match = href && href.match(hrefPattern);
    if (match) candidates.push({ href, showSegment: match[1] });
  });

  if (!candidates.length) return null;

  let chosen = candidates[0];
  if (regionTag) {
    const tagged = candidates.find((c) =>
      decodeShowSegment(c.showSegment).toLowerCase().includes(`(${regionTag})`)
    );
    if (tagged) chosen = tagged;
  }

  const episodeUrl = chosen.href.startsWith("/") ? `${BASE_URL}${chosen.href}` : `${BASE_URL}/${chosen.href}`;
  return fetchHtml(episodeUrl);
}

function parseEnglishSubtitles(html) {
  const $ = cheerio.load(html);
  const rows = $("tr").toArray();

  let currentVersion = "UNKNOWN";
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const $row = $(rows[i]);
    const rowText = $row.text().trim();

    if (/^Version\s/.test(rowText)) {
      currentVersion = rowText.replace(/^Version\s*/, "").split(",")[0].trim();
      continue;
    }

    const $langCell = $row.find("td.language");
    if (!$langCell.length) continue;

    const language = $langCell.clone().children("a").remove().end().text().trim();
    if (language.toLowerCase() !== "english") continue;

    const statusText = $row.find("td b").first().text().trim();
    if (!/completed/i.test(statusText)) continue;

    const href = $row.find("a.face-button").attr("href");
    if (!href) continue;

    const statsText = $(rows[i + 1]).text();
    const downloadsMatch = statsText.match(/([\d,]+)\s*Downloads/);
    const downloads = downloadsMatch ? parseInt(downloadsMatch[1].replace(/,/g, ""), 10) : 0;

    results.push({
      version: currentVersion,
      downloadUrl: `${BASE_URL}${href}`,
      downloads,
    });
  }

  return results.sort((a, b) => b.downloads - a.downloads);
}

// Returns up to `limit` English subtitle candidates for an episode, ranked
// by download count, e.g. [{ version: "LOL", downloadUrl, downloads }, ...]
export async function findTVSubtitleCandidates(showTitle, season, episode, limit = 3) {
  const html = await resolveEpisodePage(showTitle, season, episode);
  if (!html) return [];
  return parseEnglishSubtitles(html).slice(0, limit);
}

export async function downloadSubtitleSRT(downloadUrl) {
  const res = await fetch(downloadUrl, {
    headers: { ...HEADERS, Referer: BASE_URL },
  });
  if (!res.ok) throw new Error(`Failed to download subtitle: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return decodeSubtitleBuffer(buffer);
}
