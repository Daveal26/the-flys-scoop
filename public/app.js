const API = {
  async _fetchWithTimeout(path, init, timeoutMs = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(path, { ...init, signal: ctrl.signal });
      return r;
    } finally {
      clearTimeout(t);
    }
  },
  async get(path) {
    try {
      const r = await API._fetchWithTimeout(path, { headers: authHeaders() }, 9000);
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || "Non-JSON response" }; }
      if (!r.ok) return { error: cleanApiError(data?.error || `HTTP ${r.status}`) };
      return data;
    } catch (e) {
      const msg = (e && e.name === "AbortError") ? "Request timed out" : (e?.message || e);
      return { error: `Network error: ${msg}` };
    }
  },
  async post(path, body) {
    try {
      const r = await API._fetchWithTimeout(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body || {})
      }, 12000);
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || "Non-JSON response" }; }
      if (!r.ok) return { error: cleanApiError(data?.error || `HTTP ${r.status}`) };
      return data;
    } catch (e) {
      const msg = (e && e.name === "AbortError") ? "Request timed out" : (e?.message || e);
      return { error: `Network error: ${msg}` };
    }
  },
  async postForm(path, formData) {
    try {
      const r = await API._fetchWithTimeout(path, {
        method: "POST",
        headers: { ...authHeaders() },
        body: formData
      }, 30000);
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || "Non-JSON response" }; }
      if (!r.ok) return { error: cleanApiError(data?.error || `HTTP ${r.status}`) };
      return data;
    } catch (e) {
      const msg = (e && e.name === "AbortError") ? "Request timed out" : (e?.message || e);
      return { error: `Network error: ${msg}` };
    }
  }
};

function cleanApiError(err) {
  const s = String(err || "");
  const low = s.toLowerCase();
  if (low.includes("not allowed by cors")) return "Blocked by backend CORS. Backend must allow your domain.";
  if (low.includes("dns_hostname")) return "Backend host is not reachable (DNS). Check Vercel rewrites + Fly URL.";
  if (low.includes("<!doctype html") || low.includes("<html")) return "Backend returned an HTML error page. Check backend logs/CORS.";
  if (s.length > 180) return s.slice(0, 180) + "…";
  return s || "Unknown error";
}

function authHeaders() {
  const token = localStorage.getItem("fotw_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function setSession({ token, user }) {
  if (token) localStorage.setItem("fotw_token", token);
  if (user) localStorage.setItem("fotw_user", JSON.stringify(user));
  refreshNav();
}

function clearSession() {
  localStorage.removeItem("fotw_token");
  localStorage.removeItem("fotw_user");
  refreshNav();
}

function getUser() {
  try { return JSON.parse(localStorage.getItem("fotw_user") || "null"); } catch { return null; }
}

function isAuthed() {
  return !!localStorage.getItem("fotw_token");
}

// UI routing (simple panels)
const panels = {
  scoops: document.getElementById("panelScoops"),
  ai: document.getElementById("panelAI"),
  upload: document.getElementById("panelUpload"),
  profile: document.getElementById("panelProfile")
};

function showPanel(name) {
  for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
}

// Nav
const navHome = document.getElementById("navHome");
const navAI = document.getElementById("navAI");
const navUpload = document.getElementById("navUpload");
const navProfile = document.getElementById("navProfile");
const navLogin = document.getElementById("navLogin");
const navSignup = document.getElementById("navSignup");
const navLogout = document.getElementById("navLogout");
const userPill = document.getElementById("userPill");

function refreshNav() {
  const user = getUser();
  const authed = isAuthed();

  navLogin.hidden = authed;
  navSignup.hidden = authed;
  navLogout.hidden = !authed;

  userPill.hidden = !authed;
  if (authed && user?.email) {
    const badge = user?.isVerified ? " (Verified)" : (user?.tier ? ` (${user.tier})` : "");
    userPill.textContent = user.email + badge;
  }
}

navHome.addEventListener("click", () => { showPanel("scoops"); });
navAI.addEventListener("click", () => {
  if (!isAuthed()) return openAuth("login");
  showPanel("ai");
});
navUpload.addEventListener("click", () => {
  if (!isAuthed()) return openAuth("login");
  showPanel("upload");
});
navProfile.addEventListener("click", async () => {
  if (!isAuthed()) return openAuth("login");
  showPanel("profile");
  await loadProfile();
});
navLogin.addEventListener("click", () => openAuth("login"));
navSignup.addEventListener("click", () => openAuth("signup"));
navLogout.addEventListener("click", () => { clearSession(); showPanel("scoops"); });

// Auth modal
const authModal = document.getElementById("authModal");
const authTitle = document.getElementById("authTitle");
const authSubmit = document.getElementById("authSubmit");
const authForm = document.getElementById("authForm");
const authStatus = document.getElementById("authStatus");

let authMode = "login";
function openAuth(mode) {
  authMode = mode;
  authTitle.textContent = mode === "signup" ? "Sign up" : "Login";
  authSubmit.textContent = "Continue";
  authStatus.textContent = "";
  authModal.hidden = false;
}
function closeAuth() { authModal.hidden = true; }

authModal.addEventListener("click", (e) => {
  const t = e.target;
  if (t && t.dataset && t.dataset.close) closeAuth();
});

// Always allow Escape to close the modal (helps if network is slow).
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !authModal.hidden) closeAuth();
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authStatus.textContent = "Working…";
  authSubmit.disabled = true;
  const fd = new FormData(authForm);
  const email = String(fd.get("email") || "");
  const password = String(fd.get("password") || "");

  const path = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
  const out = await API.post(path, { email, password });
  if (out?.token) {
    setSession({ token: out.token, user: out.user });
    authStatus.textContent = "Done.";
    closeAuth();
  } else {
    authStatus.textContent = out?.error || "Auth failed";
  }
  authSubmit.disabled = false;
});

