"""Daily digest video renderer.

Turns data/daily_digest.json into a video: a title card, then one beat per
story (the map flown to where the story happened, with a lower third), then
an outro. The audio track is added later by the voice step (piper); this
module produces the silent cut and the storyboard that describes it.

PIPELINE
    digest.json ──► storyboard.json ──► frames/*.png ──► ffmpeg ──► mp4

Usage:
    python3 -m worker.digest_render --dry-run          # storyboard only
    python3 -m worker.digest_render                     # render the video
    python3 -m worker.digest_render --out data/digest_video
    python3 -m worker.digest_render --url http://localhost:8080
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DIGEST = os.path.join(REPO, "data", "daily_digest.json")
DEFAULT_OUT_DIR = os.path.join(REPO, "data", "digest_video")
RENDER_PAGE = "/digest-render.html"

WIDTH = 1920
HEIGHT = 1080
FPS = 30
TITLE_SECONDS = 4.0
STORY_SECONDS = 5.0
OUTRO_SECONDS = 3.0


def _log(msg: str) -> None:
    print(f"[render] {msg}", flush=True)


# ── storyboard ────────────────────────────────────────────────────────────

@dataclass
class Beat:
    kind: str                 # "title" | "story" | "outro"
    seconds: float
    rank: int = 0
    headline: str = ""
    where: str = ""
    why: str = ""
    narration: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    zoom: int = 6
    sources: list = field(default_factory=list)


def build_storyboard(digest: dict, seconds_per_story: float = STORY_SECONDS) -> list[Beat]:
    """One beat per story, in digest order."""
    beats: list[Beat] = []
    generated = digest.get("generated_at") or ""
    when = ""
    if generated:
        try:
            when = datetime.fromisoformat(generated).strftime("%A %d %B %Y")
        except ValueError:
            when = generated[:10]

    beats.append(Beat(kind="title", seconds=TITLE_SECONDS, headline="XYZO Daily", where=when))

    for s in digest.get("stories", []):
        place = ", ".join(p for p in [s.get("place"), s.get("country")] if p)
        beats.append(
            Beat(
                kind="story",
                seconds=seconds_per_story,
                rank=int(s.get("rank") or 0),
                headline=s.get("headline_en") or s.get("headline") or "",
                where=place,
                why=s.get("why") or "",
                narration=s.get("narration") or "",
                lat=s.get("lat"),
                lng=s.get("lng"),
                zoom=6,
                sources=s.get("sources") or [],
            )
        )

    beats.append(Beat(kind="outro", seconds=OUTRO_SECONDS))
    return beats


def write_storyboard(beats: list[Beat], path: str, digest: dict) -> None:
    payload = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "digest_generated_at": digest.get("generated_at"),
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "duration_seconds": round(sum(b.seconds for b in beats), 2),
        "beats": [
            {
                "kind": b.kind, "seconds": b.seconds, "rank": b.rank,
                "headline": b.headline, "where": b.where, "why": b.why,
                "narration": b.narration, "lat": b.lat, "lng": b.lng,
                "zoom": b.zoom,
            }
            for b in beats
        ],
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)


# ── frame capture ─────────────────────────────────────────────────────────

async def capture_frames(beats: list[Beat], url: str, out_dir: str) -> list[str]:
    """Screenshot one frame per beat with Playwright."""
    from playwright.async_api import async_playwright

    os.makedirs(out_dir, exist_ok=True)
    frames: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            device_scale_factor=1,
        )
        page = await ctx.new_page()
        target = url.rstrip("/") + RENDER_PAGE
        await page.goto(target, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_function("() => window.mapReady === true", timeout=30000)
        await page.wait_for_timeout(1200)

        for i, beat in enumerate(beats):
            if beat.kind == "title":
                await page.evaluate(
                    "(o) => window.renderTitle(o)", {"date": beat.where}
                )
            elif beat.kind == "story":
                await page.evaluate(
                    "(s) => window.renderStory(s)",
                    {
                        "rank": beat.rank, "headline": beat.headline,
                        "where": beat.where, "why": beat.why,
                        "lat": beat.lat, "lng": beat.lng, "zoom": beat.zoom,
                    },
                )
                await page.evaluate("() => window.tilesReady()")
            else:
                await page.evaluate(
                    """() => {
                        document.getElementById('titlecard').hidden = false;
                        document.getElementById('lower').hidden = true;
                        document.getElementById('map').style.opacity = '0';
                        document.getElementById('title-date').textContent = 'More at xyzo.org';
                    }"""
                )
            await page.wait_for_timeout(400)
            path = os.path.join(out_dir, f"{i:03d}.png")
            await page.screenshot(path=path)
            frames.append(path)
            _log(f"frame {i:03d} {beat.kind}")

        await browser.close()
    return frames


# ── assembly ──────────────────────────────────────────────────────────────

def assemble(frames: list[str], beats: list[Beat], out_file: str) -> bool:
    """ffmpeg: one still per beat, with a simple crossfade between them."""
    if not frames:
        return False
    if not shutil.which("ffmpeg"):
        _log("ffmpeg is not installed — cannot assemble the video")
        return False

    work = tempfile.mkdtemp(prefix="digest-render-")
    try:
        # One segment per beat: a still image held for its duration.
        segs = []
        for i, (frame, beat) in enumerate(zip(frames, beats)):
            seg = os.path.join(work, f"seg{i:03d}.mp4")
            cmd = [
                "ffmpeg", "-y", "-loglevel", "error",
                "-loop", "1", "-i", frame,
                "-t", f"{beat.seconds:.3f}",
                "-r", str(FPS),
                "-vf", f"scale={WIDTH}:{HEIGHT},format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                seg,
            ]
            subprocess.run(cmd, check=True)
            segs.append(seg)

        # Concat with crossfades (xfade needs a uniform chain).
        inputs: list[str] = []
        for seg in segs:
            inputs += ["-i", seg]

        filters = []
        cur = "[0:v]"
        for i in range(1, len(segs)):
            label = f"[v{i}]"
            offset = sum(b.seconds for b in beats[:i]) - 0.4
            filters.append(
                f"{cur}[{i}:v]xfade=transition=fade:duration=0.4:offset={offset:.3f}{label}"
            )
            cur = label

        os.makedirs(os.path.dirname(out_file), exist_ok=True)
        cmd = ["ffmpeg", "-y", "-loglevel", "error"] + inputs
        if filters:
            cmd += ["-filter_complex", ";".join(filters), "-map", cur]
        else:
            cmd += ["-map", "0:v"]
        cmd += [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            out_file,
        ]
        subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as exc:
        _log(f"ffmpeg failed: {exc}")
        return False
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── main ──────────────────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Render the daily digest video")
    ap.add_argument("--digest", default=DEFAULT_DIGEST)
    ap.add_argument("--out", default=DEFAULT_OUT_DIR)
    ap.add_argument("--url", default=os.environ.get("XYZO_SITE_URL", "https://xyzo.org"),
                    help="base URL of the site (the render page is served from it)")
    ap.add_argument("--seconds-per-story", type=float, default=STORY_SECONDS)
    ap.add_argument("--dry-run", action="store_true", help="storyboard only, no video")
    ap.add_argument("--keep-frames", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.digest):
        _log(f"no digest at {args.digest} — run worker/daily_digest.py first")
        return 1
    with open(args.digest, "r", encoding="utf-8") as fh:
        digest = json.load(fh)

    beats = build_storyboard(digest, args.seconds_per_story)
    os.makedirs(args.out, exist_ok=True)
    sb_path = os.path.join(args.out, "storyboard.json")
    write_storyboard(beats, sb_path, digest)
    total = sum(b.seconds for b in beats)
    _log(f"storyboard: {len(beats)} beats, {total:.1f}s -> {sb_path}")

    for b in beats:
        if b.kind == "story":
            _log(f"  #{b.rank} {b.headline[:70]}")

    if args.dry_run:
        _log("dry run — no frames captured")
        return 0

    frames_dir = os.path.join(args.out, "frames")
    try:
        import asyncio
        frames = asyncio.run(capture_frames(beats, args.url, frames_dir))
    except Exception as exc:  # noqa: BLE001
        _log(f"frame capture failed: {exc}")
        return 1

    mp4 = os.path.join(args.out, "xyzo-daily.mp4")
    if assemble(frames, beats, mp4):
        size = os.path.getsize(mp4) / 1024
        _log(f"wrote {mp4} ({size:.0f} KB, {total:.1f}s)")
    else:
        _log("frames captured but the video could not be assembled")
        return 1

    if not args.keep_frames:
        shutil.rmtree(frames_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
