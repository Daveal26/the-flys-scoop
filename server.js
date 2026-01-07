require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const multer = require("multer");

const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { db, ensureDbDir } = require("./src/db/db");
const { runMigrationsIfNeeded } = require("./src/db/migrate");
const { seedIfEmpty } = require("./src/db/seed");
const { requireAuth } = require("./src/middleware/auth");
const { runAiOnce } = require("./src/ai/aiRunner");
const { categorizeScoop } = require("./src/ai/categorize");
const { recordFeedbackAndLearn } = require("./src/ai/learn");
const { autoEditVideoToClip, manualEditVideoToClip } = require("./src/video/clipper");

const APP_PORT = Number(process.env.PORT || 5173);
// You can run locally on localhost AND deploy to a real domain by allowing multiple origins.
// Set APP_ORIGINS as a comma-separated list, e.g.:
// APP_ORIGINS=http://localhost:5173,http://theflysScoop.com
const APP_ORIGINS = (process.env.APP_ORIGINS || "").trim();
const DEFAULT_ORIGIN = `http://localhost:${APP_PORT}`;
const ALLOWED_ORIGINS = (APP_ORIGINS ? APP_ORIGINS.split(",") : [process.env.APP_ORIGIN || DEFAULT_ORIGIN])
  .map(s => s.trim())
  .filter(Boolean);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const AI_AUTO_RUN_INTERVAL_MINUTES = Number(process.env.AI_AUTO_RUN_INTERVAL_MINUTES || 60);

const CASHAPP_LINK = process.env.CASHAPP_LINK || "";
const VENMO_LINK = process.env.VENMO_LINK || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

ensureDbDir();
runMigrationsIfNeeded();
seedIfEmpty();

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // keep simple for local dev
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin/non-browser requests
    if (!origin) return cb(null, true);
    const norm = (o) => String(o || "")
      .trim()
      .replace(/\/+$/g, "")
      .toLowerCase();
    const o = norm(origin);
    const allowed = new Set(ALLOWED_ORIGINS.map(norm));
    if (allowed.has(o)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true
}));
app.use(cookieParser());

app.use(express.json({ limit: "2mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");
// For production (Fly.io), set UPLOADS_DIR=/data/uploads to persist across deploys (volume mount).
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeBase = (file.originalname || "upload")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      cb(null, `${Date.now()}_${safeBase}`);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 500 } // 500MB
});

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "14d" }
  );
}

function authUserFromCredentials(email, password) {
  const user = db.prepare("SELECT id, email, password_hash, tier, is_verified FROM users WHERE email = ?").get(email);
  if (!user) return null;
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email, tier: user.tier || "free", isVerified: Number(user.is_verified) === 1 };
}

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Auth
app.post("/api/auth/signup", (req, res) => {
  const schema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(200)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid signup data" });

  const email = parsed.data.email.toLowerCase();
  const passwordHash = bcrypt.hashSync(parsed.data.password, 10);

  try {
    const info = db.prepare("INSERT INTO users (email, password_hash, tier, is_verified) VALUES (?, ?, 'free', 0)").run(email, passwordHash);
    const user = { id: info.lastInsertRowid, email, tier: "free", isVerified: false };
    const token = signToken(user);
    return res.json({ token, user });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "Email already exists" });
    return res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const schema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(200)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid login data" });

  const email = parsed.data.email.toLowerCase();
  const user = authUserFromCredentials(email, parsed.data.password);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  const token = signToken(user);
  return res.json({ token, user });
});

app.get("/api/me", requireAuth(JWT_SECRET), (req, res) => {
  res.json({ user: req.user });
});

function tierAllowsFollow(user) {
  return user && (user.tier === "member" || user.tier === "verified" || user.isVerified);
}

function tierAllowsAutoEdit(user) {
  return user && (user.tier === "member" || user.tier === "verified" || user.isVerified);
}

function monthlyVideoLimit(user) {
  if (!user) return 0;
  if (user.tier === "verified" || user.isVerified) return Infinity;
  if (user.tier === "member") return 40;
  return 10; // free (nonmember)
}

