// Some anime episodes on Wyzie/OpenSubtitles only have English subs in
// Advanced SubStation Alpha (.ass/.ssa) format, not .srt. Rather than
// discarding those candidates, convert them to SRT so the same
// wyzie-subtitle-srt proxy/player pipeline can serve them.

function parseAssTimestamp(ts) {
  // H:MM:SS.cs (centiseconds, 2 digits)
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(ts.trim());
  if (!match) return null;
  const [, h, m, s, cs] = match;
  return {
    ms:
      Number(h) * 3600000 +
      Number(m) * 60000 +
      Number(s) * 1000 +
      Number(cs) * 10,
  }.ms;
}

function msToSrtTimestamp(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

// Strips ASS override blocks ({\...}), drawing commands, and converts
// line-break tags to real newlines.
function cleanAssText(text) {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

// Detects ASS/SSA content by its distinctive section headers rather than
// trusting the reported format, since mislabeling happens in the wild.
export function isAssFormat(text) {
  return /^﻿?\[Script Info\]/m.test(text) || /^\[V4\+? ?Styles\]/m.test(text);
}

export function convertAssToSrt(text) {
  const lines = text.split(/\r?\n/);

  let inEvents = false;
  let formatFields = null;
  const dialogues = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[Events\]/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;

    if (/^Format:/i.test(trimmed)) {
      formatFields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed) || !formatFields) continue;

    const body = trimmed.slice(trimmed.indexOf(":") + 1);
    const parts = body.split(",");
    const textIndex = formatFields.indexOf("text");
    if (textIndex === -1 || parts.length <= textIndex) continue;

    const startIndex = formatFields.indexOf("start");
    const endIndex = formatFields.indexOf("end");
    const start = parseAssTimestamp(parts[startIndex]);
    const end = parseAssTimestamp(parts[endIndex]);
    if (start == null || end == null) continue;

    const rawText = parts.slice(textIndex).join(",");
    const text = cleanAssText(rawText);
    if (!text) continue;

    dialogues.push({ start, end, text });
  }

  dialogues.sort((a, b) => a.start - b.start);

  return dialogues
    .map(
      (d, i) =>
        `${i + 1}\n${msToSrtTimestamp(d.start)} --> ${msToSrtTimestamp(d.end)}\n${d.text}\n`
    )
    .join("\n");
}
