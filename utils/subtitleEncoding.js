// Bytes 0x80-0x9F differ between Windows-1252 and Latin-1/UTF-8 continuation
// bytes; these are the ones that show up in subtitle files (smart quotes,
// em dashes, ellipsis).
const CP1252_EXTRA = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeWindows1252(buffer) {
  let out = "";
  for (const byte of buffer) {
    out += CP1252_EXTRA[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

// Subtitle files scraped from YIFY/tvsubtitles are a mix of UTF-8 and legacy
// Windows-1252. Decoding cp1252 bytes as UTF-8 corrupts smart quotes/dashes
// into U+FFFD replacement characters — prefer UTF-8, fall back to cp1252
// only when the UTF-8 decode is clearly invalid.
export function decodeSubtitleBuffer(buffer) {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("�") ? decodeWindows1252(buffer) : utf8;
}
