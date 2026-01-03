const jwt = require("jsonwebtoken");
const { db } = require("../db/db");

function requireAuth(jwtSecret) {
  return (req, res, next) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });
    try {
      const payload = jwt.verify(token, jwtSecret);
      const row = db.prepare("SELECT id, email, tier, is_verified, socials_json FROM users WHERE id = ?").get(payload.sub);
      if (!row) return res.status(401).json({ error: "Invalid token" });
      req.user = {
        id: row.id,
        email: row.email,
        tier: row.tier || "free",
        isVerified: Number(row.is_verified) === 1,
        socialsJson: row.socials_json || null
      };
      next();
    } catch (_e) {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

module.exports = { requireAuth };



