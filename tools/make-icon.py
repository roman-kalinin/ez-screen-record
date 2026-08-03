"""
Generate the application icon.

The mark is a rounded display with a record dot in it — the two things the app
actually is. Drawn at 4x and downsampled so the curves stay clean at 16px,
where the icon spends most of its life in the taskbar and title bar.

Run:  python tools/make-icon.py
Outputs build/icon.png (512) and build/icon.ico (multi-size, for electron-builder).
"""

import io
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "build")
SS = 4  # supersample factor

# Brand blue, matching the accent used in the UI, over a dark rounded square.
BG_TOP = (37, 99, 235)
BG_BOTTOM = (14, 116, 214)
SCREEN = (255, 255, 255)
DOT = (235, 60, 74)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def render(size):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Vertical gradient background. Built row by row: cheap, and at 4x the
    # banding is gone by the time it is downsampled.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / max(S - 1, 1)
        c = tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        gd.line([(0, y), (S, y)], fill=c + (255,))

    # Squircle-ish corner radius, close to the Windows 11 app-icon convention.
    img.paste(grad, (0, 0), rounded_mask(S, int(S * 0.22)))

    d = ImageDraw.Draw(img)

    # The display: a rounded outline, inset so it reads as a screen and not a
    # border on the tile itself.
    pad = S * 0.22
    stroke = max(int(S * 0.055), 1)
    d.rounded_rectangle(
        [pad, pad * 1.12, S - pad, S - pad * 1.12],
        radius=int(S * 0.075),
        outline=SCREEN + (255,),
        width=stroke,
    )

    # The record dot, centred in the display.
    r = S * 0.115
    cx, cy = S / 2, S / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT + (255,))

    return img.resize((size, size), Image.LANCZOS)


def write_icns(path, master1024):
    """
    Write an .icns without depending on macOS's iconutil.

    Pillow's ICNS *saver* is unavailable on most builds, so the container is
    assembled by hand. The format is simple: an 8-byte 'icns' header followed by
    length-prefixed chunks, each a PNG under a size-specific OSType. 'ic07'
    upward accept PNG directly, which is every size that matters today.
    """
    import struct

    # (OSType, pixel size). Retina variants share pixels with their 2x base.
    entries = [
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ]

    chunks = []
    for ostype, size in entries:
        buf = io.BytesIO()
        master1024.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
        data = buf.getvalue()
        chunks.append(ostype + struct.pack(">I", len(data) + 8) + data)

    body = b"".join(chunks)
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def render_mac(size):
    """
    macOS variant.

    Apple's grid leaves the icon inset within its canvas rather than filling it
    edge to edge, and uses a much softer corner radius than Windows. Rendering
    the Windows tile at full bleed on macOS makes it look oversized next to
    every other icon in the Dock.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # ~82% of the canvas, which is close to Apple's own proportion.
    inner = int(size * 0.82)
    tile = render(inner)
    off = (size - inner) // 2
    canvas.paste(tile, (off, off), tile)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)

    master = render(512)
    master.save(os.path.join(OUT, "icon.png"))

    # macOS: inset on a transparent canvas, written as a multi-size .icns.
    mac_master = render_mac(1024)
    write_icns(os.path.join(OUT, "icon.icns"), mac_master)

    # Each ICO frame is rendered at its own size rather than scaled from the
    # 512 — the stroke width is proportional, so a downscaled 16px frame would
    # come out as grey mush instead of a legible outline.
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(s) for s in sizes]
    frames[-1].save(
        os.path.join(OUT, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )
    print("wrote build/icon.png and build/icon.ico", sizes)


if __name__ == "__main__":
    main()
