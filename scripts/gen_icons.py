#!/usr/bin/env python3
"""Generate Zotero Copilot icons: sparkle star on gradient background."""

import math
from PIL import Image, ImageDraw, ImageFilter

# --- Color Palette ---
GRADIENT_TOP = (79, 70, 229)      # indigo-600 #4F46E5
GRADIENT_BOTTOM = (124, 58, 237)  # violet-600 #7C3AED
SPARKLE_COLOR = (255, 255, 255)   # white
SPARKLE_GLOW = (199, 210, 254)    # indigo-200 for subtle glow


def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def sparkle_points(cx, cy, outer_r, inner_r, num_points=4):
    """Generate vertices for an N-pointed star (sparkle)."""
    pts = []
    for i in range(num_points * 2):
        angle = math.pi * i / num_points - math.pi / 2
        r = outer_r if i % 2 == 0 else inner_r
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


def create_icon(size, corner_radius_frac=0.22):
    """Create a single icon at the given size."""
    # Work at 4x for antialiasing, then downscale
    ss = 4
    s = size * ss
    cr = int(s * corner_radius_frac)

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- Gradient rounded rectangle background ---
    # Draw gradient line-by-line, then mask with rounded rect
    gradient = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    for y in range(s):
        t = y / (s - 1)
        # Diagonal gradient: blend both x and y
        for x in range(s):
            tx = x / (s - 1)
            tt = t * 0.7 + tx * 0.3  # mostly vertical, slight diagonal
            c = lerp_color(GRADIENT_TOP, GRADIENT_BOTTOM, tt)
            gradient.putpixel((x, y), c + (255,))

    # Create rounded rect mask
    mask = Image.new("L", (s, s), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([(0, 0), (s - 1, s - 1)], radius=cr, fill=255)
    
    img.paste(gradient, (0, 0), mask)

    # --- Subtle inner shadow for depth ---
    shadow_mask = Image.new("L", (s, s), 0)
    shadow_draw = ImageDraw.Draw(shadow_mask)
    # Top highlight strip
    for y in range(int(s * 0.08)):
        alpha = int(30 * (1 - y / (s * 0.08)))
        shadow_draw.line([(cr, y), (s - cr, y)], fill=alpha)
    highlight = Image.new("RGBA", (s, s), (255, 255, 255, 0))
    highlight.putalpha(shadow_mask)
    img = Image.alpha_composite(img, highlight)

    draw = ImageDraw.Draw(img)

    # --- Sparkle star ---
    cx, cy = s / 2, s / 2
    outer_r = s * 0.36   # long arms
    inner_r = s * 0.09   # tight waist → sharp sparkle

    pts = sparkle_points(cx, cy, outer_r, inner_r, num_points=4)
    
    # Glow layer (slightly larger, blurred)
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_pts = sparkle_points(cx, cy, outer_r * 1.08, inner_r * 1.3, num_points=4)
    glow_draw.polygon(glow_pts, fill=SPARKLE_GLOW + (80,))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=s * 0.04))
    img = Image.alpha_composite(img, glow)

    # Main sparkle
    draw = ImageDraw.Draw(img)
    draw.polygon(pts, fill=SPARKLE_COLOR + (255,))

    # --- Small accent sparkle (top-right) ---
    accent_cx = cx + s * 0.22
    accent_cy = cy - s * 0.22
    accent_outer = s * 0.08
    accent_inner = s * 0.025
    accent_pts = sparkle_points(accent_cx, accent_cy, accent_outer, accent_inner, 4)
    draw.polygon(accent_pts, fill=SPARKLE_COLOR + (200,))

    # --- Downscale with high-quality resampling ---
    img = img.resize((size, size), Image.LANCZOS)
    return img


if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "..", "addon", "content", "icons")
    os.makedirs(out_dir, exist_ok=True)

    # Generate 96x96
    icon96 = create_icon(96)
    path96 = os.path.join(out_dir, "favicon.png")
    icon96.save(path96, "PNG")
    print(f"Saved {path96} ({icon96.size})")

    # Generate 48x48
    icon48 = create_icon(48)
    path48 = os.path.join(out_dir, "favicon@0.5x.png")
    icon48.save(path48, "PNG")
    print(f"Saved {path48} ({icon48.size})")

    print("Done!")
