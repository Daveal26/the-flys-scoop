const { db } = require("./db");

function hasTable(name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function ensureUserColumn(name, ddl) {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE users ADD COLUMN ${ddl};`);
}

function ensureScoopColumn(name, ddl) {
  const cols = db.prepare("PRAGMA table_info(scoops)").all().map(r => r.name);
  if (cols.includes(name)) return;
  db.exec(`ALTER TABLE scoops ADD COLUMN ${ddl};`);
}

function runMigrationsIfNeeded() {
  if (!hasTable("users")) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        tier TEXT NOT NULL DEFAULT 'free',            -- free (nonmember), member, verified
        is_verified INTEGER NOT NULL DEFAULT 0,       -- paid verification flag
        socials_json TEXT                             -- verified users can store socials here
      );
    `);
  }
  // If users table already existed, ensure tier/verification fields exist.
  if (hasTable("users")) {
    ensureUserColumn("tier", "tier TEXT NOT NULL DEFAULT 'free'");
    ensureUserColumn("is_verified", "is_verified INTEGER NOT NULL DEFAULT 0");
    ensureUserColumn("socials_json", "socials_json TEXT");
    ensureUserColumn("stripe_customer_id", "stripe_customer_id TEXT");
    ensureUserColumn("stripe_verified_at", "stripe_verified_at TEXT");
  }

  if (!hasTable("categories")) {
    db.exec(`
      CREATE TABLE categories (
        name TEXT PRIMARY KEY
      );
    `);
  }

  if (!hasTable("scoops")) {
    db.exec(`
      CREATE TABLE scoops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        url TEXT UNIQUE,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        posted_by_user_id INTEGER,
        created_at TEXT NOT NULL,
        ai_generated INTEGER NOT NULL DEFAULT 0,
        media_type TEXT,
        media_path TEXT,
        clip_path TEXT,
        tagline TEXT NOT NULL,
        FOREIGN KEY(posted_by_user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_scoops_created_at ON scoops(created_at DESC);
      CREATE INDEX idx_scoops_category ON scoops(category);
    `);
  }
  // If scoops table already existed, ensure new edit metadata columns exist.
  if (hasTable("scoops")) {
    ensureScoopColumn("edit_mode", "edit_mode TEXT");
    ensureScoopColumn("edit_start_seconds", "edit_start_seconds REAL");
    ensureScoopColumn("edit_duration_seconds", "edit_duration_seconds REAL");
    ensureScoopColumn("edit_preset", "edit_preset TEXT");
    ensureScoopColumn("subtitle_path", "subtitle_path TEXT");
    ensureScoopColumn("has_subtitles", "has_subtitles INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasTable("feedback")) {
    db.exec(`
      CREATE TABLE feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scoop_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('up','down')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(scoop_id, user_id),
        FOREIGN KEY(scoop_id) REFERENCES scoops(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);
  }

  if (!hasTable("follows")) {
    db.exec(`
      CREATE TABLE follows (
        follower_user_id INTEGER NOT NULL,
        followee_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (follower_user_id, followee_user_id),
        FOREIGN KEY(follower_user_id) REFERENCES users(id),
        FOREIGN KEY(followee_user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_follows_follower ON follows(follower_user_id);
      CREATE INDEX idx_follows_followee ON follows(followee_user_id);
    `);
  }

  if (!hasTable("verification_requests")) {
    db.exec(`
      CREATE TABLE verification_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
        method TEXT NOT NULL DEFAULT 'manual', -- manual (cashapp/venmo)
        handle TEXT,                           -- optional payer handle/username
        note TEXT,                             -- optional note
        receipt_path TEXT,                     -- uploaded image/pdf path
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        reviewed_by TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_verreq_user ON verification_requests(user_id);
      CREATE INDEX idx_verreq_status ON verification_requests(status);
    `);
  }

  if (!hasTable("membership_requests")) {
    db.exec(`
      CREATE TABLE membership_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
        method TEXT NOT NULL DEFAULT 'manual', -- manual (cashapp/venmo)
        handle TEXT,
        note TEXT,
        receipt_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        reviewed_by TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE INDEX idx_memreq_user ON membership_requests(user_id);
      CREATE INDEX idx_memreq_status ON membership_requests(status);
    `);
  }

  if (!hasTable("category_keyword_weights")) {
    db.exec(`
      CREATE TABLE category_keyword_weights (
        category TEXT NOT NULL,
        keyword TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY(category, keyword)
      );
      CREATE INDEX idx_ckw_category ON category_keyword_weights(category);
    `);
  }
}

module.exports = { runMigrationsIfNeeded };

if (require.main === module) {
  runMigrationsIfNeeded();
  // eslint-disable-next-line no-console
  console.log("Migrations complete.");
}



