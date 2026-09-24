"""Generate the PWA icons — stdlib only, no image library.

Draws a rounded-square tile with three ascending bars in the sport hues,
supersampled 3x3 for smooth edges, and writes real PNGs by hand.

    ./venv/bin/python scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "static" / "icons"

BACKGROUND = (0x14, 0x14, 0x13)
BARS = [
    (0x2A, 0x78, 0xD6),   # swim blue
    (0xED, 0xA1, 0x00),   # ride amber
    (0xE8, 0x7B, 0xA4),   # run magenta
]
SAMPLES = 3  # per axis


def _rounded_rect(px: float, py: float, x0: float, y0: float,
                  x1: float, y1: float, radius: float) -> bool:
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + radius), x1 - radius)
    cy = min(max(py, y0 + radius), y1 - radius)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= radius * radius


def _shade(px: float, py: float, size: int, inset: float) -> tuple[int, int, int] | None:
    """Colour at a sample point, or None for transparent-outside-the-tile."""
    if not _rounded_rect(px, py, 0, 0, size, size, size * 0.22):
        return None

    # Bars live inside the content box; `inset` shrinks it for maskable icons.
    box = size * inset
    left = (size - box) / 2
    top = (size - box) / 2

    gap = box * 0.10
    bar_w = (box - 2 * gap) / 3
    heights = (0.42, 0.68, 1.0)
    radius = bar_w * 0.28

    for i, (colour, factor) in enumerate(zip(BARS, heights)):
        x0 = left + i * (bar_w + gap)
        h = box * factor
        y0 = top + box - h
        if _rounded_rect(px, py, x0, y0, x0 + bar_w, top + box, radius):
            return colour
    return BACKGROUND


def render(size: int, inset: float) -> bytes:
    rows = []
    step = 1.0 / SAMPLES
    weight = 1.0 / (SAMPLES * SAMPLES)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = 0.0
            for sy in range(SAMPLES):
                py = y + (sy + 0.5) * step
                for sx in range(SAMPLES):
                    px = x + (sx + 0.5) * step
                    colour = _shade(px, py, size, inset) or BACKGROUND
                    r += colour[0] * weight
                    g += colour[1] * weight
                    b += colour[2] * weight
            row += bytes((round(r), round(g), round(b)))
        rows.append(bytes(row))
    return b"".join(b"\x00" + row for row in rows)


def write_png(path: Path, size: int, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-180.png", 180, 0.56),
        ("icon-192.png", 192, 0.56),
        ("icon-512.png", 512, 0.56),
        # Maskable: keep the glyph inside the 80% safe zone Android may crop to.
        ("icon-maskable-512.png", 512, 0.44),
    ]
    for name, size, inset in targets:
        write_png(OUT_DIR / name, size, render(size, inset))
        print(f"  {name}  {size}x{size}")
    print(f"Icons written to {OUT_DIR}")


if __name__ == "__main__":
    main()
