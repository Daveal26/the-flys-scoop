import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True, help="Input video path")
    p.add_argument("--fps", type=float, default=2.0, help="Sample FPS (lower = faster)")
    p.add_argument("--max_seconds", type=int, default=600, help="Max seconds to analyze")
    args = p.parse_args()

    try:
        import cv2
    except Exception as e:
        print("Missing dependency: opencv-python. Install with:", file=sys.stderr)
        print("  pip install opencv-python", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 2

    in_path = Path(args.input)
    if not in_path.exists():
        print("Missing input file", file=sys.stderr)
        return 2

    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        print("Could not open video", file=sys.stderr)
        return 1

    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    face_cascade = cv2.CascadeClassifier(cascade_path)

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / max(0.1, args.fps))))

    counts = defaultdict(int)  # second -> face_hits
    frame_idx = 0
    max_frames = int(args.max_seconds * src_fps)

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx > max_frames:
            break
        if frame_idx % step != 0:
            frame_idx += 1
            continue

        t_sec = int(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        # accumulate number of faces (proxy for "face presence")
        counts[t_sec] += len(faces)

        frame_idx += 1

    cap.release()

    # Output as lines: "sec,count"
    for sec in sorted(counts.keys()):
        print(f"{sec},{counts[sec]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())




