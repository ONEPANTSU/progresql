"""
DMG background image generator for ProgreSQL.

Generates both 1x (660x400) and 2x (1320x800) versions with:
- Dark navy/space background with star particles
- ProgreSQL title and subtitle in 8-bit pixel font style
- Two square boxes for app icon and Applications folder
- Arrow with "Drag and Drop" label in pixel font
- No labels below boxes (macOS adds its own)

Pixel font technique:
    Text is rendered at a tiny size then upscaled with NEAREST-neighbour
    resampling, which produces the hard-edged retro/8-bit look.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
# Colour palette
# ---------------------------------------------------------------------------
BG_TOP = (10, 10, 38)         # deep navy
BG_BOTTOM = (6, 6, 22)        # near-black
STAR_COLOR = (255, 255, 255)

TITLE_COLOR = (255, 255, 255)          # white
SUBTITLE_COLOR = (160, 130, 200)       # muted purple

BOX_BORDER = (100, 80, 180, 180)       # semi-transparent purple border (RGBA)
BOX_FILL = (20, 20, 60, 60)            # very dark navy, low alpha

ARROW_COLOR = (120, 100, 200, 200)     # muted purple arrow
DRAG_TEXT_COLOR = (140, 120, 190)      # same family, slightly lighter


# ---------------------------------------------------------------------------
# Pixel-art text rendering
# ---------------------------------------------------------------------------

# Each character is encoded as a list of rows, each row a string of '0'/'1'.
# Grid size: 5 wide x 7 tall (classic 5x7 bitmap font subset).

_PIXEL_FONT: dict[str, list[str]] = {
    "A": [
        " XXX ",
        "X   X",
        "X   X",
        "XXXXX",
        "X   X",
        "X   X",
        "X   X",
    ],
    "B": [
        "XXXX ",
        "X   X",
        "X   X",
        "XXXX ",
        "X   X",
        "X   X",
        "XXXX ",
    ],
    "C": [
        " XXXX",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        " XXXX",
    ],
    "D": [
        "XXXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "XXXX ",
    ],
    "E": [
        "XXXXX",
        "X    ",
        "X    ",
        "XXXX ",
        "X    ",
        "X    ",
        "XXXXX",
    ],
    "F": [
        "XXXXX",
        "X    ",
        "X    ",
        "XXXX ",
        "X    ",
        "X    ",
        "X    ",
    ],
    "G": [
        " XXXX",
        "X    ",
        "X    ",
        "X  XX",
        "X   X",
        "X   X",
        " XXXX",
    ],
    "H": [
        "X   X",
        "X   X",
        "X   X",
        "XXXXX",
        "X   X",
        "X   X",
        "X   X",
    ],
    "I": [
        "XXXXX",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "XXXXX",
    ],
    "J": [
        "XXXXX",
        "    X",
        "    X",
        "    X",
        "X   X",
        "X   X",
        " XXX ",
    ],
    "K": [
        "X   X",
        "X  X ",
        "X X  ",
        "XX   ",
        "X X  ",
        "X  X ",
        "X   X",
    ],
    "L": [
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "X    ",
        "XXXXX",
    ],
    "M": [
        "X   X",
        "XX XX",
        "X X X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
    ],
    "N": [
        "X   X",
        "XX  X",
        "X X X",
        "X  XX",
        "X   X",
        "X   X",
        "X   X",
    ],
    "O": [
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX ",
    ],
    "P": [
        "XXXX ",
        "X   X",
        "X   X",
        "XXXX ",
        "X    ",
        "X    ",
        "X    ",
    ],
    "Q": [
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        "X X X",
        "X  XX",
        " XXXX",
    ],
    "R": [
        "XXXX ",
        "X   X",
        "X   X",
        "XXXX ",
        "X X  ",
        "X  X ",
        "X   X",
    ],
    "S": [
        " XXXX",
        "X    ",
        "X    ",
        " XXX ",
        "    X",
        "    X",
        "XXXX ",
    ],
    "T": [
        "XXXXX",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
    ],
    "U": [
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXX ",
    ],
    "V": [
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " X X ",
        "  X  ",
    ],
    "W": [
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        "X X X",
        "XX XX",
        "X   X",
    ],
    "X": [
        "X   X",
        "X   X",
        " X X ",
        "  X  ",
        " X X ",
        "X   X",
        "X   X",
    ],
    "Y": [
        "X   X",
        "X   X",
        " X X ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
    ],
    "Z": [
        "XXXXX",
        "    X",
        "   X ",
        "  X  ",
        " X   ",
        "X    ",
        "XXXXX",
    ],
    "a": [
        "     ",
        "     ",
        " XXX ",
        "    X",
        " XXXX",
        "X   X",
        " XXXX",
    ],
    "b": [
        "X    ",
        "X    ",
        "X XX ",
        "XX  X",
        "X   X",
        "X   X",
        "XXXX ",
    ],
    "c": [
        "     ",
        "     ",
        " XXX ",
        "X    ",
        "X    ",
        "X   X",
        " XXX ",
    ],
    "d": [
        "    X",
        "    X",
        " XX X",
        "X   X",
        "X   X",
        "X   X",
        " XXXX",
    ],
    "e": [
        "     ",
        "     ",
        " XXX ",
        "X   X",
        "XXXXX",
        "X    ",
        " XXX ",
    ],
    "f": [
        "  XX ",
        " X  X",
        " X   ",
        "XXXX ",
        " X   ",
        " X   ",
        " X   ",
    ],
    "g": [
        "     ",
        "     ",
        " XXXX",
        "X   X",
        " XXXX",
        "    X",
        " XXX ",
    ],
    "h": [
        "X    ",
        "X    ",
        "X XX ",
        "XX  X",
        "X   X",
        "X   X",
        "X   X",
    ],
    "i": [
        "  X  ",
        "     ",
        " XX  ",
        "  X  ",
        "  X  ",
        "  X  ",
        " XXX ",
    ],
    "j": [
        "   X ",
        "     ",
        "   X ",
        "   X ",
        "   X ",
        "X  X ",
        " XX  ",
    ],
    "k": [
        "X    ",
        "X    ",
        "X  X ",
        "X X  ",
        "XX   ",
        "X X  ",
        "X  X ",
    ],
    "l": [
        " XX  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        "  X  ",
        " XXX ",
    ],
    "m": [
        "     ",
        "     ",
        "XX X ",
        "X X X",
        "X X X",
        "X   X",
        "X   X",
    ],
    "n": [
        "     ",
        "     ",
        "X XX ",
        "XX  X",
        "X   X",
        "X   X",
        "X   X",
    ],
    "o": [
        "     ",
        "     ",
        " XXX ",
        "X   X",
        "X   X",
        "X   X",
        " XXX ",
    ],
    "p": [
        "     ",
        "     ",
        "XXXX ",
        "X   X",
        "XXXX ",
        "X    ",
        "X    ",
    ],
    "q": [
        "     ",
        "     ",
        " XXXX",
        "X   X",
        " XXXX",
        "    X",
        "    X",
    ],
    "r": [
        "     ",
        "     ",
        "X XX ",
        "XX  X",
        "X    ",
        "X    ",
        "X    ",
    ],
    "s": [
        "     ",
        "     ",
        " XXX ",
        "X    ",
        " XXX ",
        "    X",
        "XXXX ",
    ],
    "t": [
        " X   ",
        " X   ",
        "XXXX ",
        " X   ",
        " X   ",
        " X  X",
        "  XX ",
    ],
    "u": [
        "     ",
        "     ",
        "X   X",
        "X   X",
        "X   X",
        "X   X",
        " XXXX",
    ],
    "v": [
        "     ",
        "     ",
        "X   X",
        "X   X",
        "X   X",
        " X X ",
        "  X  ",
    ],
    "w": [
        "     ",
        "     ",
        "X   X",
        "X   X",
        "X X X",
        "X X X",
        " X X ",
    ],
    "x": [
        "     ",
        "     ",
        "X   X",
        " X X ",
        "  X  ",
        " X X ",
        "X   X",
    ],
    "y": [
        "     ",
        "     ",
        "X   X",
        "X   X",
        " XXXX",
        "    X",
        " XXX ",
    ],
    "z": [
        "     ",
        "     ",
        "XXXXX",
        "   X ",
        "  X  ",
        " X   ",
        "XXXXX",
    ],
    "-": [
        "     ",
        "     ",
        "     ",
        "XXXXX",
        "     ",
        "     ",
        "     ",
    ],
    " ": [
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
    ],
    ".": [
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
        " XX  ",
        " XX  ",
    ],
    "'": [
        "  X  ",
        "  X  ",
        "     ",
        "     ",
        "     ",
        "     ",
        "     ",
    ],
}

# Character cell dimensions (pixels in the tiny bitmap)
_CHAR_W = 5
_CHAR_H = 7
_CHAR_GAP = 1   # gap between characters in the tiny bitmap


def _render_pixel_text(
    text: str,
    pixel_size: int,
    color: tuple,
) -> Image.Image:
    """
    Render *text* using the hand-drawn 5x7 bitmap font, then scale it up
    with NEAREST-neighbour resampling to produce the retro 8-bit look.

    Parameters
    ----------
    text:
        The string to render. Unknown characters are treated as spaces.
    pixel_size:
        How many display pixels each bitmap pixel should occupy.
        pixel_size=4 on a 1x canvas gives a reasonably chunky retro style.
    color:
        RGB tuple for the text colour.

    Returns
    -------
    RGBA Image containing the rendered text (transparent background).
    """
    chars = [_PIXEL_FONT.get(ch, _PIXEL_FONT[" "]) for ch in text]
    n = len(chars)

    # Dimensions of the tiny off-screen bitmap
    tiny_w = n * (_CHAR_W + _CHAR_GAP) - _CHAR_GAP
    tiny_h = _CHAR_H

    tiny = Image.new("RGBA", (tiny_w, tiny_h), (0, 0, 0, 0))
    pixels = tiny.load()

    for ci, glyph in enumerate(chars):
        x_off = ci * (_CHAR_W + _CHAR_GAP)
        for row_idx, row in enumerate(glyph):
            for col_idx, bit in enumerate(row):
                if bit == "X":
                    px = x_off + col_idx
                    py = row_idx
                    if 0 <= px < tiny_w and 0 <= py < tiny_h:
                        pixels[px, py] = (*color, 255)

    # Scale up with NEAREST to keep crisp pixel edges
    scaled_w = tiny_w * pixel_size
    scaled_h = tiny_h * pixel_size
    scaled = tiny.resize((scaled_w, scaled_h), Image.NEAREST)
    return scaled


def _draw_pixel_text_centered(
    canvas: Image.Image,
    text: str,
    cx: int,
    y: int,
    pixel_size: int,
    color: tuple,
) -> None:
    """Render pixel text and composite it centred at *cx*, top at *y*."""
    img = _render_pixel_text(text, pixel_size, color)
    x = cx - img.width // 2
    canvas.alpha_composite(img, dest=(x, y))


def _draw_pixel_text_at(
    canvas: Image.Image,
    text: str,
    x: int,
    y: int,
    pixel_size: int,
    color: tuple,
) -> None:
    """Render pixel text and composite it with top-left at (*x*, *y*)."""
    img = _render_pixel_text(text, pixel_size, color)
    canvas.alpha_composite(img, dest=(x, y))


def _pixel_text_size(text: str, pixel_size: int) -> tuple[int, int]:
    """Return (width, height) of rendered pixel text without drawing it."""
    n = len(text)
    tiny_w = n * (_CHAR_W + _CHAR_GAP) - _CHAR_GAP
    return tiny_w * pixel_size, _CHAR_H * pixel_size


# ---------------------------------------------------------------------------
# Background helpers
# ---------------------------------------------------------------------------

def _vertical_gradient(draw: ImageDraw.ImageDraw, width: int, height: int) -> None:
    """Fill the canvas with a top-to-bottom gradient."""
    for y in range(height):
        t = y / height
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        draw.line([(0, y), (width, y)], fill=(r, g, b))


def _scatter_stars(
    draw: ImageDraw.ImageDraw,
    width: int,
    height: int,
    count: int,
    rng: random.Random,
) -> None:
    """Draw randomised star particles of varying brightness and size."""
    for _ in range(count):
        x = rng.randint(0, width - 1)
        y = rng.randint(0, height - 1)
        brightness = rng.randint(80, 220)
        size = rng.choices([0, 1, 2], weights=[60, 30, 10])[0]
        color = (brightness, brightness, brightness)
        if size == 0:
            draw.point((x, y), fill=color)
        elif size == 1:
            draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=color)
        else:
            alpha = rng.randint(40, 120)
            draw.ellipse(
                [x - 2, y - 2, x + 2, y + 2],
                fill=(brightness, brightness, brightness, alpha),
            )


def _draw_square_box(
    canvas: Image.Image,
    cx: int,
    cy: int,
    box_size: int,
    radius: int,
    border_width: int,
) -> None:
    """
    Draw a semi-transparent square box with rounded corners onto *canvas* (RGBA).
    """
    half = box_size // 2
    x0, y0 = cx - half, cy - half
    x1, y1 = cx + half, cy + half

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=BOX_FILL)
    for offset in range(border_width):
        alpha = int(BOX_BORDER[3] * (1.0 - offset / border_width * 0.6))
        d.rounded_rectangle(
            [x0 + offset, y0 + offset, x1 - offset, y1 - offset],
            radius=max(1, radius - offset),
            outline=(*BOX_BORDER[:3], alpha),
            width=1,
        )

    canvas.alpha_composite(overlay)


def _draw_arrow(
    canvas: Image.Image,
    x_start: int,
    x_end: int,
    y: int,
    scale: int,
) -> None:
    """Draw a horizontal arrow from x_start to x_end at height y."""
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    shaft_w = max(2, 2 * scale)
    head_size = max(8, 8 * scale)

    d.line(
        [(x_start, y), (x_end - head_size, y)],
        fill=ARROW_COLOR,
        width=shaft_w,
    )
    head_pts = [
        (x_end, y),
        (x_end - head_size, y - head_size // 2),
        (x_end - head_size, y + head_size // 2),
    ]
    d.polygon(head_pts, fill=ARROW_COLOR)

    canvas.alpha_composite(overlay)


# ---------------------------------------------------------------------------
# Core generator
# ---------------------------------------------------------------------------

def generate_background(
    width: int,
    height: int,
    output_path: Path,
    scale: int = 1,
    seed: int = 42,
) -> None:
    """
    Generate the DMG background image.

    Parameters
    ----------
    width, height:
        Canvas dimensions in pixels.
    output_path:
        Destination file path.
    scale:
        1 for 1x, 2 for 2x (scales pixel sizes and stroke widths).
    seed:
        Random seed for reproducible star placement.
    """
    rng = random.Random(seed)

    # ------------------------------------------------------------------
    # 1. Base canvas (RGBA so we can composite transparent overlays)
    # ------------------------------------------------------------------
    canvas = Image.new("RGBA", (width, height), BG_TOP)
    base_draw = ImageDraw.Draw(canvas)
    _vertical_gradient(base_draw, width, height)

    # ------------------------------------------------------------------
    # 2. Star field
    # ------------------------------------------------------------------
    star_count = int(200 * (width * height) / (660 * 400))
    _scatter_stars(base_draw, width, height, star_count, rng)

    # ------------------------------------------------------------------
    # 3. Subtle radial glow in the centre
    # ------------------------------------------------------------------
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx_glow, cy_glow = width // 2, height // 2
    for r in range(min(width, height) // 2, 0, -1):
        alpha = int(18 * (1 - r / (min(width, height) / 2)))
        gd.ellipse(
            [cx_glow - r, cy_glow - r, cx_glow + r, cy_glow + r],
            fill=(40, 30, 90, alpha),
        )
    canvas.alpha_composite(glow)

    # ------------------------------------------------------------------
    # 4. Pixel-art typography
    # ------------------------------------------------------------------
    # Title "ProgreSQL" – large pixel font
    # pixel_size controls how many canvas-pixels each bitmap-pixel occupies.
    # At scale=1: pixel_size=4 → each glyph cell is 20px wide, 28px tall.
    # At scale=2: pixel_size=8 → same logical size, doubled.
    title_pixel_size = 4 * scale
    subtitle_pixel_size = 2 * scale
    drag_pixel_size = 2 * scale

    title_h = _CHAR_H * title_pixel_size
    subtitle_h = _CHAR_H * subtitle_pixel_size

    title_y = int(30 * scale)
    subtitle_y = title_y + title_h + int(8 * scale)

    _draw_pixel_text_centered(
        canvas, "ProgreSQL",
        width // 2, title_y,
        title_pixel_size, TITLE_COLOR,
    )
    _draw_pixel_text_centered(
        canvas, "AI-powered PostgreSQL client",
        width // 2, subtitle_y,
        subtitle_pixel_size, SUBTITLE_COLOR,
    )

    # ------------------------------------------------------------------
    # 5. Square boxes
    # ------------------------------------------------------------------
    icon_cx_left = int(170 * scale)
    icon_cx_right = int(490 * scale)
    icon_cy = int(190 * scale)

    box_size = int(140 * scale)
    box_radius = int(16 * scale)
    box_border_w = max(2, 3 * scale)

    _draw_square_box(canvas, icon_cx_left, icon_cy, box_size, box_radius, box_border_w)
    _draw_square_box(canvas, icon_cx_right, icon_cy, box_size, box_radius, box_border_w)

    # ------------------------------------------------------------------
    # 6. Arrow between boxes
    # ------------------------------------------------------------------
    arrow_gap = int(10 * scale)
    arrow_x_start = icon_cx_left + box_size // 2 + arrow_gap
    arrow_x_end = icon_cx_right - box_size // 2 - arrow_gap
    _draw_arrow(canvas, arrow_x_start, arrow_x_end, icon_cy, scale)

    # "Drag and Drop" label above the arrow – pixel font
    drag_label_text = "Drag and Drop"
    drag_h = _CHAR_H * drag_pixel_size
    drag_label_y = icon_cy - drag_h - int(8 * scale)
    _draw_pixel_text_centered(
        canvas, drag_label_text,
        (arrow_x_start + arrow_x_end) // 2, drag_label_y,
        drag_pixel_size, DRAG_TEXT_COLOR,
    )

    # ------------------------------------------------------------------
    # 7. NO labels below boxes — macOS adds its own "ProgreSQL" /
    #    "Applications" labels automatically.
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # 8. Save as RGB PNG
    # ------------------------------------------------------------------
    final = canvas.convert("RGB")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    final.save(str(output_path), "PNG", optimize=True)
    print(f"Saved {output_path}  ({width}x{height})")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    assets_dir = Path("/Users/onepantsu/Desktop/progresql/frontend/public/assets/dmg")

    generate_background(
        width=660,
        height=400,
        output_path=assets_dir / "background.png",
        scale=1,
    )
    generate_background(
        width=1320,
        height=800,
        output_path=assets_dir / "background@2x.png",
        scale=2,
    )
    print("Done.")


if __name__ == "__main__":
    main()
