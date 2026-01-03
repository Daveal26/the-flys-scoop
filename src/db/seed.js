const { db } = require("./db");

const DEFAULT_CATEGORIES = [
  "News",
  "Media",
  "Movies",
  "TV",
  "Gossip",
  "Celebrity",
  "Music",
  "Sports",
  "Gaming",
  "Trending",
  "Other"
];

const DEFAULT_KEYWORDS = {
  News: ["breaking", "report", "announced", "lawsuit", "investigation", "exclusive"],
  Media: ["interview", "podcast", "press", "behind the scenes", "trailer"],
  Movies: ["movie", "film", "box office", "director", "cast", "cinema", "trailer"],
  TV: ["tv", "episode", "season", "series", "showrunner", "premiere", "finale"],
  Gossip: ["rumor", "rumour", "spotted", "dating", "split", "cheating", "shade", "tea"],
  Celebrity: ["celebrity", "star", "paparazzi", "red carpet", "award", "met gala"],
  Music: ["single", "album", "tour", "concert", "producer", "billboard"],
  Sports: ["trade", "injury", "coach", "championship", "nba", "nfl", "mlb", "ufc"],
  Gaming: ["patch", "update", "dlc", "trailer", "esports", "ps5", "xbox", "steam"],
  Trending: ["viral", "trending", "internet", "meme", "tiktok", "youtube"],
  Other: []
};

function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) as c FROM categories").get().c;
  if (count === 0) {
    const ins = db.prepare("INSERT INTO categories (name) VALUES (?)");
    const tx = db.transaction(() => {
      for (const c of DEFAULT_CATEGORIES) ins.run(c);
    });
    tx();
  }

  const kwCount = db.prepare("SELECT COUNT(*) as c FROM category_keyword_weights").get().c;
  if (kwCount === 0) {
    const ins = db.prepare(`
      INSERT INTO category_keyword_weights (category, keyword, weight)
      VALUES (@category, @keyword, @weight)
    `);
    const tx = db.transaction(() => {
      for (const [category, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
        for (const keyword of keywords) {
          ins.run({ category, keyword: keyword.toLowerCase(), weight: 1.0 });
        }
      }
    });
    tx();
  }
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  seedIfEmpty();
  // eslint-disable-next-line no-console
  console.log("Seed complete.");
}



