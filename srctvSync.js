// SRCTV accounts + cross-device sync (backend-first). Adds /auth, /progress,
// /library, /admin JSON endpoints plus browser pages (/login, /dashboard,
// /admin). Public registration is disabled — only admins create accounts.
// Expensive scrape routes in server.js use requireAuth + requirePremium.
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { col, connect, ensureIndexes, migrateUserPrivileges } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-change-me";
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(u) {
  return jwt.sign({ uid: u._id.toString(), username: u.username }, JWT_SECRET);
}

function publicUser(u) {
  return {
    id: u._id.toString(),
    username: u.username,
    email: u.email,
    admin: Number(u.admin) === 1 ? 1 : 0,
    premium: Number(u.premium) === 1 ? 1 : 0,
    premium_expires_at: u.premium_expires_at ?? null,
  };
}

function stripId(d) {
  const { _id, ...rest } = d;
  return rest;
}

function isPremiumActive(u) {
  if (!u || Number(u.premium) !== 1) return false;
  if (u.premium_expires_at == null || u.premium_expires_at === "") return true;
  const exp =
    u.premium_expires_at instanceof Date
      ? u.premium_expires_at.getTime()
      : new Date(u.premium_expires_at).getTime();
  if (Number.isNaN(exp)) return false;
  return exp > Date.now();
}

function parseExpiresAt(raw) {
  if (raw === undefined) return undefined; // leave unchanged on PATCH
  if (raw === null || raw === "" || raw === "null") return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return NaN;
  return d;
}

function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

