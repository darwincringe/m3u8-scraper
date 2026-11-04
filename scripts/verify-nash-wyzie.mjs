import { readFileSync } from "fs";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const c = new MongoClient(env.MONGODB_URI);
await c.connect();
const u = await c.db().collection("users").findOne({ username: "darwinchu" });
const tok = jwt.sign(
  { uid: u._id.toString(), username: u.username },
  env.JWT_SECRET || "dev-insecure-change-me"
);
await c.close();
const headers = { Authorization: "Bearer " + tok };

const t0 = Date.now();
const j = await (
  await fetch("http://localhost:4000/extract?tmdb_id=72603&type=tv&season=1&episode=1", {
    headers,
  })
).json();
console.log("extract", Date.now() - t0 + "ms", {
  source: j.source,
  subCount: (j.subtitles || []).length,
  wyzie: (j.subtitles || []).filter((s) => /wyzie/i.test(s)).length,
  dash: /dash-hls/.test(j.hls_url || ""),
});
if (!j.hls_url) {
  console.log(j);
  process.exit(1);
}

const playlistUrl = j.hls_url.replace(/^https?:\/\/[^/]+/, "http://localhost:4000");
const sum = (body) =>
  [...body.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);

const t1 = Date.now();
let pr = await fetch(playlistUrl, { signal: AbortSignal.timeout(120000) });
let body = await pr.text();
console.log("playlist1", {
  status: pr.status,
  ms: Date.now() - t1,
  endlist: /ENDLIST/i.test(body),
  sec: Number(sum(body).toFixed(1)),
});

await new Promise((r) => setTimeout(r, 50000));
pr = await fetch(playlistUrl, { signal: AbortSignal.timeout(30000) });
body = await pr.text();
console.log("playlist2", {
  endlist: /ENDLIST/i.test(body),
  sec: Number(sum(body).toFixed(1)),
  segs: (body.match(/seg_\d+/g) || []).length,
});
console.log("tail:\n" + body.trim().split("\n").slice(-6).join("\n"));
