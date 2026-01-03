const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// For production (Fly.io), set DATA_DIR=/data to persist across deploys (volume mount).
const DB_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DB_DIR, "app.sqlite");

function ensureDbDir() {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

ensureDbDir();
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

module.exports = { db, DB_PATH, DB_DIR, ensureDbDir };