// JWT proves identity only. Privileges always come from a fresh Mongo load so
// demoting premium/admin takes effect immediately (cannot be forged via JWT).
export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const oid = toObjectId(p.uid);
    if (!oid) return res.status(401).json({ error: "Invalid or expired token" });
    const users = await col("users");
    const user = await users.findOne({ _id: oid });
    if (!user) return res.status(401).json({ error: "Invalid or expired token" });
    req.userId = user._id.toString();
    req.username = user.username;
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requirePremium(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Missing bearer token" });
  if (!isPremiumActive(req.user)) {
    return res.status(403).json({
      error: "Premium required",
      premium: Number(req.user.premium) === 1 ? 1 : 0,
      premium_expires_at: req.user.premium_expires_at ?? null,
    });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Missing bearer token" });
  if (Number(req.user.admin) !== 1) {
    return res.status(403).json({ error: "Admin required" });
  }
  next();
}

// ---------- auth ----------
async function registerDisabled(req, res) {
  return res.status(403).json({
    error: "Public registration is disabled. Contact an admin for an account.",
  });
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

async function me(req, res) {
  res.json({ user: publicUser(req.user) });
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
  let applied = 0,
    ignored = 0;
  for (const r of records) {
    const o = await upsertProgress(req.userId, r);
    if (o.ok) {
      o.ignored ? ignored++ : applied++;
    }
  }
  res.json({ applied, ignored, total: records.length });
}
async function delProgress(req, res) {
  const wp = await col("watch_progress");
  await wp.deleteOne({ userId: req.userId, mediaType: req.params.mediaType, tmdbId: Number(req.params.tmdbId) });
  res.json({ ok: true });
}

// ---------- subtitle prefs ----------
function cleanSubPref(userId, r) {
  const mediaType = r.mediaType === "tv" ? "tv" : "movie";
  return {
    userId,
    mediaType,
    tmdbId: Number(r.tmdbId),
    season: mediaType === "tv" ? Number(r.season) || 0 : null,
    name: r.name || null,
    lang: r.lang || null,
    off: !!r.off,
    autoSync: r.autoSync !== false,
    offsetMs: Number(r.offsetMs) || 0,
    updatedAt: Number(r.updatedAt) || Date.now(),
  };
}

async function upsertSubPref(userId, r) {
  const doc = cleanSubPref(userId, r);
  if (!doc.tmdbId) return { ok: false, error: "tmdbId required" };
  const coln = await col("subtitle_prefs");
  const filter = { userId, mediaType: doc.mediaType, tmdbId: doc.tmdbId, season: doc.season };
  const existing = await coln.findOne(filter);
  if (existing && existing.updatedAt > doc.updatedAt) return { ok: true, ignored: true };
  await coln.updateOne(filter, { $set: doc }, { upsert: true });
  return { ok: true };
}

async function getSubPrefs(req, res) {
  const prefs = await col("subtitle_prefs");
  const docs = await prefs.find({ userId: req.userId }).sort({ updatedAt: -1 }).toArray();
  res.json(docs.map(stripId));
}
async function putSubPref(req, res) {
  const out = await upsertSubPref(req.userId, req.body || {});
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
}
async function batchSubPrefs(req, res) {
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  let applied = 0,
    ignored = 0;
  for (const r of records) {
    const o = await upsertSubPref(req.userId, r);
    if (o.ok) {
      o.ignored ? ignored++ : applied++;
    }
  }
  res.json({ applied, ignored, total: records.length });
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
  const updatedAt = Number(r.updatedAt) || now;
  const lib = await col("library");
  const filter = { userId: req.userId, mediaType, tmdbId };
  const existing = await lib.findOne(filter);
  if (existing && existing.updatedAt > updatedAt) return res.json({ ok: true, ignored: true });
  await lib.updateOne(
    filter,
    {
      $set: {
        title: r.title || (existing && existing.title) || null,
        posterPath: r.posterPath || (existing && existing.posterPath) || null,
        deleted: false,
        updatedAt,
        lastWatchedAt: r.lastWatchedAt ? Number(r.lastWatchedAt) : (existing && existing.lastWatchedAt) || updatedAt,
      },
      $setOnInsert: { addedAt: r.addedAt ? Number(r.addedAt) : now },
    },
    { upsert: true }
  );
  res.json({ ok: true });
}
async function delLibrary(req, res) {
  const mediaType = req.params.mediaType === "tv" ? "tv" : "movie";
  const tmdbId = Number(req.params.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: "tmdbId required" });
  const updatedAt = Number(req.query.updatedAt) || Date.now();
  const lib = await col("library");
  const filter = { userId: req.userId, mediaType, tmdbId };
  const existing = await lib.findOne(filter);
  if (existing && existing.updatedAt > updatedAt) return res.json({ ok: true, ignored: true });
  await lib.updateOne(
    filter,
    {
      $set: { deleted: true, updatedAt },
      $setOnInsert: { addedAt: updatedAt, lastWatchedAt: updatedAt },
    },
    { upsert: true }
  );
  res.json({ ok: true });
}

// ---------- recommendation seeds ----------
function cleanSeed(userId, r) {
  return {
    userId,
    mediaType: r.mediaType === "tv" ? "tv" : "movie",
    tmdbId: Number(r.tmdbId),
    recordedAt: Number(r.recordedAt) || Date.now(),
  };
}
async function upsertSeed(userId, r) {
  const doc = cleanSeed(userId, r);
  if (!doc.tmdbId) return { ok: false, error: "tmdbId required" };
  const seeds = await col("recommendation_seeds");
  const filter = { userId, mediaType: doc.mediaType, tmdbId: doc.tmdbId };
  const existing = await seeds.findOne(filter);
  if (existing && existing.recordedAt > doc.recordedAt) return { ok: true, ignored: true };
  await seeds.updateOne(filter, { $set: doc }, { upsert: true });
  return { ok: true };
}
async function getSeeds(req, res) {
  const seeds = await col("recommendation_seeds");
  const docs = await seeds.find({ userId: req.userId }).sort({ recordedAt: -1 }).limit(30).toArray();
  res.json(docs.map(stripId));
}
async function putSeed(req, res) {
  const out = await upsertSeed(req.userId, req.body || {});
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
}
async function batchSeeds(req, res) {
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  let applied = 0,
    ignored = 0;
  for (const r of records) {
    const o = await upsertSeed(req.userId, r);
    if (o.ok) {
      o.ignored ? ignored++ : applied++;
    }
  }
  res.json({ applied, ignored, total: records.length });
}

// ---------- admin users ----------
const ADMIN_SORT_FIELDS = new Set([
  "username",
  "email",
  "admin",
  "premium",
  "premium_expires_at",
  "createdAt",
  "last_activity",
]);

function adminUserView(u) {
  return {
    ...publicUser(u),
    createdAt: u.createdAt || null,
    premium_active: isPremiumActive(u) ? 1 : 0,
    last_activity: u.last_activity ?? null,
  };
}

async function countAdmins() {
  const users = await col("users");
  return users.countDocuments({ admin: 1 });
}

async function cascadeDeleteUserData(userId) {
  await Promise.all([
    col("watch_progress").then((c) => c.deleteMany({ userId })),
    col("library").then((c) => c.deleteMany({ userId })),
    col("subtitle_prefs").then((c) => c.deleteMany({ userId })),
    col("recommendation_seeds").then((c) => c.deleteMany({ userId })),
  ]);
}

async function adminListUsers(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const sortRaw = String(req.query.sort || "createdAt");
    const sort = ADMIN_SORT_FIELDS.has(sortRaw) ? sortRaw : "createdAt";
    const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;

    const filter = q
      ? {
          $or: [
            { username: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
            { email: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
          ],
        }
      : {};

    const users = await col("users");
    const sortKey = sort === "last_activity" ? "last_activity_sort" : sort;
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: "watch_progress",
          let: { uid: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
            { $group: { _id: null, last: { $max: "$updatedAt" } } },
          ],
          as: "_wp",
        },
      },
      {
        $addFields: {
          last_activity: { $ifNull: [{ $arrayElemAt: ["$_wp.last", 0] }, null] },
          // null activity sorts as 0 so inactive users sink when sorting desc
          last_activity_sort: { $ifNull: [{ $arrayElemAt: ["$_wp.last", 0] }, 0] },
        },
      },
      { $project: { passwordHash: 0, _wp: 0 } },
      {
        $facet: {
          meta: [{ $count: "total" }],
          rows: [{ $sort: { [sortKey]: order, _id: order } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        },
      },
    ];

    const [facet] = await users.aggregate(pipeline).toArray();
    const total = facet?.meta?.[0]?.total || 0;
    const docs = facet?.rows || [];
    res.json({
      users: docs.map(adminUserView),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit) || 1),
      sort,
      order: order === 1 ? "asc" : "desc",
    });
  } catch (e) {
    console.error("adminListUsers:", e.message);
    res.status(500).json({ error: "Failed to list users" });
  }
}

