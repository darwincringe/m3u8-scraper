// "Catflix" stream source, as used by the vidnest.fun embed (one of the
// six players hurawatch.cz iframes). It consistently exposes a 1920x1080
// rendition where vaplayer.ru tops out at 720p for the same file.
//
// vidnest's frontend calls https://new.vidnest.fun/yflix/{movie|tv}/... and
// gets back {"data": "<blob>", "encrypted": true}. The "encryption" is just
// base64 with a shuffled alphabet, reproduced here from their bundle. The
// decoded JSON is {url, headers} where url is an HLS master playlist (usually
// proxied through pwcloud.animanga.fun/hls/<base64 upstream>/master.m3u8).
import fetch from "node-fetch";

const API_BASE = "https://new.vidnest.fun";
const CIPHER_ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

const CIPHER_TO_STD = new Map([...CIPHER_ALPHABET].map((ch, i) => [ch, STD_ALPHABET[i]]));

export function decodeVidnestCipher(blob) {
  let std = "";
  for (const ch of blob) std += CIPHER_TO_STD.get(ch) ?? ch;
  while (std.length % 4) std += "=";
  return Buffer.from(std, "base64").toString("utf8");
}

// Returns { url, headers } or null when the source has nothing for this
// title. Network/parse errors are thrown so the caller can log them.
export async function fetchCatflixStream(type, tmdb_id, season, episode, timeoutMs = 8000) {
  const path =
    type === "tv"
      ? `/yflix/tv/${tmdb_id}/${season}/${episode}`
      : `/yflix/movie/${tmdb_id}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Referer: "https://vidnest.fun/",
        Origin: "https://vidnest.fun",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`catflix API returned ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(timeout);
  }

  let payload = json;
  if (json?.encrypted) {
    if (typeof json.data !== "string") throw new Error("catflix response missing data");
    const decoded = decodeVidnestCipher(json.data);
    try {
      payload = JSON.parse(decoded);
    } catch {
      payload = { url: decoded };
    }
  }

  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, headers: payload.headers || {} };
}
