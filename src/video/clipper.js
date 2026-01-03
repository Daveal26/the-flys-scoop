const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { transcribeToSrtBestEffort } = require("./subtitles");
const { faceCountsBySecondBestEffort } = require("./faces");

function spawnAndWait(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", d => { stderr += d.toString(); });
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr}`));
    });
  });
}

function resolveFfmpeg() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function resolveFfprobe() {
  const ffmpeg = resolveFfmpeg();
  if (ffmpeg.toLowerCase().endsWith("ffmpeg.exe")) {
    const candidate = ffmpeg.slice(0, -9) + "ffprobe.exe";
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.env.FFPROBE_PATH || "ffprobe";
}

function escapeDrawtext(text) {
  // Escape for ffmpeg drawtext. Keep it simple and stable.
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ")
    .slice(0, 200);
}

function escapeForSubtitlesFilter(p) {
  // ffmpeg subtitles filter parsing on Windows is picky.
  // Use forward slashes and escape ':'.
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");
}

async function getVideoDurationSeconds(inputAbsPath) {
  const ffprobe = resolveFfprobe();
  // ffprobe prints duration in seconds (as a string float)
  // We avoid JSON parsing to keep dependencies minimal.
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nk=1:nw=1",
      inputAbsPath
    ];
    const p = spawn(ffprobe, args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", d => { out += d.toString(); });
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const n = Number(String(out).trim());
      if (!Number.isFinite(n) || n <= 0) return resolve(null);
      resolve(n);
    });
    p.on("error", () => resolve(null));
  });
}

async function findBestStartByLoudnessSeconds(inputAbsPath, windowSeconds) {
  // Uses ffmpeg astats metadata output to get per-second RMS loudness.
  // Returns the start time (seconds) for the loudest window.
  const ffmpeg = resolveFfmpeg();

  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-i", inputAbsPath,
      "-vn",
      "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f", "null",
      "-"
    ];

    const p = spawn(ffmpeg, args, { windowsHide: true });
    let buf = "";
    const points = []; // {t, rms}

    p.stderr.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        // Example lines:
        // frame:123 pts:... pts_time:12.000
        // lavfi.astats.Overall.RMS_level=-23.4
        const tMatch = line.match(/pts_time:([0-9.]+)/);
        if (tMatch) {
          // store last seen time in a temp slot
          points._lastT = Number(tMatch[1]);
          continue;
        }
        const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=([-0-9.]+)/);
        if (rmsMatch && Number.isFinite(points._lastT)) {
          const rms = Number(rmsMatch[1]);
          const t = Number(points._lastT);
          if (Number.isFinite(rms) && Number.isFinite(t)) points.push({ t, rms });
        }
      }
    });

    const finish = () => {
      if (!points.length) return resolve(5); // fallback
      // Bucket to seconds
      const buckets = new Map(); // sec -> rms (max)
      for (const pnt of points) {
        const sec = Math.max(0, Math.floor(pnt.t));
        const prev = buckets.get(sec);
        // Higher RMS_level is louder (e.g. -10 is louder than -30)
        if (prev === undefined || pnt.rms > prev) buckets.set(sec, pnt.rms);
      }
      const secs = Array.from(buckets.keys()).sort((a, b) => a - b);
      if (!secs.length) return resolve(5);
      const maxSec = secs[secs.length - 1];

      // Sliding window over seconds, maximizing average loudness
      let best = { start: 0, score: -Infinity };
      for (let s = 0; s <= maxSec; s++) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < windowSeconds; i++) {
          const v = buckets.get(s + i);
          if (v === undefined) continue;
          sum += v;
          count++;
        }
        if (count < Math.max(5, Math.floor(windowSeconds * 0.2))) continue;
        const avg = sum / count;
        if (avg > best.score) best = { start: s, score: avg };
      }

      // Avoid super-early clips that can be intros; add a tiny offset
      const start = Math.max(0, best.start);
      resolve(start);
    };

    p.on("error", () => resolve(5));
    p.on("close", () => finish());
  });
}

async function motionCountsBySecondBestEffort(inputAbsPath, maxSeconds = 600) {
  // Uses scene change detection as a proxy for motion/activity.
  // Returns Map(sec -> hits)
  const ffmpeg = resolveFfmpeg();
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-i", inputAbsPath,
      "-t", String(maxSeconds),
      "-an",
      "-vf", "select='gt(scene,0.25)',showinfo",
      "-f", "null",
      "-"
    ];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let buf = "";
    const hits = new Map();
    p.stderr.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        // showinfo includes pts_time
        const m = line.match(/pts_time:([0-9.]+)/);
        if (!m) continue;
        const t = Number(m[1]);
        if (!Number.isFinite(t)) continue;
        const sec = Math.max(0, Math.floor(t));
        hits.set(sec, (hits.get(sec) || 0) + 1);
      }
    });
    p.on("error", () => resolve(null));
    p.on("close", () => resolve(hits));
  });
}

function buildVideoFilter({ preset, title, tagline, subtitleSrtPath }) {
  const filters = [];

  // scale down for web
  filters.push("scale='min(1280,iw)':-2");

  // "Trend templates" (simple styling presets)
  // Note: true face detection would require heavier deps (e.g. OpenCV). This is a safe MVP.
  if (preset === "vertical_9_16") {
    // Center crop to vertical
    filters.push("crop=w='if(gt(iw,ih*9/16),ih*9/16,iw)':h='if(gt(iw,ih*9/16),ih,iw*16/9)':x='(iw-w)/2':y='(ih-h)/2'");
  } else if (preset === "square_1_1") {
    filters.push("crop=w='min(iw,ih)':h='min(iw,ih)':x='(iw-w)/2':y='(ih-h)/2'");
  }

  const safeTitle = escapeDrawtext(title);
  const safeTag = escapeDrawtext(tagline);
  if (safeTag) {
    filters.push(`drawtext=text='${safeTag}':font='Arial':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=24`);
  }
  if (safeTitle) {
    filters.push(`drawtext=text='${safeTitle}':font='Arial':fontcolor=white:fontsize=30:box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=h-96`);
  }

  if (subtitleSrtPath) {
    const s = escapeForSubtitlesFilter(subtitleSrtPath);
    // Burn-in subtitles (requires ffmpeg built with libass, which winget build typically includes)
    filters.push(`subtitles='${s}'`);
  }

  return filters.join(",");
}

async function createClipBestEffort({
  inputAbsPath,
  uploadsDirAbsPath,
  startSeconds,
  durationSeconds,
  title,
  tagline,
  preset,
  subtitleSrtPath
}) {
  const ffmpeg = resolveFfmpeg();
  if (!fs.existsSync(inputAbsPath)) return null;

  const ext = path.extname(inputAbsPath) || ".mp4";
  const outName = `${path.basename(inputAbsPath, ext)}_clip_${Date.now()}.mp4`;
  const outPath = path.join(uploadsDirAbsPath, outName);

  const vf = buildVideoFilter({ preset, title, tagline, subtitleSrtPath });

  try {
    await spawnAndWait(ffmpeg, [
      "-y",
      "-ss", String(Math.max(0, startSeconds || 0)),
      "-t", String(Math.max(1, durationSeconds || 60)),
      "-i", inputAbsPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      outPath
    ]);
    return outPath;
  } catch (_e) {
    return null;
  }
}

async function createOneMinuteClipIfPossible({ inputAbsPath, uploadsDirAbsPath }) {
  // Legacy default: 60s from ~5s with basic captions off.
  return await createClipBestEffort({
    inputAbsPath,
    uploadsDirAbsPath,
    startSeconds: 5,
    durationSeconds: 60,
    title: "",
    tagline: "",
    preset: "default"
  });
}

async function autoEditVideoToClip({
  inputAbsPath,
  uploadsDirAbsPath,
  title,
  tagline,
  category,
  subtitles = false
}) {
  const duration = await getVideoDurationSeconds(inputAbsPath);
  const windowSeconds = 60;
  let start = 5;

  // Analyze signals for adaptive selection
  const maxSeconds = duration ? Math.min(600, Math.floor(duration)) : 600;
  const [motionMap, faceMap] = await Promise.all([
    motionCountsBySecondBestEffort(inputAbsPath, maxSeconds),
    faceCountsBySecondBestEffort({ inputAbsPath, fps: 2, maxSeconds })
  ]);

  // Loudness buckets from astats
  const loudStart = await findBestStartByLoudnessSeconds(inputAbsPath, Math.min(windowSeconds, maxSeconds));

  // Build per-second signals (0..maxSeconds-1)
  const secs = Math.max(1, maxSeconds);
  const motionArr = new Array(secs).fill(0);
  const faceArr = new Array(secs).fill(0);
  if (motionMap) for (const [k, v] of motionMap.entries()) if (k < secs) motionArr[k] = v;
  if (faceMap) for (const [k, v] of faceMap.entries()) if (k < secs) faceArr[k] = v;

  // Determine if faces are a meaningful signal
  const faceTotal = faceArr.reduce((a, b) => a + b, 0);
  const faceWeight = faceTotal > 5 ? 0.35 : 0.0;
  // Motion weight depends on how much motion signal exists
  const motionTotal = motionArr.reduce((a, b) => a + b, 0);
  const motionWeightBase = motionTotal > 5 ? 0.35 : 0.15;
  // Loudness is always useful; remaining weight goes to loudness
  let loudWeight = 1.0 - faceWeight - motionWeightBase;
  loudWeight = Math.max(0.4, Math.min(0.7, loudWeight));
  const motionWeight = 1.0 - faceWeight - loudWeight;

  // Score windows by motion+faces and nudge toward loudness best start
  const window = windowSeconds;
  const maxStart = duration ? Math.max(0, Math.floor(duration - window)) : Math.max(0, secs - window);
  let best = { start: Math.max(0, Math.min(loudStart, maxStart)), score: -Infinity };

  const norm = (arr) => {
    const mx = Math.max(...arr);
    if (mx <= 0) return arr.map(() => 0);
    return arr.map(v => v / mx);
  };
  const motionN = norm(motionArr);
  const faceN = norm(faceArr);

  for (let s = 0; s <= maxStart; s++) {
    let m = 0;
    let f = 0;
    for (let i = 0; i < window; i++) {
      m += motionN[s + i] || 0;
      f += faceN[s + i] || 0;
    }
    m /= window;
    f /= window;
    const closeToLoud = 1.0 - Math.min(1.0, Math.abs(s - loudStart) / 120.0); // prefer near loudest within 2 minutes
    const score = (motionWeight * m) + (faceWeight * f) + (loudWeight * closeToLoud);
    if (score > best.score) best = { start: s, score };
  }

  start = best.start;
  if (duration) start = Math.max(0, Math.min(start, Math.max(0, duration - windowSeconds)));

  // Pick a "trend template" based on category (simple but useful)
  let preset = "default";
  const c = String(category || "").toLowerCase();
  if (/(tiktok|short|trend|viral)/.test(c)) preset = "vertical_9_16";
  else if (/(gossip|celebrity)/.test(c)) preset = "vertical_9_16";
  else if (/(gaming)/.test(c)) preset = "square_1_1";

  // Optional Whisper subtitles: transcribe the clip itself (faster) then burn-in.
  let subtitleSrtPath = null;
  if (subtitles) {
    // We'll first create a temp clip without subtitles, then transcribe it.
    const tmpClip = await createClipBestEffort({
      inputAbsPath,
      uploadsDirAbsPath,
      startSeconds: start,
      durationSeconds: windowSeconds,
      title,
      tagline,
      preset
    });
    if (tmpClip) {
      const srt = await transcribeToSrtBestEffort({
        inputAbsPath: tmpClip,
        uploadsDirAbsPath
      });
      if (srt) subtitleSrtPath = srt;
      if (subtitleSrtPath) {
        const burned = await createClipBestEffort({
          inputAbsPath,
          uploadsDirAbsPath,
          startSeconds: start,
          durationSeconds: windowSeconds,
          title,
          tagline,
          preset,
          subtitleSrtPath
        });
        return {
          clipPath: burned || tmpClip,
          startSeconds: start,
          durationSeconds: windowSeconds,
          preset,
          subtitleSrtPath
        };
      }
      return {
        clipPath: tmpClip,
        startSeconds: start,
        durationSeconds: windowSeconds,
        preset,
        subtitleSrtPath: null
      };
    }
  }

  const clipPath = await createClipBestEffort({
    inputAbsPath,
    uploadsDirAbsPath,
    startSeconds: start,
    durationSeconds: windowSeconds,
    title,
    tagline,
    preset
  });

  return { clipPath, startSeconds: start, durationSeconds: windowSeconds, preset, subtitleSrtPath: null };
}

async function manualEditVideoToClip({
  inputAbsPath,
  uploadsDirAbsPath,
  startSeconds,
  durationSeconds,
  title,
  tagline,
  preset,
  subtitles = false
}) {
  const duration = await getVideoDurationSeconds(inputAbsPath);
  let start = Number(startSeconds || 0);
  let len = Number(durationSeconds || 60);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(len) || len <= 0) len = 60;
  len = Math.min(300, Math.max(5, len));

  if (duration) {
    start = Math.min(start, Math.max(0, duration - 1));
    if (start + len > duration) len = Math.max(5, Math.floor(duration - start));
  }

  // For subtitles: generate clip, transcribe clip, then burn-in (best-effort)
  const baseClip = await createClipBestEffort({
    inputAbsPath,
    uploadsDirAbsPath,
    startSeconds: start,
    durationSeconds: len,
    title,
    tagline,
    preset: preset || "default"
  });
  if (!subtitles || !baseClip) {
    return { clipPath: baseClip, startSeconds: start, durationSeconds: len, preset: preset || "default", subtitleSrtPath: null };
  }

  const srt = await transcribeToSrtBestEffort({
    inputAbsPath: baseClip,
    uploadsDirAbsPath
  });
  if (!srt) {
    return { clipPath: baseClip, startSeconds: start, durationSeconds: len, preset: preset || "default", subtitleSrtPath: null };
  }

  const burned = await createClipBestEffort({
    inputAbsPath,
    uploadsDirAbsPath,
    startSeconds: start,
    durationSeconds: len,
    title,
    tagline,
    preset: preset || "default",
    subtitleSrtPath: srt
  });
  return { clipPath: burned || baseClip, startSeconds: start, durationSeconds: len, preset: preset || "default", subtitleSrtPath: srt };
}

module.exports = {
  createOneMinuteClipIfPossible,
  autoEditVideoToClip,
  manualEditVideoToClip
};