async function adminCreateUser(req, res) {
  try {
    let { username, email, password, admin, premium, premium_expires_at } = req.body || {};
    username = (username || "").trim();
    email = (email || "").trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscore" });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
    if (!password || String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const expires = parseExpiresAt(premium_expires_at === undefined ? null : premium_expires_at);
    if (Number.isNaN(expires)) return res.status(400).json({ error: "Invalid premium_expires_at" });
    const users = await col("users");
    const passwordHash = await bcrypt.hash(String(password), 10);
    const doc = {
      username,
      email,
      passwordHash,
      createdAt: Date.now(),
      admin: Number(admin) === 1 ? 1 : 0,
      premium: Number(premium) === 1 ? 1 : 0,
      premium_expires_at: expires === undefined ? null : expires,
    };
    const r = await users.insertOne(doc);
    doc._id = r.insertedId;
    return res.status(201).json({ user: adminUserView(doc) });
  } catch (e) {
    if (e && e.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || "account";
      return res.status(409).json({ error: "That " + field + " is already taken" });
    }
    console.error("adminCreateUser:", e.message);
    return res.status(500).json({ error: "Failed to create user" });
  }
}

async function adminPatchUser(req, res) {
  try {
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ error: "Invalid user id" });
    const users = await col("users");
    const existing = await users.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ error: "User not found" });

    const body = req.body || {};
    const $set = {};

    if (body.email !== undefined) {
      const email = String(body.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email address" });
      $set.email = email;
    }
    if (body.username !== undefined) {
      const username = String(body.username || "").trim();
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscore" });
      $set.username = username;
    }
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      if (String(body.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      $set.passwordHash = await bcrypt.hash(String(body.password), 10);
    }
    if (body.premium !== undefined) {
      $set.premium = Number(body.premium) === 1 ? 1 : 0;
    }
    if (body.premium_expires_at !== undefined) {
      const expires = parseExpiresAt(body.premium_expires_at);
      if (Number.isNaN(expires)) return res.status(400).json({ error: "Invalid premium_expires_at" });
      $set.premium_expires_at = expires;
    }
    if (body.admin !== undefined) {
      const nextAdmin = Number(body.admin) === 1 ? 1 : 0;
      if (Number(existing.admin) === 1 && nextAdmin === 0) {
        const admins = await countAdmins();
        if (admins <= 1) return res.status(400).json({ error: "Cannot demote the last admin" });
        if (existing._id.toString() === req.userId) {
          return res.status(400).json({ error: "Cannot demote your own admin account" });
        }
      }
      $set.admin = nextAdmin;
    }

    if (!Object.keys($set).length) return res.status(400).json({ error: "No fields to update" });

    try {
      await users.updateOne({ _id: oid }, { $set });
    } catch (e) {
      if (e && e.code === 11000) {
        const field = Object.keys(e.keyPattern || {})[0] || "account";
        return res.status(409).json({ error: "That " + field + " is already taken" });
      }
      throw e;
    }
    const updated = await users.findOne({ _id: oid }, { projection: { passwordHash: 0 } });
    res.json({ user: adminUserView(updated) });
  } catch (e) {
    console.error("adminPatchUser:", e.message);
    res.status(500).json({ error: "Failed to update user" });
  }
}