function getMonthlyVideoUploadsCount(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) as c
    FROM scoops
    WHERE posted_by_user_id = ?
      AND media_type LIKE 'video/%'
      AND datetime(created_at) >= datetime('now','start of month')
  `).get(userId);
  return Number(row?.c || 0);
}

// Profile
app.get("/api/profile", requireAuth(JWT_SECRET), (req, res) => {
  const limit = monthlyVideoLimit(req.user);
  const used = getMonthlyVideoUploadsCount(req.user.id);
  const latestReq = db.prepare(`
    SELECT id, status, created_at, reviewed_at
    FROM verification_requests
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(req.user.id);
  res.json({
    user: req.user,
    uploads: { used, limit: Number.isFinite(limit) ? limit : null },
    verification: {
      cashappLink: CASHAPP_LINK || null,
      venmoLink: VENMO_LINK || null,
      latestRequest: latestReq || null
    }
  });
});

// Upgrade to member (dev stub; add real payments later)
app.post("/api/profile/upgrade-member", requireAuth(JWT_SECRET), (req, res) => {
  if (process.env.ALLOW_SELF_MEMBERSHIP_UPGRADE !== "1") {
    return res.status(403).json({ error: "Membership upgrades disabled" });
  }
  db.prepare("UPDATE users SET tier='member' WHERE id = ?").run(req.user.id);
  const row = db.prepare("SELECT id, email, tier, is_verified, socials_json FROM users WHERE id = ?").get(req.user.id);
  res.json({ ok: true, user: { id: row.id, email: row.email, tier: row.tier, isVerified: Number(row.is_verified) === 1 } });
});

// Buy verification (deprecated; kept for compatibility)
app.post("/api/profile/buy-verification", requireAuth(JWT_SECRET), (req, res) => {
  if (process.env.ALLOW_DEV_VERIFICATION !== "1") {
    return res.status(410).json({ error: "Use manual verification in Profile" });
  }
  db.prepare("UPDATE users SET tier='verified', is_verified=1, stripe_verified_at=@now WHERE id = @id").run({ id: req.user.id, now: new Date().toISOString() });
  const row = db.prepare("SELECT id, email, tier, is_verified, socials_json FROM users WHERE id = ?").get(req.user.id);
  res.json({ ok: true, user: { id: row.id, email: row.email, tier: row.tier, isVerified: Number(row.is_verified) === 1 } });
});

// Manual verification request (CashApp/Venmo/etc)
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeBase = (file.originalname || "receipt")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      cb(null, `${Date.now()}_${safeBase}`);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 15 } // 15MB receipts
});

app.post("/api/verification/request", requireAuth(JWT_SECRET), receiptUpload.single("receipt"), (req, res) => {
  if (req.user.tier === "verified" || req.user.isVerified) {
    return res.status(400).json({ error: "Already verified" });
  }
  const schema = z.object({
    handle: z.string().max(100).optional().default(""),
    note: z.string().max(2000).optional().default("")
  });
  const parsed = schema.safeParse({ handle: req.body.handle || "", note: req.body.note || "" });
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  const receiptPath = req.file ? `/uploads/${req.file.filename}` : null;
  const info = db.prepare(`
    INSERT INTO verification_requests (user_id, status, method, handle, note, receipt_path)
    VALUES (@userId, 'pending', 'manual', @handle, @note, @receiptPath)
  `).run({
    userId: req.user.id,
    handle: parsed.data.handle.trim() || null,
    note: parsed.data.note.trim() || null,
    receiptPath
  });
  const row = db.prepare("SELECT id, status, created_at FROM verification_requests WHERE id = ?").get(info.lastInsertRowid);
  res.json({ ok: true, request: row });
});

app.get("/api/verification/status", requireAuth(JWT_SECRET), (req, res) => {
  const latestReq = db.prepare(`
    SELECT id, status, created_at, reviewed_at, reviewed_by
    FROM verification_requests
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
  `).get(req.user.id);
  res.json({ request: latestReq || null });
});

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: "Admin unauthorized" });
  next();
}

