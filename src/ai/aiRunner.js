const Parser = require("rss-parser");
const { db } = require("../db/db");
const { sources } = require("./rssSources");
const { categorizeScoop } = require("./categorize");

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "TheFlyOnTheWallBot/0.1 (+local)" }
});

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function upsertScoop({ title, description, url, category, sourceName }) {
  const tagline = "The Flys Scoop new scoop";
  const createdAt = new Date().toISOString();

  // Avoid dupes by URL if present; otherwise by title+source+day (very rough)
  const normUrl = normalizeUrl(url);
  if (normUrl) {
    const existing = db.prepare("SELECT id FROM scoops WHERE url = ?").get(normUrl);
    if (existing) return { inserted: false, id: existing.id };
  }

  const info = db.prepare(`
    INSERT INTO scoops
      (title, description, url, category, source, posted_by_user_id, created_at, ai_generated, media_type, media_path, clip_path, tagline)
    VALUES
      (@title, @description, @url, @category, @source, NULL, @createdAt, 1, NULL, NULL, NULL, @tagline)
  `).run({
    title: String(title || "").slice(0, 200),
    description: String(description || "").slice(0, 5000),
    url: normUrl,
    category,
    source: `rss:${sourceName}`,
    createdAt,
    tagline
  });
  return { inserted: true, id: info.lastInsertRowid };
}

async function runAiOnce() {
  const results = [];

  for (const s of sources) {
    if (!s?.url) continue;
    let feed;
    try {
      feed = await parser.parseURL(s.url);
    } catch (e) {
      results.push({ source: s.name, ok: false, error: String(e) });
      continue;
    }

    let inserted = 0;
    let scanned = 0;
    const items = Array.isArray(feed.items) ? feed.items.slice(0, 25) : [];
    for (const item of items) {
      scanned++;
      const title = item.title || "(untitled)";
      const url = item.link || item.guid || null;
      const description = item.contentSnippet || item.content || item.summary || "";
      const cat = categorizeScoop({ title, description, url }).category;
      const up = upsertScoop({ title, description, url, category: cat, sourceName: s.name });
      if (up.inserted) inserted++;
    }

    results.push({ source: s.name, ok: true, scanned, inserted });
  }

  return { results };
}

module.exports = { runAiOnce };



