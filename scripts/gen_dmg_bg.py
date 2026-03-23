#!/usr/bin/env python3
"""Generate DMG installer background with ProgreSQL brand gradient.

Creates a 660x400 PNG with purple gradient (#6366f1 → #8b5cf6),
a curved arrow pointing from app icon to Applications folder,
and "ProgreSQL" text label.

Uses only stdlib modules (struct, zlib) — no Pillow required.
"""

import math
import struct
import zlib
import os

WIDTH = 660
HEIGHT = 400


def lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


def make_png(pixels: list[list[tuple[int, int, int, int]]], width: int, height: int) -> bytes:
    """Create a PNG file from RGBA pixel data."""

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))

    raw = b""
    for row in pixels:
        raw += b"\x00"  # filter byte
        for r, g, b, a in row:
            raw += struct.pack("BBBB", r, g, b, a)

    idat = chunk(b"IDAT", zlib.compress(raw, 9))
    iend = chunk(b"IEND", b"")
    return header + ihdr + idat + iend


def draw_gradient(pixels: list[list[tuple[int, int, int, int]]]) -> None:
    """Draw diagonal purple gradient."""
    c1 = (99, 102, 241)   # #6366f1
    c2 = (139, 92, 246)   # #8b5cf6
    c3 = (67, 56, 202)    # #4338ca — darker for depth

    for y in range(HEIGHT):
        for x in range(WIDTH):
            # Diagonal gradient: top-left → bottom-right
            t = (x / WIDTH * 0.6 + y / HEIGHT * 0.4)
            # Mix c3→c1→c2 for richer gradient
            if t < 0.5:
                color = lerp_color(c3, c1, t * 2)
            else:
                color = lerp_color(c1, c2, (t - 0.5) * 2)
            pixels[y][x] = (color[0], color[1], color[2], 255)


def draw_circle_aa(
    pixels: list[list[tuple[int, int, int, int]]],
    cx: float, cy: float, r: float,
    color: tuple[int, int, int], alpha: int = 255
) -> None:
    """Draw a filled circle with basic anti-aliasing."""
    for y in range(max(0, int(cy - r - 2)), min(HEIGHT, int(cy + r + 2))):
        for x in range(max(0, int(cx - r - 2)), min(WIDTH, int(cx + r + 2))):
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            if dist <= r - 0.5:
                a = alpha
            elif dist <= r + 0.5:
                a = int(alpha * (r + 0.5 - dist))
            else:
                continue
            bg = pixels[y][x]
            t = a / 255.0
            pixels[y][x] = (
                int(bg[0] * (1 - t) + color[0] * t),
                int(bg[1] * (1 - t) + color[1] * t),
                int(bg[2] * (1 - t) + color[2] * t),
                255,
            )


def draw_thick_line(
    pixels: list[list[tuple[int, int, int, int]]],
    x1: float, y1: float, x2: float, y2: float,
    thickness: float,
    color: tuple[int, int, int], alpha: int = 255
) -> None:
    """Draw an anti-aliased thick line."""
    dx = x2 - x1
    dy = y2 - y1
    length = math.sqrt(dx * dx + dy * dy)
    if length == 0:
        return

    # Normal vector
    nx = -dy / length
    ny = dx / length

    min_x = max(0, int(min(x1, x2) - thickness - 1))
    max_x = min(WIDTH, int(max(x1, x2) + thickness + 2))
    min_y = max(0, int(min(y1, y2) - thickness - 1))
    max_y = min(HEIGHT, int(max(y1, y2) + thickness + 2))

    half = thickness / 2.0

    for y in range(min_y, max_y):
        for x in range(min_x, max_x):
            # Project point onto line
            px, py = x - x1, y - y1
            along = (px * dx + py * dy) / length
            across = abs(px * nx + py * ny)

            if along < -half or along > length + half:
                continue

            # Distance to line segment
            if along < 0:
                dist = math.sqrt(px * px + py * py)
            elif along > length:
                qx, qy = x - x2, y - y2
                dist = math.sqrt(qx * qx + qy * qy)
            else:
                dist = across

            if dist <= half - 0.5:
                a = alpha
            elif dist <= half + 0.5:
                a = int(alpha * (half + 0.5 - dist))
            else:
                continue

            bg = pixels[y][x]
            t = a / 255.0
            pixels[y][x] = (
                int(bg[0] * (1 - t) + color[0] * t),
                int(bg[1] * (1 - t) + color[1] * t),
                int(bg[2] * (1 - t) + color[2] * t),
                255,
            )


