const { spawn } = require("child_process");
const path = require("path");

function spawnCollect(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", d => { stdout += d.toString(); });
    p.stderr?.on("data", d => { stderr += d.toString(); });
    p.on("error", reject);
    p.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function resolvePython() {
  return process.env.PYTHON_PATH || "python";
}

async function ensureOpenCvInstalled() {
  if (process.env.FACE_ENABLED === "0") return { ok: false, skipped: true };
  if (process.env.FACE_AUTO_INSTALL === "0") return { ok: false, skipped: true };

  const py = resolvePython();
  const check = await spawnCollect(py, ["-c", "import cv2; print('ok')"]);
  if (check.code === 0) return { ok: true };

  const pip = await spawnCollect(py, ["-m", "pip", "install", "--quiet", "opencv-python"]);
  if (pip.code === 0) return { ok: true, installed: true };
  return { ok: false };
}

async function faceCountsBySecondBestEffort({ inputAbsPath, fps = 2, maxSeconds = 600 }) {
  if (process.env.FACE_ENABLED === "0") return null;
  const ensure = await ensureOpenCvInstalled();
  if (!ensure.ok) return null;

  const py = resolvePython();
  const script = path.join(__dirname, "..", "..", "scripts", "face_score.py");
  const run = await spawnCollect(py, [
    script,
    "--input", inputAbsPath,
    "--fps", String(fps),
    "--max_seconds", String(maxSeconds)
  ]);
  if (run.code !== 0) return null;

  const map = new Map(); // sec -> count
  const lines = run.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [secStr, cntStr] = line.split(",");
    const sec = Number(secStr);
    const cnt = Number(cntStr);
    if (Number.isFinite(sec) && Number.isFinite(cnt)) map.set(sec, cnt);
  }
  return map;
}

module.exports = { faceCountsBySecondBestEffort };


