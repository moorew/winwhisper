"""
Regenerates the WinWhisper app and tray icons from the mark specification.

The mark is three flat rounded bars on a 32x32 grid — width 6, gap 5, radius 3
(half the width, so the caps are full pills), heights 16 / 26 / 16, giving a
28x26 footprint centred in the box. Every value scales linearly with size/32.

    python src-tauri/icons/generate_icons.py

Deliberately flat: no gradient, bevel, inner highlight or drop shadow.
"""
from __future__ import annotations

import io
import struct

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

ACCENT = (66, 118, 87, 255)     # #427657 — tile fill
WHITE = (255, 255, 255, 255)
TRAY_GLYPH = (234, 237, 242, 255)  # #eaedf2 — monochrome tray on a dark shell

# Grid geometry, in 32-unit space.
BAR_W = 6
BAR_GAP = 5
BAR_R = 3
HEIGHTS = (16, 26, 16)
FOOTPRINT_W = BAR_W * 3 + BAR_GAP * 2  # 28


def _rounded_bar(draw: ImageDraw.ImageDraw, x, y, w, h, r, colour) -> None:
    # Radius can never exceed half the shorter side, or Pillow raises.
    draw.rounded_rectangle([x, y, x + w, y + h], radius=min(r, w / 2, h / 2), fill=colour)


def draw_mark(img: Image.Image, size: float, colour, offset=(0.0, 0.0)) -> None:
    """Draws the mark centred in a `size`-wide box at `offset`, supersampled."""
    draw = ImageDraw.Draw(img)
    k = size / 32.0
    ox, oy = offset
    x = ox + (size - FOOTPRINT_W * k) / 2
    for i, h32 in enumerate(HEIGHTS):
        h = h32 * k
        y = oy + (size - h) / 2
        _rounded_bar(draw, x, y, BAR_W * k, h, BAR_R * k, colour)
        x += (BAR_W + BAR_GAP) * k


def app_icon(px: int, supersample: int = 8) -> Image.Image:
    """Accent tile with the white mark at 62.5% of the tile."""
    s = px * supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Tile radius: 34@176, 13@64/52, 7@32 — ~19-22% of the edge.
    ratio = 0.193 if px >= 120 else 0.203 if px >= 44 else 0.219
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=ratio * s, fill=ACCENT)

    mark = s * 0.625
    draw_mark(img, mark, WHITE, offset=((s - mark) / 2, (s - mark) / 2))
    return img.resize((px, px), Image.LANCZOS)


def tray_icon(px: int, supersample: int = 8) -> Image.Image:
    """Bars only, no tile — the monochrome mark for the system tray."""
    s = px * supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw_mark(img, s, TRAY_GLYPH)
    return img.resize((px, px), Image.LANCZOS)


def write_ico(path: Path, render, sizes: list[int]) -> None:
    """
    Writes a Windows .ico by hand.

    Pillow's ICO writer PNG-compresses every entry. Windows only reads PNG
    entries reliably at 256x256 — at taskbar and desktop sizes it wants a BMP
    (DIB) with the AND mask, and quietly falls back to a stale or generic icon
    when it does not get one. So: BMP below 256, PNG at 256.
    """
    entries: list[tuple[int, bytes]] = []
    for size in sorted(sizes):
        img = render(size).convert("RGBA")
        if size >= 256:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            entries.append((size, buf.getvalue()))
            continue

        # BITMAPINFOHEADER: height is doubled to cover the (empty) AND mask.
        header = struct.pack(
            "<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0
        )
        pixels = bytearray()
        for y in range(size - 1, -1, -1):          # bottom-up rows
            for x in range(size):
                r, g, b, a = img.getpixel((x, y))
                pixels += bytes((b, g, r, a))      # BGRA
        # 32-bit icons still carry an AND mask; alpha does the real work.
        mask_row = ((size + 31) // 32) * 4
        entries.append((size, header + bytes(pixels) + bytes(mask_row * size)))

    out = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for size, blob in entries:
        out += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0, 0, 1, 32, len(blob), offset,
        )
        offset += len(blob)
    for _, blob in entries:
        out += blob
    path.write_bytes(bytes(out))


def main() -> None:
    outputs = {
        "32x32.png": app_icon(32),
        "128x128.png": app_icon(128),
        "128x128@2x.png": app_icon(256),
        "icon.png": app_icon(512),
    }
    for name, img in outputs.items():
        img.save(HERE / name)
        print(f"wrote {name} ({img.width}x{img.height})")

    # .ico carries every size Windows asks for, from the taskbar to Explorer.
    write_ico(HERE / "icon.ico", app_icon, [16, 24, 32, 48, 64, 128, 256])
    print("wrote icon.ico (16, 24, 32, 48, 64, 128, 256)")

    # The tray gets its own asset rather than reusing the coloured app tile.
    tray_icon(32).save(HERE / "tray.png")
    write_ico(HERE / "tray.ico", tray_icon, [16, 20, 24, 32])
    print("wrote tray.png, tray.ico")


if __name__ == "__main__":
    main()