async function adminDeleteUser(req, res) {
  try {
    const oid = toObjectId(req.params.id);
    if (!oid) return res.status(400).json({ error: "Invalid user id" });
    if (oid.toString() === req.userId) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const users = await col("users");
    const existing = await users.findOne({ _id: oid });
    if (!existing) return res.status(404).json({ error: "User not found" });
    if (Number(existing.admin) === 1) {
      const admins = await countAdmins();
      if (admins <= 1) return res.status(400).json({ error: "Cannot delete the last admin" });
    }
    const userId = existing._id.toString();
    await users.deleteOne({ _id: oid });
    await cascadeDeleteUserData(userId);
    res.json({ ok: true });
  } catch (e) {
    console.error("adminDeleteUser:", e.message);
    res.status(500).json({ error: "Failed to delete user" });
  }
}

// ---------- browser pages ----------
const STYLE = `<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1114;color:#eaeaea;margin:0;padding:40px;display:flex;flex-direction:column;align-items:center;gap:14px}
  h1{font-size:22px;margin:0}
  form, .card{background:#1a1d21;padding:24px;border-radius:12px;width:100%;max-width:960px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}
  form.narrow{width:320px;max-width:320px}
  input,select{padding:10px;border-radius:8px;border:1px solid #333;background:#0f1114;color:#eaeaea;font-size:14px}
  button,.btn{padding:11px 14px;border:0;border-radius:8px;background:#e6b800;color:#111;font-weight:700;font-size:13px;cursor:pointer}
  button.danger{background:#c0392b;color:#fff}
  button.ghost{background:#2a2e33;color:#eaeaea}
  a{color:#e6b800}
  .msg{color:#ff6b6b;min-height:18px;font-size:13px}
  .ok{color:#6bcb77}
  table{border-collapse:collapse;width:100%;margin-top:8px}
  td,th{border:1px solid #2a2e33;padding:6px 8px;font-size:12px;text-align:left;vertical-align:top}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .muted{color:#9aa0a6;font-size:13px}
  .badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700}
  .badge.on{background:#1e3a2f;color:#6bcb77}
  .badge.off{background:#3a1e1e;color:#ff8a8a}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between}
  th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
  th.sortable:hover{color:#e6b800}
  th.sortable .arrow{opacity:.45;font-size:11px;margin-left:4px}
  th.sortable.active .arrow{opacity:1;color:#e6b800}
  .pager{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-top:8px}
  .field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#9aa0a6}
  .field input{min-width:140px}
  .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
  .modal-backdrop.open{display:flex}
  .modal{background:#1a1d21;border:1px solid #2a2e33;border-radius:12px;padding:20px;width:100%;max-width:420px;display:flex;flex-direction:column;gap:12px}
  .modal h2{margin:0;font-size:18px}
  .modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
</style>`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
}

