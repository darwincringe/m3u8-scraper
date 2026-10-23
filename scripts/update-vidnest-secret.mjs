#!/usr/bin/env node
/**
 * Pull the current vidnest v2 AES secret from their player JS and
 * optionally write it into utils/catflix.js.
 *
 * Usage:
 *   node scripts/update-vidnest-secret.mjs              # find + test only
 *   node scripts/update-vidnest-secret.mjs --apply      # patch utils/catflix.js
 *   node scripts/update-vidnest-secret.mjs --env-apply  # write VIDNEST_SECRET into .env
 *                                                      # (preferred for cron; no git dirty)
 *
 * Cron on prod should use --env-apply, then restart PM2 if the script prints
 * "UPDATED .env". See readme.md.
 *
 * Optional env for the decrypt smoke-test through our relay:
 *   CATFLIX_RELAY / CATFLIX_RELAY_KEY  (same as the API server)
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATFLIX = path.join(ROOT, "utils", "catflix.js");
const ENV_PATH = path.join(ROOT, ".env");
const APPLY = process.argv.includes("--apply");
const ENV_APPLY = process.argv.includes("--env-apply");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Referer: "https://vidnest.fun/movie/550", Accept: "*/*" };

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function currentSecretInRepo() {
  const src = fs.readFileSync(CATFLIX, "utf8");
  const m =
    /VIDNEST_SECRET \|\| "([^"]+)"/.exec(src) ||
    /V2_SECRET = process\.env\.VIDNEST_SECRET \|\| "([^"]+)"/.exec(src);
  return m?.[1] || null;
}

async function findSecretFromBundle() {
  const html = await get("https://vidnest.fun/movie/550");
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[^"'\\]+\.js/g) || [])];
  if (!chunks.length) throw new Error("No JS chunks found on /movie/550");

  const candidates = new Set();
  for (const chunk of chunks) {
    let js;
    try {
      js = await get(`https://vidnest.fun${chunk}`);
    } catch {
      continue;
    }
    // Secret sits next to new.vidnest.fun in the decrypt helper chunk.
    if (!js.includes("new.vidnest.fun") || !/decryptCipherResponse|AES-GCM|aes-256-gcm/i.test(js)) {
      continue;
    }
    for (const m of js.matchAll(/["']([A-Za-z0-9_-]{40,90})["']/g)) {
      const s = m[1];
      if (/^[a-f0-9]+$/i.test(s)) continue;
      const letters = [...s].filter((c) => /[A-Za-z]/.test(c)).length;
      const digits = [...s].filter((c) => /\d/.test(c)).length;
      if (letters >= 20 && digits >= 4) candidates.add(s);
    }
    // Prefer the assignment right before the API base URL.
    const near = /let \w+="([A-Za-z0-9_-]{40,90})",\w+="https:\/\/new\.vidnest\.fun"/.exec(js);
    if (near) return { secret: near[1], chunk, candidates: [...candidates] };
  }
  if (candidates.size === 1) {
    return { secret: [...candidates][0], chunk: "(unique candidate)", candidates: [...candidates] };
  }
  throw new Error(
    `Could not uniquely identify secret. Candidates: ${[...candidates].join(", ") || "(none)"}`
  );
}

function decryptV2(d, n, secret) {
  const key = crypto.createHash("sha256").update(`${n}|${secret}`).digest();
  const buf = Buffer.from(d, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function fetchEncryptedSample() {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const apiUrl = `https://new.vidnest.fun/ophim/movie/550?_n=${nonce}`;
  const relay = (process.env.CATFLIX_RELAY || "").split(",")[0].trim();
  const relayKey = process.env.CATFLIX_RELAY_KEY || "";

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: { ...HEADERS, Referer: "https://vidnest.fun/", Origin: "https://vidnest.fun" },
    });
  } catch {
    res = { ok: false, status: 0 };
  }

  if (!res.ok && relay) {
    res = await fetch(`${relay}${encodeURIComponent(apiUrl)}`, {
      headers: relayKey ? { "X-Relay-Key": relayKey } : {},
    });
  }
  if (!res.ok) throw new Error(`Could not fetch sample payload (HTTP ${res.status})`);
  return res.json();
}

function applySecret(secret) {
  let src = fs.readFileSync(CATFLIX, "utf8");
  const next = src.replace(
    /(VIDNEST_SECRET \|\| ")([^"]+)(")/,
    `$1${secret}$3`
  );
  if (next === src) throw new Error("Could not find VIDNEST_SECRET default in utils/catflix.js");
  fs.writeFileSync(CATFLIX, next);
}

function applyEnvSecret(secret) {
  let src = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  if (/^VIDNEST_SECRET=/m.test(src)) {
    src = src.replace(/^VIDNEST_SECRET=.*$/m, `VIDNEST_SECRET=${secret}`);
  } else {
    if (src && !src.endsWith("\n")) src += "\n";
    src += `VIDNEST_SECRET=${secret}\n`;
  }
  fs.writeFileSync(ENV_PATH, src);
}

loadDotEnv();

const repoSecret = currentSecretInRepo();
const envSecret = process.env.VIDNEST_SECRET || null;
const active = envSecret || repoSecret;
console.log("repo secret:", repoSecret || "(not found)");
console.log("env secret: ", envSecret || "(not set)");

const { secret, chunk } = await findSecretFromBundle();
console.log("bundle secret:", secret);
console.log("from chunk:  ", chunk);

if (active === secret) {
  console.log("\nAlready up to date.");
} else {
  console.log("\nSecret differs from what the server is using.");
}

const sample = await fetchEncryptedSample();
if (sample?.v !== 2 || !sample?.d) {
  console.log("Smoke-test skipped (unexpected payload):", JSON.stringify(sample).slice(0, 120));
} else {
  try {
    const plain = decryptV2(sample.d, sample.n, secret);
    console.log("decrypt OK:", plain.slice(0, 100).replace(/\s+/g, " "));
  } catch (e) {
    console.error("decrypt FAILED with new secret:", e.message);
    process.exit(1);
  }
}

if (ENV_APPLY) {
  if (envSecret === secret) {
    console.log("\n.env already has the current secret.");
  } else {
    applyEnvSecret(secret);
    // Exact marker line — cron greps for this before restarting PM2.
    console.log("UPDATED .env with VIDNEST_SECRET");
  }
} else if (APPLY && repoSecret !== secret) {
  applySecret(secret);
  console.log("\nPatched utils/catflix.js");
  console.log("Next: commit, push, then on the droplet:");
  console.log("  cd /var/www/m3u8-scraper && git pull && pm2 restart backend --update-env");
} else if (active !== secret) {
  console.log("\nDry run only. Options:");
  console.log("  node scripts/update-vidnest-secret.mjs --env-apply   # prod / cron (writes .env)");
  console.log("  node scripts/update-vidnest-secret.mjs --apply       # patch utils/catflix.js");
  console.log(`  VIDNEST_SECRET=${secret}`);
}
