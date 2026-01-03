const { db } = require("../db/db");

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/g)
    .map(t => t.trim())
    .filter(t => t && t.length >= 3);
}

function loadWeights() {
  const rows = db.prepare("SELECT category, keyword, weight FROM category_keyword_weights").all();
  const weights = new Map(); // category -> Map(keyword->weight)
  for (const r of rows) {
    if (!weights.has(r.category)) weights.set(r.category, new Map());
    weights.get(r.category).set(String(r.keyword).toLowerCase(), Number(r.weight));
  }
  return weights;
}

function scoreCategory(tokens, keywordWeights) {
  let score = 0;
  for (const t of tokens) {
    if (keywordWeights.has(t)) score += keywordWeights.get(t);
  }
  return score;
}

function categorizeScoop({ title, description, url }) {
  const tokens = [
    ...tokenize(title),
    ...tokenize(description),
    ...tokenize(url)
  ];

  const weights = loadWeights();
  const categories = db.prepare("SELECT name FROM categories").all().map(r => r.name);

  let best = { category: "Other", score: 0 };
  for (const c of categories) {
    const kw = weights.get(c) || new Map();
    const s = scoreCategory(tokens, kw);
    if (s > best.score) best = { category: c, score: s };
  }

  // If nothing matched, do a couple simple fallbacks
  if (best.score === 0) {
    const t = (title || "").toLowerCase();
    if (/(movie|film|cinema|box office)/.test(t)) best.category = "Movies";
    else if (/(tv|episode|season|series)/.test(t)) best.category = "TV";
    else if (/(rumor|rumour|dating|split|cheating|tea)/.test(t)) best.category = "Gossip";
    else if (/(trailer)/.test(t)) best.category = "Media";
    else best.category = "Trending";
  }

  return { category: best.category, confidence: Math.min(0.99, best.score / 8) };
}

module.exports = { categorizeScoop, tokenize };



