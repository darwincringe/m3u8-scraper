// Order matters: more specific tags must come before generic ones they'd
// otherwise be swallowed by (e.g. "WEB-DL" before "WEB").
const KNOWN_TAGS = [
  "BLURAY",
  "BRRIP",
  "BDRIP",
  "AMZN",
  "NF",
  "HULU",
  "WEB-DL",
  "WEBDL",
  "WEBRIP",
  "WEB",
  "HDRIP",
  "HDTV",
  "DVDRIP",
  "DVD-RIP",
  "CAM",
  "R5",
];

// Pulls a normalized source/quality tag (BLURAY, WEBRIP, HDTV, ...) out of a
// free-form release/version string like "John.Wick.2014.720p.BluRay.x264"
// or addic7ed's "AMZN.WEB-DL" version label. Returns "UNKNOWN" if none of
// the known tags appear.
export function extractReleaseTag(text) {
  if (!text) return "UNKNOWN";
  const normalized = text.toUpperCase();
  for (const tag of KNOWN_TAGS) {
    if (normalized.includes(tag)) return tag;
  }
  return "UNKNOWN";
}
