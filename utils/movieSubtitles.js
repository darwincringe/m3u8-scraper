import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "stream";
import { decodeSubtitleBuffer } from "./subtitleEncoding.js";

// These are YIFY/YTS subtitle mirrors (same underlying subtitle database),
// which lines up well with this scraper's sources: the streamed files are
// themselves YTS releases, so YIFY's subtitles are pre-matched to them.
// No API key required, unlike OpenSubtitles/TMDB.
const MIRRORS = ["https://yifysubtitles.ch", "https://yts-subs.com"];

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let result = "";
    stream.on("data", (chunk) => (result += chunk.toString()));
    stream.on("end", () => resolve(result));
    stream.on("error", reject);
  });
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Referer: url,
    },
  });
  if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
  return res.text();
}

// Each mirror lists a subtitle's zip either as a plain <a href=*.zip> or,
// on yts-subs.com, base64-encoded in a data-link attribute.
async function extractZipUrl(detailUrl, base) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html);

  const plainHref = $("a.download-subtitle[href$='.zip']").attr("href");
  if (plainHref) return new URL(plainHref, base).toString();

  const encoded = $("[data-link]").attr("data-link");
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");

  return null;
}

async function findEnglishSubtitlesOnMirror(base, imdb_id, limit) {
  const html = await fetchHtml(`${base}/movie-imdb/${imdb_id}`);
  const $ = cheerio.load(html);

  const candidates = [];
  $("table.other-subs tbody tr").each((_, row) => {
    const $row = $(row);
    if ($row.find(".sub-lang").text().trim().toLowerCase() !== "english") return;

    const rating = parseInt($row.find(".rating-cell .label").text().trim(), 10) || 0;
    const href = $row.find("td a[href^='/subtitles/']").attr("href");
    if (!href) return;

    candidates.push({ rating, detailUrl: new URL(href, base).toString() });
  });

  candidates.sort((a, b) => b.rating - a.rating);

  // Not every listed subtitle actually pans out (zip can 404, or the
  // archive can be missing a text subtitle entry entirely — e.g. a
  // VobSub/image-based release) so verify each candidate before trusting it,
  // same principle as the HLS mirror fallback.
  const found = [];
  for (const candidate of candidates) {
    if (found.length >= limit) break;
    const zipUrl = await extractZipUrl(candidate.detailUrl, base);
    if (!zipUrl) continue;
    try {
      await extractSrtBufferFromZip(zipUrl);
      found.push({ rating: candidate.rating, zipUrl });
    } catch (err) {
      console.error(`[movieSubtitles] candidate ${zipUrl} unusable: ${err.message}`);
    }
  }
  return found;
}

// Returns up to `limit` verified-working English subtitle candidates for
// this IMDb id, ranked by rating, e.g. [{ rating, zipUrl }, ...].
export async function findEnglishSubtitleZips(imdb_id, limit = 3) {
  for (const base of MIRRORS) {
    try {
      const found = await findEnglishSubtitlesOnMirror(base, imdb_id, limit);
      if (found.length) return found;
    } catch (err) {
      console.error(`[movieSubtitles] ${base} failed: ${err.message}`);
    }
  }
  return [];
}

// YIFY zips are inconsistently packaged: usually a .srt, but sometimes a
// .sub file that's actually SRT-formatted text (same numbered/comma-timestamp
// syntax) under a different extension. Accept either.
async function extractSrtBufferFromZip(zipUrl) {
  const res = await fetch(zipUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: zipUrl },
  });
  if (!res.ok) throw new Error(`Failed to download subtitle zip: ${res.status}`);

  const buffer = await res.buffer();
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const subtitleEntry =
    entries.find((entry) => entry.entryName.toLowerCase().endsWith(".srt")) ||
    entries.find((entry) => entry.entryName.toLowerCase().endsWith(".sub"));

  if (!subtitleEntry) throw new Error("No subtitle file found in zip");

  return subtitleEntry.getData();
}

export async function downloadZipSubtitleAsVTT(zipUrl) {
  const srtBuffer = await extractSrtBufferFromZip(zipUrl);
  const decoded = decodeSubtitleBuffer(srtBuffer);
  const vttStream = Readable.from(Buffer.from(decoded, "utf8")).pipe(srt2vtt());
  return streamToString(vttStream);
}

export async function downloadZipSubtitleAsSRT(zipUrl) {
  const srtBuffer = await extractSrtBufferFromZip(zipUrl);
  return decodeSubtitleBuffer(srtBuffer);
}
