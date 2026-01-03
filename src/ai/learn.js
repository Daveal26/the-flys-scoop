const { db } = require("../db/db");
const { tokenize } = require("./categorize");

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function recordFeedbackAndLearn({ scoop, userId, type }) {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO feedback (scoop_id, user_id, type)
      VALUES (?, ?, ?)
      ON CONFLICT(scoop_id, user_id) DO UPDATE SET
        type=excluded.type,
        created_at=datetime('now')
    `).run(scoop.id, userId, type);

    // Lightweight "learning": adjust keyword weights toward tokens seen in good scoops,
    // and away from tokens seen in bad scoops (for the scoop's current category).
    const tokens = [
      ...tokenize(scoop.title),
      ...tokenize(scoop.description),
      ...tokenize(scoop.url)
    ];

    const direction = type === "up" ? 1 : -1;
    const delta = 0.05 * direction; // small, stable step

    const upsert = db.prepare(`
      INSERT INTO category_keyword_weights (category, keyword, weight)
      VALUES (@category, @keyword, @weight)
      ON CONFLICT(category, keyword) DO UPDATE SET
        weight = @newWeight
    `);

    const get = db.prepare(`
      SELECT weight FROM category_keyword_weights WHERE category = ? AND keyword = ?
    `);

    const uniqueTokens = Array.from(new Set(tokens)).slice(0, 50);
    for (const t of uniqueTokens) {
      const row = get.get(scoop.category, t);
      const cur = row ? Number(row.weight) : 1.0;
      const next = clamp(cur + delta, 0.1, 5.0);
      upsert.run({ category: scoop.category, keyword: t, weight: cur, newWeight: next });
    }
  });

  tx();
}

module.exports = { recordFeedbackAndLearn };