function loginPage() {
  return page(
    "SRCTV · Login",
    `
    <h1>Log in to SRCTV</h1>
    <form id="f" class="narrow">
      <input id="id" placeholder="Email or username" autocomplete="off">
      <input id="pw" placeholder="Password" type="password">
      <button>Log in</button>
      <div class="msg" id="msg"></div>
    </form>
    <p class="muted">Accounts are invite-only.</p>
    <script>
      f.onsubmit = async (e) => {
        e.preventDefault(); msg.textContent = "";
        const body = { emailOrUsername: id.value, password: pw.value };
        const r = await fetch("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (r.ok) {
          localStorage.setItem("srctv_token", d.token);
          location.href = d.user && d.user.admin === 1 ? "/admin" : "/dashboard";
        } else { msg.textContent = d.error || "Login failed"; }
      };
    </script>`
  );
}

function dashboardPage() {
  return page(
    "SRCTV · Dashboard",
    `
    <h1 id="hi">Dashboard</h1>
    <div class="card">
      <div class="row">
        <button id="out" class="ghost">Log out</button>
        <a id="adminLink" href="/admin" style="display:none">Admin</a>
        <span id="prem" class="muted"></span>
      </div>
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
      document.getElementById("out").onclick = () => { localStorage.removeItem("srctv_token"); location.href = "/login"; };
      async function load() {
        const me = await fetch("/auth/me", hdr);
        if (me.status === 401) { localStorage.removeItem("srctv_token"); location.href = "/login"; return; }
        const md = await me.json();
        const u = md.user || {};
        document.getElementById("hi").textContent = "Signed in as " + (u.username || "?");
        document.getElementById("prem").textContent = u.premium === 1
          ? ("Premium" + (u.premium_expires_at ? (" until " + new Date(u.premium_expires_at).toLocaleString()) : " (no expiry)"))
          : "Not premium — streams locked";
        if (u.admin === 1) document.getElementById("adminLink").style.display = "";
        const pr = await fetch("/progress", hdr);
        const p = await pr.json();
        document.querySelector("#pt tbody").innerHTML = (p || []).map((d) =>
          "<tr><td>" + esc(d.title || d.tmdbId) + "</td><td>" + esc(d.mediaType) + "</td><td>" +
          esc((d.season || "-") + "/" + (d.episode || "-")) + "</td><td>" + Math.round((d.positionMs || 0) / 1000) +
          "s</td><td>" + (d.completed ? "yes" : "") + "</td><td>" + new Date(d.updatedAt).toLocaleString() + "</td></tr>").join("");
        const lr = await fetch("/library", hdr);
        const l = await lr.json();
        document.querySelector("#lt tbody").innerHTML = (l || []).map((d) =>
          "<tr><td>" + esc(d.title || d.tmdbId) + "</td><td>" + esc(d.mediaType) + "</td><td>" +
          (d.lastWatchedAt ? new Date(d.lastWatchedAt).toLocaleString() : "-") + "</td></tr>").join("");
      }
      load();
    </script>`
  );
}

