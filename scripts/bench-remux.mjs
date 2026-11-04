import { spawn } from "child_process";
import fs from "fs";
import { fetchMovyStreams, NASHVILLE_CITY } from "../utils/wecollege.js";

fs.rmSync("/tmp/bench-ts", { recursive: true, force: true });
fs.rmSync("/tmp/bench-nash", { recursive: true, force: true });
fs.mkdirSync("/tmp/bench-ts", { recursive: true });
fs.mkdirSync("/tmp/bench-nash", { recursive: true });

// 1) fMP4 copy remux speed using a movy master from Breaking Bad if possible
const movyUrl = process.argv[2];
if (movyUrl) {
  console.log("TS-copy remux", movyUrl.slice(0, 80));
  const t0 = Date.now();
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-referer",
      "https://www.movy.sx/",
      "-user_agent",
      "Mozilla/5.0",
      "-i",
      movyUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_segment_type",
      "mpegts",
      "-hls_playlist_type",
      "vod",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      "/tmp/bench-ts/seg_%04d.ts",
      "/tmp/bench-ts/index.m3u8",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((r) => child.on("exit", r));
  const pl = fs.existsSync("/tmp/bench-ts/index.m3u8")
    ? fs.readFileSync("/tmp/bench-ts/index.m3u8", "utf8")
    : "";
  const dur = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  console.log({
    code,
    wall: ((Date.now() - t0) / 1000).toFixed(1) + "s",
    content: dur.toFixed(1) + "s",
    speed: dur > 0 ? (dur / ((Date.now() - t0) / 1000)).toFixed(2) + "x" : "n/a",
    segs: (pl.match(/seg_/g) || []).length,
    err: err.toString().slice(-300),
  });
}

// 2) Nashville 480p encode speed for 90 wall seconds
const meta = {
  title: "The Flame's Daughter",
  altTitle: "烈火如歌",
  year: 2018,
  imdbId: "tt6912356",
  totalSeasons: 1,
};
const nash = await fetchMovyStreams("tv", 72603, 1, 1, meta, 25000, {
  cities: [NASHVILLE_CITY],
});
const url = nash.streams[0].url;
console.log("\nNashville 480p encode sample 90s wall...");
const t1 = Date.now();
const child2 = spawn(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-referer",
    "https://www.movy.sx/",
    "-user_agent",
    "Mozilla/5.0",
    "-i",
    url,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "fastdecode",
    "-crf",
    "32",
    "-vf",
    "scale=-2:480,fps=24",
    "-g",
    "48",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "96k",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "omit_endlist",
    "-hls_segment_filename",
    "/tmp/bench-nash/seg_%04d.ts",
    "/tmp/bench-nash/index.m3u8",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let err2 = "";
child2.stderr.on("data", (c) => (err2 += c));
await new Promise((r) => setTimeout(() => {
  child2.kill("SIGKILL");
  r();
}, 90000));
await new Promise((r) => child2.on("exit", r));
const pl2 = fs.existsSync("/tmp/bench-nash/index.m3u8")
  ? fs.readFileSync("/tmp/bench-nash/index.m3u8", "utf8")
  : "";
const dur2 = [...pl2.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
const wall = (Date.now() - t1) / 1000;
console.log({
  wall: wall.toFixed(1) + "s",
  content: dur2.toFixed(1) + "s",
  speed: dur2 > 0 ? (dur2 / wall).toFixed(2) + "x" : "n/a",
  segs: (pl2.match(/seg_/g) || []).length,
  err: err2.toString().slice(-300),
});