// Categories
const categorySelect = document.getElementById("categorySelect");
const uploadCategorySelect = document.getElementById("uploadCategorySelect");

async function loadCategories() {
  const out = await API.get("/api/categories");
  const categories = ["All", ...(out.categories || [])];
  categorySelect.innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const uploadCats = (out.categories || []);
  uploadCategorySelect.innerHTML = [
    `<option value="">Auto</option>`,
    ...uploadCats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
  ].join("");
}

// Scoops feed
const scoopsList = document.getElementById("scoopsList");
const searchInput = document.getElementById("searchInput");
const refreshBtn = document.getElementById("refreshBtn");

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return String(iso || ""); }
}

function renderScoopCard(s) {
  const tagline = s.tagline || "The Flys Scoop new scoop";
  const source = s.source || "unknown";
  const who = s.posted_by_email ? `member: ${s.posted_by_email}` : "fly-bot";
  const verified = Number(s.posted_by_is_verified || 0) === 1;

  const hasVideo = (s.clip_path || s.media_path) && String(s.media_type || "").startsWith("video/");
  const hasImage = s.media_path && String(s.media_type || "").startsWith("image/");
  const mediaUrl = s.clip_path || s.media_path;

  const link = s.url ? `<a class="btn" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">Open link</a>` : "";
  const postedById = s.posted_by_user_id ? Number(s.posted_by_user_id) : null;
  const viewer = getUser();
  const canFollow = !!(viewer && (viewer.tier === "member" || viewer.tier === "verified" || viewer.isVerified));
  const notSelf = postedById && viewer && Number(viewer.id) !== postedById;
  const followBtn = (postedById && canFollow && notSelf)
    ? `<button class="btn" data-follow="${postedById}">${followingSet.has(postedById) ? "Unfollow" : "Follow"}</button>`
    : "";
  const viewProfileBtn = postedById
    ? `<button class="btn" data-viewprofile="${postedById}">View profile</button>`
    : "";

  const mediaBlock = mediaUrl ? `
    <div class="media">
      ${hasVideo ? `<video controls src="${escapeHtml(mediaUrl)}"></video>` : ""}
      ${hasImage ? `<img alt="Scoop media" src="${escapeHtml(mediaUrl)}" />` : ""}
      ${(!hasVideo && !hasImage) ? `<div class="muted" style="padding:12px">Media attached</div>` : ""}
    </div>
  ` : "";

  return `
    <div class="card">
      <div class="card-head">
        <div class="tagline">
          <img src="/assets/fly.svg" alt="fly" style="width:16px;height:16px" />
          ${escapeHtml(tagline)}
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end">
          ${verified ? `<div class="pill" style="border-color: rgba(52,211,153,.35); color:#a7f3d0">Verified ✓</div>` : ""}
          <div class="pill">${escapeHtml(s.category)}</div>
        </div>
      </div>
      <div class="title">${escapeHtml(s.title)}</div>
      <div class="meta">
        <div class="pill">${escapeHtml(who)}</div>
        <div class="pill">${escapeHtml(source)}</div>
        <div class="pill">${escapeHtml(fmtDate(s.created_at))}</div>
      </div>
      ${s.description ? `<div class="desc">${escapeHtml(s.description)}</div>` : ""}
      ${mediaBlock}
      <div class="actions">
        ${link}
        ${viewProfileBtn}
        ${followBtn}
        <button class="btn" data-up="${s.id}">Upvote</button>
        <button class="btn danger" data-down="${s.id}">Downvote</button>
      </div>
    </div>
  `;
}

