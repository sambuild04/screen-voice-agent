#!/usr/bin/env python3
"""
Generate macOS-style squircle app icons from the source icon.png.
Applies the standard macOS rounded-rectangle mask (~22.37% corner radius)
and regenerates all Tauri-required icon sizes + .icns via iconutil.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ICONS_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SOURCE = ICONS_DIR / "icon.png"

# macOS squircle corner radius as fraction of icon size (~22.37%)
CORNER_FRACTION = 0.2237

# Tauri icon sizes needed
TAURI_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
}

# Windows Store logo sizes
STORE_SIZES = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

# .icns sizes: name -> (pixel_size, scale_suffix)
ICNS_ENTRIES = [
    ("icon_16x16", 16),
    ("icon_16x16@2x", 32),
    ("icon_32x32", 32),
    ("icon_32x32@2x", 64),
    ("icon_128x128", 128),
    ("icon_128x128@2x", 256),
    ("icon_256x256", 256),
    ("icon_256x256@2x", 512),
    ("icon_512x512", 512),
    ("icon_512x512@2x", 1024),
]


def make_squircle_mask(size: int) -> Image.Image:
    """Create a smooth rounded-rectangle (squircle) alpha mask."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * CORNER_FRACTION)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def apply_mask(src: Image.Image, size: int) -> Image.Image:
    """Resize source to size and apply squircle mask."""
    img = src.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = make_squircle_mask(size)
    r, g, b, a = img.split()
    # Combine existing alpha with the squircle mask
    from PIL import ImageChops
    combined_alpha = ImageChops.multiply(a, mask)
    img.putalpha(combined_alpha)
    return img


def main():
    if not SOURCE.exists():
        print(f"Source icon not found: {SOURCE}", file=sys.stderr)
        sys.exit(1)

    src = Image.open(SOURCE).convert("RGBA")
    print(f"Source: {SOURCE} ({src.size[0]}x{src.size[1]})")

    # Generate Tauri PNGs
    for name, size in TAURI_SIZES.items():
        out = ICONS_DIR / name
        img = apply_mask(src, size)
        img.save(out, "PNG")
        print(f"  {name} ({size}x{size})")

    # Generate Windows Store PNGs
    for name, size in STORE_SIZES.items():
        out = ICONS_DIR / name
        img = apply_mask(src, size)
        img.save(out, "PNG")
        print(f"  {name} ({size}x{size})")

    # Generate .icns via iconutil
    with tempfile.TemporaryDirectory() as tmpdir:
        iconset = Path(tmpdir) / "icon.iconset"
        iconset.mkdir()
        for entry_name, px in ICNS_ENTRIES:
            img = apply_mask(src, px)
            img.save(iconset / f"{entry_name}.png", "PNG")
        icns_out = ICONS_DIR / "icon.icns"
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_out)],
            check=True,
        )
        print(f"  icon.icns (from iconset)")

    # Generate .ico (Windows) — 256, 48, 32, 16
    ico_sizes = [256, 48, 32, 16]
    ico_images = [apply_mask(src, s) for s in ico_sizes]
    ico_out = ICONS_DIR / "icon.ico"
    ico_images[0].save(
        ico_out, format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:],
    )
    print(f"  icon.ico ({', '.join(str(s) for s in ico_sizes)})")

    print("\nDone! All icons regenerated with macOS squircle mask.")


if __name__ == "__main__":
    main()