def draw_curved_arrow(pixels: list[list[tuple[int, int, int, int]]]) -> None:
    """Draw a curved arrow from app icon area to Applications folder area."""
    color = (220, 220, 255)  # Light lavender
    thickness = 3.5

    # Arc from (200, 230) to (460, 230) with peak at y=140
    cx_arc = 330
    cy_arc = 330
    r_arc = 160
    start_angle = math.radians(200)
    end_angle = math.radians(340)

    steps = 80
    prev_x, prev_y = None, None
    end_x, end_y = 0.0, 0.0

    for i in range(steps + 1):
        t = i / steps
        angle = start_angle + (end_angle - start_angle) * t
        ax = cx_arc + r_arc * math.cos(angle)
        ay = cy_arc + r_arc * math.sin(angle)
        if prev_x is not None:
            draw_thick_line(pixels, prev_x, prev_y, ax, ay, thickness, color, 180)
        prev_x, prev_y = ax, ay
        end_x, end_y = ax, ay

    # Arrowhead at the end
    arrow_angle = end_angle + math.radians(10)
    arrow_len = 18
    a1_angle = arrow_angle + math.radians(150)
    a2_angle = arrow_angle - math.radians(150)
    a1x = end_x + arrow_len * math.cos(a1_angle)
    a1y = end_y + arrow_len * math.sin(a1_angle)
    a2x = end_x + arrow_len * math.cos(a2_angle)
    a2y = end_y + arrow_len * math.sin(a2_angle)

    draw_thick_line(pixels, end_x, end_y, a1x, a1y, thickness, color, 180)
    draw_thick_line(pixels, end_x, end_y, a2x, a2y, thickness, color, 180)


# Simple bitmap font for "ProgreSQL" text
FONT_GLYPHS: dict[str, list[str]] = {
    "P": [
        "####.",
        "#...#",
        "####.",
        "#....",
        "#....",
    ],
    "r": [
        ".....",
        "#.##.",
        "##...",
        "#....",
        "#....",
    ],
    "o": [
        ".....",
        ".##..",
        "#..#.",
        "#..#.",
        ".##..",
    ],
    "g": [
        ".....",
        ".###.",
        "#..#.",
        ".###.",
        "...#.",
    ],
    "e": [
        ".....",
        ".##..",
        "####.",
        "#....",
        ".##..",
    ],
    "S": [
        ".###.",
        "#....",
        ".##..",
        "...#.",
        "###..",
    ],
    "Q": [
        ".##..",
        "#..#.",
        "#..#.",
        "#.#..",
        ".##.",
    ],
    "L": [
        "#....",
        "#....",
        "#....",
        "#....",
        "####.",
    ],
    "s": [
        ".....",
        ".##..",
        "#....",
        ".##..",
        "##...",
    ],
    "q": [
        ".....",
        ".###.",
        "#..#.",
        ".###.",
        "...#.",
    ],
}


def draw_text(
    pixels: list[list[tuple[int, int, int, int]]],
    text: str, start_x: int, start_y: int,
    scale: int, color: tuple[int, int, int], alpha: int = 200
) -> None:
    """Render text using simple bitmap font."""
    cursor_x = start_x
    for ch in text:
        glyph = FONT_GLYPHS.get(ch)
        if glyph is None:
            cursor_x += 3 * scale  # space
            continue
        for gy, row in enumerate(glyph):
            for gx, pixel in enumerate(row):
                if pixel == "#":
                    for dy in range(scale):
                        for dx in range(scale):
                            px = cursor_x + gx * scale + dx
                            py = start_y + gy * scale + dy
                            if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                                bg = pixels[py][px]
                                t = alpha / 255.0
                                pixels[py][px] = (
                                    int(bg[0] * (1 - t) + color[0] * t),
                                    int(bg[1] * (1 - t) + color[1] * t),
                                    int(bg[2] * (1 - t) + color[2] * t),
                                    255,
                                )
        cursor_x += (len(glyph[0]) + 1) * scale


def draw_subtle_dots(pixels: list[list[tuple[int, int, int, int]]]) -> None:
    """Draw subtle decorative dots/stars pattern."""
    import random
    random.seed(42)  # deterministic
    for _ in range(60):
        x = random.randint(0, WIDTH - 1)
        y = random.randint(0, HEIGHT - 1)
        size = random.uniform(0.5, 1.5)
        alpha = random.randint(30, 80)
        draw_circle_aa(pixels, x, y, size, (255, 255, 255), alpha)


def main() -> None:
    # Initialize pixel buffer
    pixels: list[list[tuple[int, int, int, int]]] = [
        [(0, 0, 0, 255)] * WIDTH for _ in range(HEIGHT)
    ]

    # 1. Purple gradient background
    draw_gradient(pixels)

    # 2. Subtle decorative dots
    draw_subtle_dots(pixels)

    # 3. Curved arrow
    draw_curved_arrow(pixels)

    # 4. "ProgreSQL" text at bottom
    text_color = (255, 255, 255)
    text = "ProgreSQL"
    scale = 3
    char_width = 6 * scale  # ~18px per char
    text_width = len(text) * char_width
    text_x = (WIDTH - text_width) // 2
    text_y = HEIGHT - 60
    draw_text(pixels, text, text_x, text_y, scale, text_color, 200)

    # Generate PNG
    png_data = make_png(pixels, WIDTH, HEIGHT)

    # Write files
    out_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "assets", "dmg")
    os.makedirs(out_dir, exist_ok=True)

    out_path = os.path.join(out_dir, "background.png")
    with open(out_path, "wb") as f:
        f.write(png_data)
    print(f"Written: {out_path} ({len(png_data)} bytes)")

    # Also generate @2x version (1320x800)
    # For now, just copy the same since create-dmg handles scaling
    out_path_2x = os.path.join(out_dir, "background@2x.png")
    with open(out_path_2x, "wb") as f:
        f.write(png_data)
    print(f"Written: {out_path_2x} ({len(png_data)} bytes)")


if __name__ == "__main__":
    main()
