import fs from "fs";
import { spawn } from "child_process";
import { fetchMovyStreams, NASHVILLE_CITY } from "../utils/wecollege.js";

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
fs.writeFileSync("/tmp/nash-url.txt", url);
const r = await fetch(url, {
  headers: { Referer: "https://www.movy.sx/", Origin: "https://www.movy.sx/" },
});
const mpd = await r.text();
console.log("status", r.status, "dur", (mpd.match(/mediaPresentationDuration="([^"]+)/) || [])[1]);
console.log("urlEnd", url.slice(-20));

fs.rmSync("/tmp/srctv-dashhls-test", { recursive: true, force: true });
fs.mkdirSync("/tmp/srctv-dashhls-test", { recursive: true });

const args = [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-y",
  "-referer",
  "https://www.movy.sx/",
  "-user_agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
  "-crf",
  "28",
  "-vf",
  "scale=-2:'min(720,ih)'",
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-b:a",
  "128k",
  "-f",
  "hls",
  "-hls_time",
  "4",
  "-hls_list_size",
  "0",
  "-hls_flags",
  "independent_segments",
  "-hls_segment_filename",
  "/tmp/srctv-dashhls-test/seg_%04d.ts",
  "/tmp/srctv-dashhls-test/index.m3u8",
];

console.log("starting ffmpeg for 60s sample...");
const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
let err = "";
child.stderr.on("data", (c) => {
  err += c.toString();
  if (err.length > 8000) err = err.slice(-8000);
});
const t0 = Date.now();
await new Promise((resolve) => {
  const timer = setTimeout(() => {
    console.log("timeout kill");
    child.kill("SIGKILL");
  }, 60000);
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    console.log("exit", { code, signal, ms: Date.now() - t0 });
    resolve();
  });
});
const files = fs.readdirSync("/tmp/srctv-dashhls-test");
console.log("files", files.length, files.slice(0, 10));
if (fs.existsSync("/tmp/srctv-dashhls-test/index.m3u8")) {
  const pl = fs.readFileSync("/tmp/srctv-dashhls-test/index.m3u8", "utf8");
  console.log("playlist tail:\n" + pl.trim().split("\n").slice(-12).join("\n"));
  const dur = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  console.log("sum EXTINF", dur.toFixed(1), "s");
}
console.log("stderr tail:\n" + err.trim().slice(-1500));
