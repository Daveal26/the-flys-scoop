import argparse
import os
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, help="Input media path (video/audio)")
    p.add_argument("--output_srt", required=True, help="Output .srt path")
    p.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "small"), help="Whisper model size/name")
    p.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cpu"), help="cpu/cuda (if available)")
    p.add_argument("--compute_type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"), help="int8/float16/float32")
    p.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE", "en"), help="Language code (e.g., en)")
    args = p.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output_srt)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print("Missing dependency: faster-whisper. Install with:", file=sys.stderr)
        print("  pip install faster-whisper", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        str(in_path),
        language=args.language,
        vad_filter=True,
        beam_size=5,
    )

    def fmt_ts(seconds: float) -> str:
        if seconds < 0:
            seconds = 0
        ms = int(round(seconds * 1000.0))
        h = ms // 3600000
        ms -= h * 3600000
        m = ms // 60000
        ms -= m * 60000
        s = ms // 1000
        ms -= s * 1000
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines = []
    i = 1
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        lines.append(str(i))
        lines.append(f"{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}")
        lines.append(text)
        lines.append("")
        i += 1

    out_path.write_text("\n".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())