function cacheKeyForScoops(params) {
  return `tfs_scoops_cache:${params.toString()}`;
}

function loadScoopsCache(params) {
  try {
    const raw = localStorage.getItem(cacheKeyForScoops(params));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.scoops)) return null;
    // consider cache fresh for 10 minutes
    if (Date.now() - Number(parsed.savedAt || 0) > 10 * 60 * 1000) return null;
    return parsed.scoops;
  } catch {
    return null;
  }
}

function saveScoopsCache(params, scoops) {
  try {
    localStorage.setItem(cacheKeyForScoops(params), JSON.stringify({ savedAt: Date.now(), scoops }));
  } catch {
    // ignore quota
  }
}

async function loadScoops() {
  const cat = categorySelect.value;
  const q = searchInput.value.trim();
  const params = new URLSearchParams();
  if (cat && cat !== "All") params.set("category", cat);
  if (q) params.set("q", q);

  // Show cached scoops immediately for fast UX, then refresh in background.
  const cached = loadScoopsCache(params);
  if (cached && cached.length) {
    scoopsList.innerHTML = cached.map(renderScoopCard).join("");
  } else {
    scoopsList.innerHTML = `<div class="card"><div class="muted">Loading…</div></div>`;
  }

  const out = await API.get(`/api/scoops?${params.toString()}`);
  if (out?.error) {
    // If cache exists, keep it and show a small hint instead of blanking the feed.
    if (cached && cached.length) return;
    scoopsList.innerHTML = `<div class="card"><div class="muted"><b>Can’t load scoops:</b> ${escapeHtml(out.error)}<br/>If you’re on the Vercel domain, this usually means the backend proxy (/api) isn’t connected to Fly yet, Fly is cold-starting, or Fly isn’t allowing your domain origin.</div></div>`;
    return;
  }
  const scoops = out.scoops || [];
  saveScoopsCache(params, scoops);

  if (scoops.length === 0) {
    scoopsList.innerHTML = `<div class="card"><div class="muted">No scoops yet. Try running the AI Finder or uploading one.</div></div>`;
    return;
  }

  scoopsList.innerHTML = scoops.map(renderScoopCard).join("");
}

refreshBtn.addEventListener("click", loadScoops);
categorySelect.addEventListener("change", loadScoops);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadScoops();
});

// Feedback
scoopsList.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const follow = t.dataset.follow;
  const viewp = t.dataset.viewprofile;
  const up = t.dataset.up;
  const down = t.dataset.down;
  const id = up || down;
  if (viewp) {
    await openUserProfile(Number(viewp));
    return;
  }
  if (follow) {
    if (!isAuthed()) return openAuth("login");
    const target = Number(follow);
    const already = followingSet.has(target);
    if (already) await fetch(`/api/follow/${target}`, { method: "DELETE", headers: authHeaders() });
    else await fetch(`/api/follow/${target}`, { method: "POST", headers: authHeaders() });
    await refreshFollowing();
    await loadScoops();
    return;
  }
  if (!id) return;

  if (!isAuthed()) return openAuth("login");
  const type = up ? "up" : "down";
  await API.post(`/api/scoops/${id}/feedback`, { type });
  // no need to reload; this is training
  t.textContent = type === "up" ? "Upvoted ✓" : "Downvoted ✓";
  t.disabled = true;
});

// AI Runner
const runAiBtn = document.getElementById("runAiBtn");
const aiResult = document.getElementById("aiResult");

runAiBtn.addEventListener("click", async () => {
  if (!isAuthed()) return openAuth("login");
  aiResult.innerHTML = `<div class="muted">Searching RSS sources…</div>`;
  const out = await API.post("/api/ai/run", {});
  if (!out.ok) {
    aiResult.innerHTML = `<div class="muted">Failed: ${escapeHtml(out.error || "Unknown error")}</div>`;
    return;
  }

  const rows = out.result?.results || [];
  aiResult.innerHTML = `
    <div class="h2">Run complete</div>
    <div class="muted" style="margin-top:8px">
      ${rows.map(r => `${escapeHtml(r.source)}: ${r.ok ? `scanned ${r.scanned}, inserted ${r.inserted}` : `error`}`).join("<br/>")}
    </div>
    <div style="margin-top:12px">
      <button class="btn" id="aiToFeed">View new scoops</button>
    </div>
  `;
  const btn = document.getElementById("aiToFeed");
  btn?.addEventListener("click", async () => {
    showPanel("scoops");
    await loadScoops();
  });
});

