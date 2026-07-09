import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "stream";
import { decodeSubtitleBuffer } from "./subtitleEncoding.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//random sleep function to delay Promise resolving
function randomSleep(min = 4000, max = 6000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`⏳ Sleeping for ${delay}ms`);
  return sleep(delay);
}

// tvsubtitles.net drops connections outright fairly often (ECONNRESET,
// regardless of which step in the chain), so every request against it goes
// through this retry wrapper rather than a bare fetch.
async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`Request failed with status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }
  throw lastError;
}

// tvsubtitles.net's search form used to post to /search.php; it now posts
// to /search1.php (the old path 404s).
async function searchTVShow(title) {
  try {
    const searchRes = await fetchWithRetry("https://www.tvsubtitles.net/search1.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      body: new URLSearchParams({ qs: title }).toString(),
    });

    const html = await searchRes.text();
    const $ = cheerio.load(html);

    // Find anchor tags with href starting with '/tvshow-' and filter by text content
    const link = $("a[href^='/tvshow-']")
      .filter(function () {
        return $(this).text().toLowerCase().includes(title.toLowerCase());
      })
      .first()
      .attr("href");

    if (!link) throw new Error("No TV show found");

    const idMatch = link.match(/tvshow-(\d+)\.html/);
    if (!idMatch) throw new Error("Show ID not found");

    return idMatch[1];
  } catch (err) {
    console.error("❌ TVSubtitles Search Error:", err.message);
  }
}

// An episode page can list several English subtitle entries (different
// uploaders/releases) — return them all so the caller can fall through to
// the next one if the first's download page turns out to be broken.
async function getSubtitleCandidates(episodePageId) {
  try {
    const url = `https://www.tvsubtitles.net/episode-${episodePageId}-en.html`;
    console.log("📄 Fetching episode page:", url);

    const res = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Connection: "keep-alive",
      },
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const candidates = [];
    $("a[href^='/subtitle-']").each((_, el) => {
      const anchor = $(el);
      const subtitleId = anchor.attr("href")?.match(/subtitle-(\d+)\.html/)?.[1];
      const h5Text = anchor
        .find("h5")
        .clone()
        .find("img")
        .remove()
        .end()
        .text()
        .replace(/\s+/g, " ")
        .trim();

      if (subtitleId && h5Text) {
        candidates.push({ subtitleId, subtitleTitle: h5Text });
      }
    });

    if (!candidates.length) {
      console.warn("❌ No subtitle link found");
      return [];
    }

    console.log(
      "✅ Subtitle candidates:",
      candidates.map((c) => `${c.subtitleId}:${c.subtitleTitle}`).join(", ")
    );
    return candidates;
  } catch (err) {
    console.error("❌ Subtitle Page Scrape Error:", err.message);
    return [];
  }
}

// Function to return episode page Id from TV Show page
async function getEpisodePageId(showId, seasonNumber, episodeNumber) {
  try {
    const url = `https://www.tvsubtitles.net/tvshow-${showId}-${seasonNumber}.html`;
    const res = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Connection: "keep-alive",
      },
    });

    const html = await res.text();
    const $ = cheerio.load(html);

    let episodePageId = null;

    $("table.tableauto tr").each((_, row) => {
      const episodeCell = $(row).find("td").first().text().trim();
      const episodeMatch = episodeCell.match(/^(\d+)x(\d+)$/);

      if (
        episodeMatch &&
        parseInt(episodeMatch[1]) === parseInt(seasonNumber) &&
        parseInt(episodeMatch[2]) === parseInt(episodeNumber)
      ) {
        console.log(
          `✅ Match found for episode ${seasonNumber}x${episodeNumber}`
        );

        const episodeLink = $(row).find("td").eq(1).find("a").attr("href");
        const episodeMatch = episodeLink?.match(/episode-(\d+)\.html/);
        if (episodeMatch) {
          episodePageId = episodeMatch[1];
          console.log(`🎯 Episode Page ID: ${episodePageId}`);
        }
      }
    });

    if (!episodePageId) {
      throw new Error("Episode Page ID not found");
    }

    return episodePageId;
  } catch (err) {
    console.error("❌ TVSubtitles Season Scrape Error:", err.message);
    return null;
  }
}

