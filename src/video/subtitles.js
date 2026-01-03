const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

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

async function ensureFasterWhisperInstalled() {
  // Best-effort installer (local user machine). If it fails, we just skip subtitles.
  if (process.env.WHISPER_AUTO_INSTALL === "0") return { ok: false, skipped: true };

  const py = resolvePython();
  const check = await spawnCollect(py, ["-c", "import faster_whisper; print('ok')"]);
  if (check.code === 0) return { ok: true };

  const pip = await spawnCollect(py, ["-m", "pip", "install", "--quiet", "faster-whisper"]);
  if (pip.code === 0) return { ok: true, installed: true };
  return { ok: false, error: pip.stderr || pip.stdout };
}

async function transcribeToSrtBestEffort({
  inputAbsPath,
  uploadsDirAbsPath,
  language = process.env.WHISPER_LANGUAGE || "en",
  model = process.env.WHISPER_MODEL || "small"
}) {
  if (!fs.existsSync(inputAbsPath)) return null;

  // Allow disabling subtitles entirely.
  if (process.env.WHISPER_ENABLED === "0") return null;

  const ensure = await ensureFasterWhisperInstalled();
  if (!ensure.ok) return null;

  const srtName = `${path.basename(inputAbsPath, path.extname(inputAbsPath))}.srt`;
  const srtPath = path.join(uploadsDirAbsPath, srtName);

  const py = resolvePython();
  const script = path.join(__dirname, "..", "..", "scripts", "whisper_transcribe.py");

  const run = await spawnCollect(py, [
    script,
    "--input", inputAbsPath,
    "--output_srt", srtPath,
    "--language", language,
    "--model", model
  ]);
  if (run.code !== 0) return null;
  if (!fs.existsSync(srtPath)) return null;
  return srtPath;
}

module.exports = { transcribeToSrtBestEffort };