// Following state (members only)
let followingSet = new Set();
async function refreshFollowing() {
  followingSet = new Set();
  if (!isAuthed()) return;
  const user = getUser();
  const canFollow = !!(user && (user.tier === "member" || user.tier === "verified" || user.isVerified));
  if (!canFollow) return;
  const out = await API.get("/api/following");
  for (const id of (out.following || [])) followingSet.add(Number(id));
}

// Profile panel
const profileSummary = document.getElementById("profileSummary");
const upgradeMemberBtn = document.getElementById("upgradeMemberBtn");
const buyVerifyBtn = document.getElementById("buyVerifyBtn");
const verifiedCard = document.getElementById("verifiedCard");
const socialsStatus = document.getElementById("socialsStatus");
const socInstagram = document.getElementById("socInstagram");
const socTikTok = document.getElementById("socTikTok");
const socX = document.getElementById("socX");
const socYouTube = document.getElementById("socYouTube");
const socWebsite = document.getElementById("socWebsite");
const saveSocialsBtn = document.getElementById("saveSocialsBtn");
const verifyRequestCard = document.getElementById("verifyRequestCard");
const cashappLink = document.getElementById("cashappLink");
const venmoLink = document.getElementById("venmoLink");
const verifyStatus = document.getElementById("verifyStatus");
const verifyForm = document.getElementById("verifyForm");
const verifySubmitStatus = document.getElementById("verifySubmitStatus");

async function loadProfile() {
  if (!isAuthed()) return;
  const out = await API.get("/api/profile");
  if (out?.user) setSession({ token: localStorage.getItem("fotw_token"), user: out.user });

  const u = out.user;
  const tier = u?.tier || "free";
  const verified = !!u?.isVerified || tier === "verified";
  const used = out.uploads?.used ?? 0;
  const limit = out.uploads?.limit; // null means unlimited
  const limitText = limit == null ? "Unlimited" : `${limit}/month`;

  profileSummary.innerHTML = `
    <div><b>Email:</b> ${escapeHtml(u.email)}</div>
    <div style="margin-top:6px"><b>Tier:</b> ${escapeHtml(tier)} ${verified ? " • <b>Trusted Verified ✓</b>" : ""}</div>
    <div style="margin-top:6px"><b>Video uploads this month:</b> ${escapeHtml(String(used))} / ${escapeHtml(limitText)}</div>
    <div style="margin-top:6px"><b>Auto edit:</b> ${tier === "member" || verified ? "Enabled" : "Locked (members only)"}</div>
    <div style="margin-top:6px"><b>Follow:</b> ${tier === "member" || verified ? "Enabled" : "Locked (members only)"}</div>
  `;

  verifiedCard.hidden = !verified;

  // Manual verification card
  if (verifyRequestCard) verifyRequestCard.hidden = verified;
  const v = out.verification || {};
  const hasCash = !!v.cashappLink;
  const hasVenmo = !!v.venmoLink;
  if (cashappLink) {
    cashappLink.href = v.cashappLink || "#";
    cashappLink.style.display = "";
    cashappLink.setAttribute("aria-disabled", hasCash ? "false" : "true");
    cashappLink.textContent = hasCash ? "Open CashApp" : "CashApp (not set)";
  }
  if (venmoLink) {
    venmoLink.href = v.venmoLink || "#";
    venmoLink.style.display = "";
    venmoLink.setAttribute("aria-disabled", hasVenmo ? "false" : "true");
    venmoLink.textContent = hasVenmo ? "Open Venmo" : "Venmo (not set)";
  }
  if (verifyStatus) {
    const req = v.latestRequest;
    const linkHint = (!hasCash && !hasVenmo)
      ? `<div style="margin-top:8px">Admin hasn’t set payment links yet. Add <b>CASHAPP_LINK</b>/<b>VENMO_LINK</b> to <b>.env</b> and restart the server.</div>`
      : "";
    if (!req) verifyStatus.innerHTML = "Status: <b>No verification request submitted yet</b>" + linkHint;
    else verifyStatus.innerHTML = `Status: <b>${escapeHtml(req.status)}</b> • submitted ${escapeHtml(fmtDate(req.created_at))}` + linkHint;
  }
}