app.get("/api/admin/verification/requests", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT vr.*, u.email
    FROM verification_requests vr
    JOIN users u ON u.id = vr.user_id
    WHERE vr.status = 'pending'
    ORDER BY datetime(vr.created_at) ASC
    LIMIT 100
  `).all();
  res.json({ requests: rows });
});

app.post("/api/admin/verification/:id/approve", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM verification_requests WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE verification_requests SET status='approved', reviewed_at=@now, reviewed_by=@by WHERE id=@id").run({
    id,
    now: new Date().toISOString(),
    by: "admin"
  });
  db.prepare("UPDATE users SET tier='verified', is_verified=1, stripe_verified_at=@now WHERE id = @id").run({
    id: row.user_id,
    now: new Date().toISOString()
  });
  res.json({ ok: true });
});

app.post("/api/admin/verification/:id/deny", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM verification_requests WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("UPDATE verification_requests SET status='denied', reviewed_at=@now, reviewed_by=@by WHERE id=@id").run({
    id,
    now: new Date().toISOString(),
    by: "admin"
  });
  res.json({ ok: true });
});

// Verified users can set social links
app.post("/api/profile/socials", requireAuth(JWT_SECRET), (req, res) => {
  if (!(req.user.tier === "verified" || req.user.isVerified)) {
    return res.status(403).json({ error: "Social links are for verified profiles only" });
  }
  const schema = z.object({
    instagram: z.string().max(2048).optional().default(""),
    tiktok: z.string().max(2048).optional().default(""),
    x: z.string().max(2048).optional().default(""),
    youtube: z.string().max(2048).optional().default(""),
    website: z.string().max(2048).optional().default("")
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid socials" });

  const socials = parsed.data;
  db.prepare("UPDATE users SET socials_json = ? WHERE id = ?").run(JSON.stringify(socials), req.user.id);
  res.json({ ok: true, socials });
});

// Follow system (members/verified only)
app.get("/api/following", requireAuth(JWT_SECRET), (req, res) => {
  if (!tierAllowsFollow(req.user)) return res.json({ following: [] });
  const rows = db.prepare("SELECT followee_user_id FROM follows WHERE follower_user_id = ?").all(req.user.id);
  res.json({ following: rows.map(r => r.followee_user_id) });
});

app.post("/api/follow/:userId", requireAuth(JWT_SECRET), (req, res) => {
  if (!tierAllowsFollow(req.user)) return res.status(403).json({ error: "Follow is for members only" });
  const targetId = Number(req.params.userId);
  if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user" });
  if (targetId === Number(req.user.id)) return res.status(400).json({ error: "Cannot follow yourself" });

  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
  if (!exists) return res.status(404).json({ error: "User not found" });

  db.prepare(`
    INSERT INTO follows (follower_user_id, followee_user_id)
    VALUES (?, ?)
    ON CONFLICT(follower_user_id, followee_user_id) DO NOTHING
  `).run(req.user.id, targetId);
  res.json({ ok: true });
});

app.delete("/api/follow/:userId", requireAuth(JWT_SECRET), (req, res) => {
  if (!tierAllowsFollow(req.user)) return res.status(403).json({ error: "Follow is for members only" });
  const targetId = Number(req.params.userId);
  if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user" });
  db.prepare("DELETE FROM follows WHERE follower_user_id = ? AND followee_user_id = ?").run(req.user.id, targetId);
  res.json({ ok: true });
});

// Public user profile (for viewing verified socials / trusted badge)
app.get("/api/users/:userId", (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: "Invalid user" });

  const row = db.prepare("SELECT id, email, tier, is_verified, socials_json, created_at FROM users WHERE id = ?").get(userId);
  if (!row) return res.status(404).json({ error: "User not found" });

  const followers = db.prepare("SELECT COUNT(*) as c FROM follows WHERE followee_user_id = ?").get(userId).c;
  const following = db.prepare("SELECT COUNT(*) as c FROM follows WHERE follower_user_id = ?").get(userId).c;

  let socials = null;
  if (Number(row.is_verified) === 1 && row.socials_json) {
    try { socials = JSON.parse(row.socials_json); } catch { socials = null; }
  }

  res.json({
    user: {
      id: row.id,
      email: row.email,
      tier: row.tier || "free",
      isVerified: Number(row.is_verified) === 1,
      createdAt: row.created_at
    },
    stats: { followers, following },
    socials
  });
});

// Scoops
app.get("/api/categories", (_req, res) => {
  const rows = db.prepare("SELECT name FROM categories ORDER BY name ASC").all();
  res.json({ categories: rows.map(r => r.name) });
});

app.get("/api/scoops", (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
  const offset = Math.max(0, Number(req.query.offset || 0));

  const where = [];
  const params = {};
  if (category) { where.push("category = @category"); params.category = category; }
  if (q) {
    where.push("(title LIKE @q OR description LIKE @q OR url LIKE @q)");
    params.q = `%${q}%`;
  }

  const sql =
    `SELECT s.*, u.email as posted_by_email, u.tier as posted_by_tier, u.is_verified as posted_by_is_verified
     FROM scoops s
     LEFT JOIN users u ON u.id = s.posted_by_user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY s.created_at DESC
     LIMIT @limit OFFSET @offset`;

  params.limit = limit;
  params.offset = offset;
  const rows = db.prepare(sql).all(params);
  res.json({ scoops: rows });
});

app.post("/api/scoops", requireAuth(JWT_SECRET), upload.single("media"), async (req, res) => {
  // multipart/form-data fields live in req.body (strings)
  const schema = z.object({
    title: z.string().min(3).max(200),
    description: z.string().max(5000).optional().default(""),
    url: z.string().url().max(2048).optional().or(z.literal("")).default(""),
    category: z.string().min(2).max(50).optional().default(""),
    editMode: z.enum(["auto", "manual"]).optional().default("auto"),
    startSeconds: z.string().optional().default("0"),
    durationSeconds: z.string().optional().default("60"),
    preset: z.enum(["default", "vertical_9_16", "square_1_1"]).optional().default("default"),
    subtitles: z.string().optional().default("")
  });

  const parsed = schema.safeParse({
    title: req.body.title,
    description: req.body.description || "",
    url: req.body.url || "",
    category: req.body.category || "",
    editMode: req.body.editMode || "auto",
    startSeconds: req.body.startSeconds || "0",
    durationSeconds: req.body.durationSeconds || "60",
    preset: req.body.preset || "default",
    subtitles: req.body.subtitles || ""
  });
  if (!parsed.success) return res.status(400).json({ error: "Invalid scoop data" });

  const mediaPath = req.file ? `/uploads/${req.file.filename}` : null;
  const mediaType = req.file ? (req.file.mimetype || "application/octet-stream") : null;
  const isVideo = !!(req.file && (mediaType || "").startsWith("video/"));

  const finalCategory = parsed.data.category || categorizeScoop({
    title: parsed.data.title,
    description: parsed.data.description,
    url: parsed.data.url
  }).category;

  // Nonmembers can upload videos but cannot use AUTO edit.
  if (isVideo && parsed.data.editMode === "auto" && !tierAllowsAutoEdit(req.user)) {
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_e) {}
    return res.status(403).json({ error: "Auto edit is for members only. Choose Manual edit, or upgrade." });
  }

  // Monthly upload limits (videos only)
  if (isVideo) {
    const limit = monthlyVideoLimit(req.user);
    const used = getMonthlyVideoUploadsCount(req.user.id);
    if (Number.isFinite(limit) && used >= limit) {
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_e) {}
      return res.status(403).json({ error: `Monthly upload limit reached (${limit} videos/month).` });
    }
  }

  let clipPath = null;
  let editMode = parsed.data.editMode;
  let editStartSeconds = null;
  let editDurationSeconds = null;
  let editPreset = parsed.data.preset;
  let subtitlePath = null;
  const wantSubtitles = String(parsed.data.subtitles || "").toLowerCase() === "on";

  if (isVideo) {
    try {
      const tagline = "The Flys Scoop new scoop";
      if (editMode === "manual") {
        const out = await manualEditVideoToClip({
          inputAbsPath: req.file.path,
          uploadsDirAbsPath: UPLOADS_DIR,
          startSeconds: parsed.data.startSeconds,
          durationSeconds: parsed.data.durationSeconds,
          title: parsed.data.title,
          tagline,
          preset: editPreset,
          subtitles: wantSubtitles
        });
        clipPath = out.clipPath;
        editStartSeconds = out.startSeconds;
        editDurationSeconds = out.durationSeconds;
        editPreset = out.preset;
        subtitlePath = out.subtitleSrtPath || null;
      } else {
        const out = await autoEditVideoToClip({
          inputAbsPath: req.file.path,
          uploadsDirAbsPath: UPLOADS_DIR,
          title: parsed.data.title,
          tagline,
          category: finalCategory,
          subtitles: wantSubtitles
        });
        clipPath = out.clipPath;
        editStartSeconds = out.startSeconds;
        editDurationSeconds = out.durationSeconds;
        editPreset = out.preset;
        editMode = "auto";
        subtitlePath = out.subtitleSrtPath || null;
      }
      if (clipPath) clipPath = `/uploads/${path.basename(clipPath)}`;
      if (subtitlePath) subtitlePath = `/uploads/${path.basename(subtitlePath)}`;
    } catch (_e) {
      // best-effort; scoop still posts
    }
  }

  const tagline = "The Flys Scoop new scoop";
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO scoops
      (title, description, url, category, source, posted_by_user_id, created_at, ai_generated, media_type, media_path, clip_path, tagline, edit_mode, edit_start_seconds, edit_duration_seconds, edit_preset, subtitle_path, has_subtitles)
    VALUES
      (@title, @description, @url, @category, @source, @postedBy, @createdAt, @aiGenerated, @mediaType, @mediaPath, @clipPath, @tagline, @editMode, @editStart, @editDuration, @editPreset, @subtitlePath, @hasSubtitles)
  `).run({
    title: parsed.data.title,
    description: parsed.data.description,
    url: parsed.data.url || null,
    category: finalCategory,
    source: "member_upload",
    postedBy: req.user.id,
    createdAt: now,
    aiGenerated: 0,
    mediaType,
    mediaPath,
    clipPath,
    tagline,
    editMode,
    editStart: editStartSeconds,
    editDuration: editDurationSeconds,
    editPreset,
    subtitlePath,
    hasSubtitles: subtitlePath ? 1 : 0
  });

  const scoop = db.prepare("SELECT * FROM scoops WHERE id = ?").get(info.lastInsertRowid);
  res.json({ scoop });
});

app.post("/api/scoops/:id/feedback", requireAuth(JWT_SECRET), (req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({ type: z.enum(["up", "down"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid feedback" });

  const scoop = db.prepare("SELECT * FROM scoops WHERE id = ?").get(id);
  if (!scoop) return res.status(404).json({ error: "Not found" });

  recordFeedbackAndLearn({ scoop, userId: req.user.id, type: parsed.data.type });
  res.json({ ok: true });
});

// AI
app.post("/api/ai/run", requireAuth(JWT_SECRET), async (_req, res) => {
  try {
    const result = await runAiOnce();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: "AI run failed", detail: String(e) });
  }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(APP_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`The Flys Scoop running at http://localhost:${APP_PORT}`);
});

// Self-sufficient AI: periodically fetch scoops in the background.
// Set AI_AUTO_RUN_INTERVAL_MINUTES=0 to disable.
if (AI_AUTO_RUN_INTERVAL_MINUTES > 0) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runAiOnce();
    } catch (_e) {
      // ignore; best-effort
    } finally {
      running = false;
    }
  };
  // run shortly after boot, then on interval
  setTimeout(run, 5000);
  setInterval(run, AI_AUTO_RUN_INTERVAL_MINUTES * 60 * 1000);
}