function adminPage() {
  return page(
    "SRCTV · Admin",
    `
    <h1>User management</h1>
    <div class="card">
      <div class="toolbar">
        <div class="row">
          <span id="who" class="muted"></span>
          <a href="/dashboard">Dashboard</a>
          <button id="out" class="ghost" type="button">Log out</button>
        </div>
        <div class="row">
          <input id="q" placeholder="Search username/email" style="min-width:220px">
          <button id="search" type="button">Search</button>
          <button id="refresh" class="ghost" type="button">Refresh</button>
          <select id="limit">
            <option value="15" selected>15 / page</option>
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
        </div>
      </div>
      <div class="msg" id="msg"></div>
      <h3>Create user</h3>
      <div class="row">
        <input id="cu" placeholder="Username">
        <input id="ce" placeholder="Email" type="email">
        <input id="cp" placeholder="Password" type="password">
        <label><input type="checkbox" id="cprem"> premium</label>
        <label><input type="checkbox" id="cadm"> admin</label>
        <label class="field">Expires at (optional)
          <input id="cexp" type="date" title="Leave empty for no expiration">
        </label>
        <button id="create" type="button">Create</button>
      </div>
      <div class="toolbar" style="margin-top:8px">
        <h3 style="margin:0">Users <span id="totalLabel" class="muted"></span></h3>
      </div>
      <table>
        <thead>
          <tr id="thead"></tr>
        </thead>
        <tbody id="tb"></tbody>
      </table>
      <div class="pager">
        <button id="prev" class="ghost" type="button">Prev</button>
        <span id="pageLabel" class="muted"></span>
        <button id="next" class="ghost" type="button">Next</button>
      </div>
    </div>
    <div id="editModal" class="modal-backdrop" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true">
        <h2 id="editTitle">Edit user</h2>
        <input type="hidden" id="eid">
        <label class="field">Username <input id="euser" disabled></label>
        <label class="field">Email <input id="eemail" type="email"></label>
        <label><input type="checkbox" id="eprem"> premium</label>
        <label><input type="checkbox" id="eadm"> admin</label>
        <label class="field">Expires at (optional)
          <input id="eexp" type="date" title="Leave empty for no expiration">
        </label>
        <label class="field">New password (optional)
          <input id="epw" type="password" placeholder="Leave blank to keep current">
        </label>
        <div class="msg" id="emsg"></div>
        <div class="actions">
          <button id="edel" class="danger" type="button">Delete</button>
          <button id="ecancel" class="ghost" type="button">Cancel</button>
          <button id="esave" type="button">Save</button>
        </div>
      </div>
    </div>
    <script>
      const t = localStorage.getItem("srctv_token");
      if (!t) location.href = "/login";
      const auth = { Authorization: "Bearer " + t };
      const esc = (s) => String(s == null ? "" : s).replace(/[<>&"'/]/g, (c) => ({ "<":"&lt;",">":"&gt;","&":"&amp;","\\"":"&quot;","'":"&#39;","/":"&#47;" }[c]));
      const msg = document.getElementById("msg");
      const setMsg = (text, ok) => { msg.className = ok ? "ok" : "msg"; msg.textContent = text || ""; };
      const emsg = document.getElementById("emsg");
      const setEmsg = (text, ok) => { emsg.className = ok ? "ok" : "msg"; emsg.textContent = text || ""; };
      document.getElementById("out").onclick = () => { localStorage.removeItem("srctv_token"); location.href = "/login"; };

      const state = { page: 1, limit: 15, sort: "createdAt", order: "desc", q: "", usersById: {} };
      const COLS = [
        { key: "username", label: "Username" },
        { key: "email", label: "Email" },
        { key: "admin", label: "Admin" },
        { key: "premium", label: "Premium" },
        { key: "premium_expires_at", label: "Expires" },
        { key: "createdAt", label: "Created" },
        { key: "last_activity", label: "Last activity" },
        { key: null, label: "" },
      ];

      async function api(path, opts = {}) {
        const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...auth, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
        const d = await r.json().catch(() => ({}));
        if (r.status === 401) { localStorage.removeItem("srctv_token"); location.href = "/login"; throw new Error("auth"); }
        if (r.status === 403) { setMsg(d.error || "Forbidden"); throw new Error("forbidden"); }
        if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      }

      function badge(on, label) {
        return '<span class="badge ' + (on ? "on" : "off") + '">' + label + "</span>";
      }

      function fmtWhen(v) {
        if (!v) return "-";
        return esc(new Date(v).toLocaleString());
      }

      function renderHead() {
        document.getElementById("thead").innerHTML = COLS.map((c) => {
          if (!c.key) return "<th>" + esc(c.label) + "</th>";
          const active = state.sort === c.key;
          const arrow = active ? (state.order === "asc" ? "▲" : "▼") : "▲";
          return '<th class="sortable' + (active ? " active" : "") + '" data-sort="' + c.key + '">' +
            esc(c.label) + '<span class="arrow">' + arrow + "</span></th>";
        }).join("");
      }

      function rowHtml(u) {
        return '<tr data-id="' + esc(u.id) + '">' +
          "<td><strong>" + esc(u.username) + "</strong></td>" +
          "<td>" + esc(u.email) + "</td>" +
          "<td>" + badge(u.admin === 1, u.admin === 1 ? "yes" : "no") + "</td>" +
          "<td>" + badge(u.premium_active === 1, u.premium_active === 1 ? "active" : (u.premium === 1 ? "expired" : "no")) + "</td>" +
          "<td>" + (u.premium_expires_at ? esc(new Date(u.premium_expires_at).toLocaleDateString()) : '<span class="muted">never</span>') + "</td>" +
          "<td>" + (u.createdAt ? esc(new Date(u.createdAt).toLocaleString()) : "-") + "</td>" +
          "<td>" + fmtWhen(u.last_activity) + "</td>" +
          '<td><button class="edit" type="button">Edit</button></td></tr>';
      }

      function openEdit(u) {
        setEmsg("");
        eid.value = u.id;
        euser.value = u.username || "";
        eemail.value = u.email || "";
        eprem.checked = u.premium === 1;
        eadm.checked = u.admin === 1;
        eexp.value = u.premium_expires_at ? new Date(u.premium_expires_at).toISOString().slice(0, 10) : "";
        epw.value = "";
        editTitle.textContent = "Edit " + (u.username || "user");
        editModal.classList.add("open");
        editModal.setAttribute("aria-hidden", "false");
      }
      function closeEdit() {
        editModal.classList.remove("open");
        editModal.setAttribute("aria-hidden", "true");
      }

      async function load() {
        setMsg("");
        renderHead();
        const me = await api("/auth/me");
        if (!me.user || me.user.admin !== 1) { setMsg("Admin required"); location.href = "/dashboard"; return; }
        document.getElementById("who").textContent = "Signed in as " + me.user.username;
        state.q = document.getElementById("q").value.trim();
        state.limit = parseInt(document.getElementById("limit").value, 10) || 15;
        const params = new URLSearchParams({
          page: String(state.page),
          limit: String(state.limit),
          sort: state.sort,
          order: state.order,
        });
        if (state.q) params.set("q", state.q);
        const data = await api("/admin/users?" + params.toString());
        state.page = data.page || state.page;
        const pages = data.pages || 1;
        state.usersById = {};
        for (const u of data.users || []) state.usersById[u.id] = u;
        document.getElementById("totalLabel").textContent = "(" + (data.total || 0) + " total)";
        document.getElementById("pageLabel").textContent = "Page " + state.page + " / " + pages;
        document.getElementById("prev").disabled = state.page <= 1;
        document.getElementById("next").disabled = state.page >= pages;
        document.getElementById("tb").innerHTML = (data.users || []).map(rowHtml).join("") ||
          '<tr><td colspan="8" class="muted">No users</td></tr>';
      }

      document.getElementById("thead").onclick = (ev) => {
        const th = ev.target.closest("th[data-sort]");
        if (!th) return;
        const key = th.getAttribute("data-sort");
        if (state.sort === key) state.order = state.order === "asc" ? "desc" : "asc";
        else { state.sort = key; state.order = key === "username" || key === "email" ? "asc" : "desc"; }
        state.page = 1;
        load().catch((e) => { if (e.message !== "auth") setMsg(e.message); });
      };

      document.getElementById("tb").onclick = (ev) => {
        const btn = ev.target.closest("button.edit");
        if (!btn) return;
        const tr = ev.target.closest("tr");
        if (!tr) return;
        const u = state.usersById[tr.getAttribute("data-id")];
        if (u) openEdit(u);
      };

      document.getElementById("ecancel").onclick = closeEdit;
      editModal.onclick = (ev) => { if (ev.target === editModal) closeEdit(); };
      document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && editModal.classList.contains("open")) closeEdit(); });

      document.getElementById("esave").onclick = async () => {
        try {
          setEmsg("");
          const id = eid.value;
          const body = {
            email: eemail.value.trim(),
            premium: eprem.checked ? 1 : 0,
            admin: eadm.checked ? 1 : 0,
            premium_expires_at: eexp.value ? new Date(eexp.value + "T23:59:59.000Z").toISOString() : null,
          };
          if (epw.value) body.password = epw.value;
          await api("/admin/users/" + id, { method: "PATCH", body: JSON.stringify(body) });
          closeEdit();
          setMsg("Saved", true);
          await load();
        } catch (e) {
          if (e.message !== "auth" && e.message !== "forbidden") setEmsg(e.message);
        }
      };

      document.getElementById("edel").onclick = async () => {
        try {
          if (!confirm("Delete this user and their synced data?")) return;
          await api("/admin/users/" + eid.value, { method: "DELETE" });
          closeEdit();
          setMsg("Deleted", true);
          await load();
        } catch (e) {
          if (e.message !== "auth" && e.message !== "forbidden") setEmsg(e.message);
        }
      };

      document.getElementById("create").onclick = async () => {
        try {
          const expRaw = cexp.value;
          const body = {
            username: cu.value.trim(),
            email: ce.value.trim(),
            password: cp.value,
            premium: cprem.checked ? 1 : 0,
            admin: cadm.checked ? 1 : 0,
            premium_expires_at: expRaw ? new Date(expRaw + "T23:59:59.000Z").toISOString() : null,
          };
          await api("/admin/users", { method: "POST", body: JSON.stringify(body) });
          cu.value = ce.value = cp.value = cexp.value = "";
          cprem.checked = cadm.checked = false;
          setMsg("Created", true);
          state.page = 1;
          await load();
        } catch (e) {
          if (e.message !== "auth" && e.message !== "forbidden") setMsg(e.message);
        }
      };

      function searchNow() { state.page = 1; load().catch((e) => { if (e.message !== "auth") setMsg(e.message); }); }
      document.getElementById("search").onclick = searchNow;
      document.getElementById("refresh").onclick = () => load().catch((e) => { if (e.message !== "auth") setMsg(e.message); });
      document.getElementById("limit").onchange = searchNow;
      document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchNow(); });
      document.getElementById("prev").onclick = () => { if (state.page > 1) { state.page--; load(); } };
      document.getElementById("next").onclick = () => { state.page++; load(); };
      load().catch((e) => { if (e.message !== "auth") setMsg(e.message); });
    </script>`
  );
}