upgradeMemberBtn?.addEventListener("click", async () => {
  // Membership is free: upgrade immediately for older free accounts.
  socialsStatus.textContent = "Upgrading…";
  const out = await API.post("/api/profile/upgrade-member", {});
  socialsStatus.textContent = out?.ok ? "Upgraded ✓" : (out?.error || "Failed");
  await loadProfile();
  await refreshFollowing();
  await loadScoops();
});

buyVerifyBtn?.addEventListener("click", async () => {
  // Scroll user to the manual verification card
  showPanel("profile");
  await loadProfile();
  verifyRequestCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  // If CashApp/Venmo links are configured, open one immediately to feel responsive.
  const cashHref = cashappLink?.getAttribute("aria-disabled") === "false" ? cashappLink?.href : null;
  const venmoHref = venmoLink?.getAttribute("aria-disabled") === "false" ? venmoLink?.href : null;
  const href = cashHref || venmoHref;
  if (href) window.open(href, "_blank", "noopener,noreferrer");
});

saveSocialsBtn?.addEventListener("click", async () => {
  socialsStatus.textContent = "Saving…";
  const payload = {
    instagram: socInstagram.value.trim(),
    tiktok: socTikTok.value.trim(),
    x: socX.value.trim(),
    youtube: socYouTube.value.trim(),
    website: socWebsite.value.trim()
  };
  const out = await API.post("/api/profile/socials", payload);
  socialsStatus.textContent = out?.ok ? "Saved ✓" : (out?.error || "Failed");
});

verifyForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAuthed()) return openAuth("login");
  verifySubmitStatus.textContent = "Submitting…";
  const fd = new FormData(verifyForm);
  const out = await API.postForm("/api/verification/request", fd);
  verifySubmitStatus.textContent = out?.ok ? "Submitted ✓ (pending review)" : (out?.error || "Failed");
  await loadProfile();
});


// Public profile modal (simple alert-style)
async function openUserProfile(userId) {
  const out = await API.get(`/api/users/${userId}`);
  if (out?.error) return;
  const u = out.user;
  const verified = !!u.isVerified;
  let socials = out.socials || null;
  const lines = [];
  lines.push(`Email: ${u.email}`);
  lines.push(`Tier: ${u.tier}${verified ? " (Verified ✓)" : ""}`);
  lines.push(`Followers: ${out.stats?.followers ?? 0} • Following: ${out.stats?.following ?? 0}`);
  if (verified && socials) {
    for (const [k, v] of Object.entries(socials)) {
      if (v) lines.push(`${k}: ${v}`);
    }
  }
  // Minimal UI: use browser dialog for now (fast). Can be upgraded to a modal later.
  window.alert(lines.join("\n"));
}

// Upload
const uploadForm = document.getElementById("uploadForm");
const uploadStatus = document.getElementById("uploadStatus");
const manualEditFields = document.getElementById("manualEditFields");
const editAuto = document.getElementById("editAuto");
const editManual = document.getElementById("editManual");

function refreshEditModeUI() {
  const mode = new FormData(uploadForm).get("editMode");
  manualEditFields.hidden = mode !== "manual";
}
uploadForm.addEventListener("change", (e) => {
  const t = e.target;
  if (t && t.name === "editMode") refreshEditModeUI();
});
refreshEditModeUI();

function refreshTierLocks() {
  const u = getUser();
  const canAuto = !!(u && (u.tier === "member" || u.tier === "verified" || u.isVerified));
  if (editAuto) editAuto.disabled = !canAuto;
  if (!canAuto && editManual) editManual.checked = true;
  refreshEditModeUI();
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAuthed()) return openAuth("login");

  uploadStatus.textContent = "Uploading…";
  const fd = new FormData(uploadForm);
  const out = await API.postForm("/api/scoops", fd);
  if (out?.scoop?.id) {
    uploadStatus.textContent = "Posted ✓";
    uploadForm.reset();
    refreshEditModeUI();
    refreshTierLocks();
    showPanel("scoops");
    await loadScoops();
  } else {
    uploadStatus.textContent = out?.error || "Upload failed";
  }
});

// Boot
(async function init() {
  refreshNav();
  if (isAuthed()) {
    // Refresh user object from server (tier/verified)
    const me = await API.get("/api/me");
    if (me?.user) setSession({ token: localStorage.getItem("fotw_token"), user: me.user });
    await refreshFollowing();
  }
  refreshTierLocks();
  await loadCategories();
  await loadScoops();
})();