// The download-N.html page doesn't link straight to the zip — it's a
// timed JS redirect that assembles the real path from several string
// literals in document order (e.g. 'fil' + 'es/T' + 'he' + ' Office_1x05_en.zip'),
// presumably to make the file URL harder to scrape/guess directly. This
// replaces the old approach of guessing the zip filename from the listing
// title, which broke whenever a listing had no "(RELEASE)" tag to work
// from — this reads the real path straight from the source instead.
async function resolveZipUrlFromDownloadPage(subtitleId) {
  try {
    const url = `https://www.tvsubtitles.net/download-${subtitleId}.html`;
    const res = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: `https://www.tvsubtitles.net/subtitle-${subtitleId}.html`,
      },
    });
    const html = await res.text();

    const parts = [...html.matchAll(/var\s+s\d+\s*=\s*'([^']*)'/g)].map((m) => m[1]);
    if (!parts.length) return null;

    const relativePath = parts.join("").replace(/^\/+/, "");
    return `https://www.tvsubtitles.net/${relativePath}`;
  } catch (err) {
    console.error(`❌ Download page fetch failed: ${err.message}`);
    return null;
  }
}

// Utility to convert buffer to string
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let result = "";
    stream.on("data", (chunk) => (result += chunk.toString()));
    stream.on("end", () => resolve(result));
    stream.on("error", reject);
  });
}

// Callers (e.g. the vaplayer scrape) hand us titles like "The Office (US)
// 2005" — tvsubtitles.net's own listings are just "The Office", so a
// trailing year/parenthetical tag makes the substring match in
// searchTVShow() fail.
function cleanShowTitle(title) {
  return title
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(19|20)\d{2}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function downloadZipToSrtBuffer(zipUrl) {
  const zipRes = await fetchWithRetry(zipUrl);
  const zipBuffer = await zipRes.buffer();
  const zip = new AdmZip(zipBuffer);
  const srtEntry = zip
    .getEntries()
    .find((entry) => entry.entryName.endsWith(".srt"));

  if (!srtEntry) throw new Error("No .srt file found in ZIP");

  return srtEntry.getData();
}

// Function to download and convert .srt file and return .vtt content using the zipUrl
async function downloadAndConvertToVTT(zipUrl) {
  try {
    const srtBuffer = await downloadZipToSrtBuffer(zipUrl);
    const decoded = decodeSubtitleBuffer(srtBuffer);
    const vttStream = Readable.from(Buffer.from(decoded, "utf8")).pipe(srt2vtt());
    const vttText = await streamToString(vttStream);

    console.log("✅ Converted VTT:\n");
    console.log(vttText.slice(0, 500)); // show first 500 characters for preview
    return vttText;
  } catch (err) {
    console.error("❌ Conversion error:", err.message);
    return null;
  }
}

async function isZipUrlReachable(zipUrl) {
  try {
    await fetchWithRetry(zipUrl, { method: "HEAD" }, 2);
    return true;
  } catch {
    return false;
  }
}

async function resolveTVSubtitleZipUrl(title, season, episode) {
  const showId = await searchTVShow(cleanShowTitle(title));
  if (!showId) return null;
  await randomSleep();
  const episodeId = await getEpisodePageId(showId, season, episode);
  if (!episodeId) return null;
  await randomSleep();

  const candidates = await getSubtitleCandidates(episodeId);
  if (!candidates.length) return null;

  // A listing's download page can occasionally be broken/removed even
  // though it's listed — fall through to the next candidate if so.
  for (const { subtitleId } of candidates) {
    await randomSleep();
    const zipUrl = await resolveZipUrlFromDownloadPage(subtitleId);
    if (!zipUrl) continue;
    console.log("📦 Trying Zip URL:", zipUrl);

    if (await isZipUrlReachable(zipUrl)) return zipUrl;
    console.warn(`⚠️ Candidate zip unreachable, trying next: ${zipUrl}`);
  }

  return null;
}

export async function getTVSubtitleVTT(title, season, episode) {
  try {
    const zipUrl = await resolveTVSubtitleZipUrl(title, season, episode);
    if (!zipUrl) return null;
    return await downloadAndConvertToVTT(zipUrl);
  } catch (err) {
    console.error("❌ getTVSubtitleVTT failed:", err.message);
    return null;
  }
}

export async function getTVSubtitleSRT(title, season, episode) {
  try {
    const zipUrl = await resolveTVSubtitleZipUrl(title, season, episode);
    if (!zipUrl) return null;
    const srtBuffer = await downloadZipToSrtBuffer(zipUrl);
    return decodeSubtitleBuffer(srtBuffer);
  } catch (err) {
    console.error("❌ getTVSubtitleSRT failed:", err.message);
    return null;
  }
}
