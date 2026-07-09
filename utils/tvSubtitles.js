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

// Function to build Zip url from title
function buildZipUrlFromTitle(title) {
  // 1. Remove parentheses
  console.log("Title: " + title);
  const clean = title.replace(/[()]/g, "").trim();
  console.log("Cleaned Title: " + clean);

  // 2. Use regex to split the title into showName, episode, and release
  const match = clean.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);
  if (!match) {
    console.warn("⚠️ Unexpected title format. Using fallback.");
    const fallback = clean.replace(/\s+/g, "_") + ".en.zip";
    return `https://www.tvsubtitles.net/files/${fallback}`;
  }

  const [showTitle, showName, episodeCode, releaseInfo] = match;
  console.log("Show Title", showTitle);
  console.log("Show Name", showName);
  console.log("Episode Code", episodeCode);
  console.log("Release info", releaseInfo);

  const fileName = `${showName}_${episodeCode}_${releaseInfo}.en.zip`;

  // 3. Return encoded full URL
  return `https://www.tvsubtitles.net/files/${encodeURIComponent(fileName)}`;
}

// tvsubtitles.net's search form used to post to /search.php; it now posts
// to /search1.php (the old path 404s).
async function searchTVShow(title) {
  try {
    const searchRes = await fetch("https://www.tvsubtitles.net/search1.php", {
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
// uploaders/releases). Picking only the first one is unreliable: a listing
// with no "(RELEASE)" tag in its title (e.g. "The Office 1x01") doesn't
// match buildZipUrlFromTitle's expected "name NxE release" shape, so the
// guessed .zip 404s even though a same-episode entry with a release tag
// (e.g. "The Office 1x01 (HDTV)") would have worked. Return every
// candidate, tag-bearing ones first, so the caller can try each in turn.
async function getSubtitleCandidates(episodePageId) {
  try {
    const url = `https://www.tvsubtitles.net/episode-${episodePageId}-en.html`;
    console.log("📄 Fetching episode page:", url);

    const res = await fetch(url, {
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

    candidates.sort((a, b) => {
      const aHasTag = /\([^)]+\)/.test(a.subtitleTitle) ? 1 : 0;
      const bHasTag = /\([^)]+\)/.test(b.subtitleTitle) ? 1 : 0;
      return bHasTag - aHasTag;
    });

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
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Connection: "keep-alive",
      },
    });

    if (!res.ok) throw new Error("Failed to fetch season page");

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

// Function to return subtitle download link from Subtitle Page (Optional)
async function getActualFilenameFromSubtitlePage(subtitleId) {
  try {
    const url = `https://www.tvsubtitles.net/subtitle-${subtitleId}.html`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Connection: "keep-alive",
      },
    });

    if (!res.ok) throw new Error("Failed to fetch subtitle page");

    const html = await res.text();
    const $ = cheerio.load(html);

    let filename = null;

    $(".subtitle_grid div").each((i, el) => {
      const label = $(el).text().trim().toLowerCase();
      if (label === "filename:") {
        const value = $(el).next().text().trim();
        filename = value;
      }
    });

    if (!filename) {
      console.warn("⚠️ Could not find filename on subtitle page");
      return null;
    }

    return filename;
  } catch (err) {
    console.error("❌ Subtitle Download Page Scrape Error:", err.message);
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

// New helper to extract release part from filename
function extractReleaseFromFilename(filename) {
  const hyphenParts = filename.split(" - ");
  const lastPart = hyphenParts[2] || "";

  // Remove .en.srt or .srt
  const noExt = lastPart.replace(/\.en\.srt$|\.srt$/, "").trim();

  const parts = noExt.split(".");
  const hasResolution = parts.some((p) => /\d{3,4}p/.test(p));

  if (hasResolution) {
    // e.g. 720p HDTV.LOL
    const resIndex = parts.findIndex((p) => /\d{3,4}p/.test(p));
    const releaseParts = parts.slice(resIndex);
    const [res, rip, group] = releaseParts;

    if (group) return `${res} ${rip}.${group}`;
    if (rip) return `${res} ${rip}`;
    return res;
  } else {
    // No resolution
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];

    if (secondLast && secondLast !== last) {
      return `${secondLast}.${last}`;
    } else {
      return last; // e.g. "WEB"
    }
  }
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
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error("Failed to download subtitle ZIP");

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
    const res = await fetch(zipUrl, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function buildZipUrlForCandidate(subtitleId, subtitleTitle) {
  const actualFilename = await getActualFilenameFromSubtitlePage(subtitleId);
  let finalTitle = subtitleTitle;

  if (actualFilename) {
    const correctRelease = extractReleaseFromFilename(actualFilename);

    const match = subtitleTitle.match(/\(([^)]+)\)/);
    const currentRelease = match ? match[1] : null;

    if (currentRelease) {
      if (currentRelease.includes(".") || currentRelease.includes(" ")) {
        if (currentRelease !== correctRelease) {
          console.log(
            `🔁 Replacing incorrect release: (${currentRelease}) ➡ ${correctRelease}`
          );
          finalTitle = subtitleTitle.replace(
            /\([^)]+\)/,
            `(${correctRelease})`
          );
        } else {
          finalTitle = subtitleTitle;
        }
      } else {
        // Single word release (like "WEB") — replace regardless
        finalTitle = subtitleTitle.replace(/\([^)]+\)/, `(${currentRelease})`);
      }
    }
  }

  return buildZipUrlFromTitle(finalTitle);
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

  // Not every listing's title yields a real .zip (some lack a "(RELEASE)"
  // tag, which makes the guessed filename wrong) — verify each candidate
  // and fall through to the next until one actually exists.
  for (const { subtitleId, subtitleTitle } of candidates) {
    await randomSleep();
    const zipUrl = await buildZipUrlForCandidate(subtitleId, subtitleTitle);
    await randomSleep();
    console.log("📦 Trying Zip URL:", zipUrl);

    if (await isZipUrlReachable(zipUrl)) return zipUrl;
    console.warn(`⚠️ Candidate zip unreachable, trying next: ${zipUrl}`);
  }

  return null;
}

export async function getTVSubtitleVTT(title, season, episode) {
  const zipUrl = await resolveTVSubtitleZipUrl(title, season, episode);
  if (!zipUrl) return null;
  return await downloadAndConvertToVTT(zipUrl);
}

export async function getTVSubtitleSRT(title, season, episode) {
  const zipUrl = await resolveTVSubtitleZipUrl(title, season, episode);
  if (!zipUrl) return null;
  try {
    const srtBuffer = await downloadZipToSrtBuffer(zipUrl);
    return decodeSubtitleBuffer(srtBuffer);
  } catch (err) {
    console.error("❌ SRT extraction error:", err.message);
    return null;
  }
}