// ---------- mount ----------
export function registerSyncRoutes(app) {
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts, please slow down" },
  });

  app.post("/auth/register", registerDisabled);
  app.post("/auth/login", loginLimiter, login);
  app.get("/auth/me", requireAuth, me);

  app.get("/progress", requireAuth, getProgress);
  app.put("/progress", requireAuth, putProgress);
  app.post("/progress/batch", requireAuth, batchProgress);
  app.delete("/progress/:mediaType/:tmdbId", requireAuth, delProgress);

  app.get("/library", requireAuth, getLibrary);
  app.post("/library", requireAuth, postLibrary);
  app.delete("/library/:mediaType/:tmdbId", requireAuth, delLibrary);

  app.get("/recommendations", requireAuth, getSeeds);
  app.put("/recommendations", requireAuth, putSeed);
  app.post("/recommendations/batch", requireAuth, batchSeeds);

  app.get("/subtitle-prefs", requireAuth, getSubPrefs);
  app.put("/subtitle-prefs", requireAuth, putSubPref);
  app.post("/subtitle-prefs/batch", requireAuth, batchSubPrefs);

  app.get("/admin/users", requireAuth, requireAdmin, adminListUsers);
  app.post("/admin/users", requireAuth, requireAdmin, adminCreateUser);
  app.patch("/admin/users/:id", requireAuth, requireAdmin, adminPatchUser);
  app.delete("/admin/users/:id", requireAuth, requireAdmin, adminDeleteUser);

  app.get("/register", (req, res) => res.redirect(302, "/login"));
  app.get("/login", (req, res) => res.type("html").send(loginPage()));
  app.get("/dashboard", (req, res) => res.type("html").send(dashboardPage()));
  app.get("/admin", (req, res) => res.type("html").send(adminPage()));

  connect()
    .then(ensureIndexes)
    .then(migrateUserPrivileges)
    .then(() => console.log("MongoDB Atlas connected + indexes/privileges ready"))
    .catch((e) => console.error("MongoDB connect failed:", e.message));
}
