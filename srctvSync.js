// SRCTV accounts + cross-device sync (backend-first). Adds /auth, /progress and
// /library JSON endpoints plus simple browser test pages (/register, /login,
// /dashboard). All persistence is MongoDB Atlas via ./db.js. The Flutter app
// talks to these over https://api.srctv.space; it never touches Mongo directly.
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { col, connect, ensureIndexes } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-change-me";
const TOKEN_TTL = "30d";
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(u) {
  return jwt.sign({ uid: u._id.toString(), username: u.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
function publicUser(u) {
  return { id: u._id.toString(), username: u.username, email: u.email };
}
function stripId(d) { const { _id, ...rest } = d; return rest; }

function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.uid;
    req.username = p.username;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---------- auth ----------
async function register(req, res) {
  try {
    let { username, email, password } = req.body || {};
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscore" });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
    if (!password || String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const users = await col("users");
    const passwordHash = await bcrypt.hash(String(password), 10);
    const doc = { username, email, passwordHash, createdAt: Date.now() };
    const r = await users.insertOne(doc);
    doc._id = r.insertedId;
    return res.status(201).json({ token: signToken(doc), user: publicUser(doc) });
  } catch (e) {
    if (e && e.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || "account";
      return res.status(409).json({ error: "That " + field + " is already taken" });
    }
    console.error("register error:", e.message);
    return res.status(500).json({ error: "Registration failed" });
  }
}

async function login(req, res) {
  try {
    let { emailOrUsername, password } = req.body || {};
    emailOrUsername = (emailOrUsername || "").trim();
    if (!emailOrUsername || !password) return res.status(400).json({ error: "Missing credentials" });
    const users = await col("users");
    const q = emailOrUsername.includes("@")
      ? { email: emailOrUsername.toLowerCase() }
      : { username: emailOrUsername };
    const user = await users.findOne(q);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("login error:", e.message);
    return res.status(500).json({ error: "Login failed" });
  }
}

// ---------- progress (last-write-wins by updatedAt) ----------
function cleanProgress(userId, r) {
  return {
    userId,
    mediaType: r.mediaType === "tv" ? "tv" : "movie",
    tmdbId: Number(r.tmdbId),
    season: r.season != null ? Number(r.season) : null,
    episode: r.episode != null ? Number(r.episode) : null,
    positionMs: Number(r.positionMs) || 0,
    durationMs: Number(r.durationMs) || 0,
    completed: !!r.completed,
    title: r.title || null,
    posterPath: r.posterPath || null,
    updatedAt: Number(r.updatedAt) || Date.now(),
  };
}

async function upsertProgress(userId, r) {
  const doc = cleanProgress(userId, r);
  if (!doc.tmdbId) return { ok: false, error: "tmdbId required" };
  const wp = await col("watch_progress");
  const filter = { userId, mediaType: doc.mediaType, tmdbId: doc.tmdbId };
  const existing = await wp.findOne(filter);
  if (existing && existing.updatedAt > doc.updatedAt) return { ok: true, ignored: true };
  await wp.updateOne(filter, { $set: doc }, { upsert: true });
  // Bump lastWatchedAt if this title is in the user's library (no-op otherwise).
  const lib = await col("library");
  await lib.updateOne(filter, { $max: { lastWatchedAt: doc.updatedAt } });
  return { ok: true };
}

async function getProgress(req, res) {
  const since = Number(req.query.since) || 0;
  const wp = await col("watch_progress");
  const docs = await wp.find({ userId: req.userId, updatedAt: { $gt: since } }).sort({ updatedAt: -1 }).toArray();
  res.json(docs.map(stripId));
}
async function putProgress(req, res) {
  const out = await upsertProgress(req.userId, req.body || {});
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
}
async function batchProgress(req, res) {
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  let applied = 0, ignored = 0;
  for (const r of records) {
    const o = await upsertProgress(req.userId, r);
    if (o.ok) { o.ignored ? ignored++ : applied++; }
  }
  res.json({ applied, ignored, total: records.length });
}
async function delProgress(req, res) {
  const wp = await col("watch_progress");
  await wp.deleteOne({ userId: req.userId, mediaType: req.params.mediaType, tmdbId: Number(req.params.tmdbId) });
  res.json({ ok: true });
}

// ---------- library ----------
async function getLibrary(req, res) {
  const lib = await col("library");
  const docs = await lib.find({ userId: req.userId }).sort({ lastWatchedAt: -1, addedAt: -1 }).toArray();
  res.json(docs.map(stripId));
}
async function postLibrary(req, res) {
  const r = req.body || {};
  const tmdbId = Number(r.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: "tmdbId required" });
  const mediaType = r.mediaType === "tv" ? "tv" : "movie";
  const now = Date.now();
  const lib = await col("library");
  await lib.updateOne(
    { userId: req.userId, mediaType, tmdbId },
    {
      $set: { title: r.title || null, posterPath: r.posterPath || null },
      $setOnInsert: { addedAt: now, lastWatchedAt: r.lastWatchedAt ? Number(r.lastWatchedAt) : now },
    },
    { upsert: true }
  );
  res.json({ ok: true });
}
async function delLibrary(req, res) {
  const lib = await col("library");
  await lib.deleteOne({ userId: req.userId, mediaType: req.params.mediaType, tmdbId: Number(req.params.tmdbId) });
  res.json({ ok: true });
}

// ---------- browser test pages ----------
const STYLE = `<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1114;color:#eaeaea;margin:0;padding:40px;display:flex;flex-direction:column;align-items:center;gap:14px}
  h1{font-size:22px;margin:0}
  form{background:#1a1d21;padding:24px;border-radius:12px;width:320px;display:flex;flex-direction:column;gap:12px}
  input{padding:10px;border-radius:8px;border:1px solid #333;background:#0f1114;color:#eaeaea;font-size:14px}
  button{padding:11px;border:0;border-radius:8px;background:#e6b800;color:#111;font-weight:700;font-size:14px;cursor:pointer}
  a{color:#e6b800}
  .msg{color:#ff6b6b;min-height:18px;font-size:13px}
  table{border-collapse:collapse;width:100%;margin-top:8px}
  td,th{border:1px solid #2a2e33;padding:6px 10px;font-size:13px;text-align:left}
  .card{background:#1a1d21;padding:20px;border-radius:12px;width:100%;max-width:900px}
</style>`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
}

function registerPage() {
  return page("SRCTV · Register", `
    <h1>Create your SRCTV account</h1>
    <form id="f">
      <input id="u" placeholder="Username" autocomplete="off">
      <input id="em" placeholder="Email" type="email">
      <input id="pw" placeholder="Password" type="password">
      <button>Register</button>
      <div class="msg" id="msg"></div>
    </form>
    <p>Already have one? <a href="/login">Log in</a></p>
    <script>
      f.onsubmit = async (e) => {
        e.preventDefault(); msg.textContent = "";
        const body = { username: u.value, email: em.value, password: pw.value };
        const r = await fetch("/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (r.ok) { localStorage.setItem("srctv_token", d.token); location.href = "/dashboard"; }
        else { msg.textContent = d.error || "Registration failed"; }
      };
    </script>`);
}

function loginPage() {
  return page("SRCTV · Login", `
    <h1>Log in to SRCTV</h1>
    <form id="f">
      <input id="id" placeholder="Email or username" autocomplete="off">
      <input id="pw" placeholder="Password" type="password">
      <button>Log in</button>
      <div class="msg" id="msg"></div>
    </form>
    <p>No account? <a href="/register">Register</a></p>
    <script>
      f.onsubmit = async (e) => {
        e.preventDefault(); msg.textContent = "";
        const body = { emailOrUsername: id.value, password: pw.value };
        const r = await fetch("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (r.ok) { localStorage.setItem("srctv_token", d.token); location.href = "/dashboard"; }
        else { msg.textContent = d.error || "Login failed"; }
      };
    </script>`);
}

function dashboardPage() {
  return page("SRCTV · Dashboard", `
    <h1 id="hi">Dashboard</h1>
    <div class="card">
      <button id="out">Log out</button>
      <h3>Watch progress</h3>
      <table id="pt"><thead><tr><th>Title</th><th>Type</th><th>S/E</th><th>Pos</th><th>Done</th><th>Updated</th></tr></thead><tbody></tbody></table>
      <h3>Library</h3>
      <table id="lt"><thead><tr><th>Title</th><th>Type</th><th>Last watched</th></tr></thead><tbody></tbody></table>
    </div>
    <script>
      const t = localStorage.getItem("srctv_token");
      if (!t) location.href = "/login";
      const hdr = { headers: { Authorization: "Bearer " + t } };
      const esc = (s) => String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      try { document.getElementById("hi").textContent = "Signed in as " + (JSON.parse(atob(t.split(".")[1])).username || "?"); } catch (e) {}
      document.getElementById("out").onclick = () => { localStorage.removeItem("srctv_token"); location.href = "/login"; };
      async function load() {
        const pr = await fetch("/progress", hdr);
        if (pr.status === 401) { localStorage.removeItem("srctv_token"); location.href = "/login"; return; }
        const p = await pr.json();
        document.querySelector("#pt tbody").innerHTML = p.map((d) =>
          "<tr><td>" + esc(d.title || d.tmdbId) + "</td><td>" + esc(d.mediaType) + "</td><td>" +
          esc((d.season || "-") + "/" + (d.episode || "-")) + "</td><td>" + Math.round((d.positionMs || 0) / 1000) +
          "s</td><td>" + (d.completed ? "yes" : "") + "</td><td>" + new Date(d.updatedAt).toLocaleString() + "</td></tr>").join("");
        const lr = await fetch("/library", hdr);
        const l = await lr.json();
        document.querySelector("#lt tbody").innerHTML = l.map((d) =>
          "<tr><td>" + esc(d.title || d.tmdbId) + "</td><td>" + esc(d.mediaType) + "</td><td>" +
          (d.lastWatchedAt ? new Date(d.lastWatchedAt).toLocaleString() : "-") + "</td></tr>").join("");
      }
      load();
    </script>`);
}

// ---------- mount ----------
export function registerSyncRoutes(app) {
  const authLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts, please slow down" } });
  app.post("/auth/register", authLimiter, register);
  app.post("/auth/login", authLimiter, login);

  app.get("/progress", requireAuth, getProgress);
  app.put("/progress", requireAuth, putProgress);
  app.post("/progress/batch", requireAuth, batchProgress);
  app.delete("/progress/:mediaType/:tmdbId", requireAuth, delProgress);

  app.get("/library", requireAuth, getLibrary);
  app.post("/library", requireAuth, postLibrary);
  app.delete("/library/:mediaType/:tmdbId", requireAuth, delLibrary);

  app.get("/register", (req, res) => res.type("html").send(registerPage()));
  app.get("/login", (req, res) => res.type("html").send(loginPage()));
  app.get("/dashboard", (req, res) => res.type("html").send(dashboardPage()));

  connect().then(ensureIndexes)
    .then(() => console.log("MongoDB Atlas connected + indexes ready"))
    .catch((e) => console.error("MongoDB connect failed:", e.message));
}
