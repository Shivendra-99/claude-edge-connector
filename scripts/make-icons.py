"""Draw the Claude Connector icon (a browser tab with a pointer) at every size the
extension and the Edge Add-ons listing need."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024  # draw large, then downsample


def draw(size: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Background: rounded square with a vertical teal gradient.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = (20, 184, 166), (15, 98, 110)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    img.paste(grad, (0, 0), mask)

    white = (255, 255, 255, 255)
    small = size <= 32
    stroke = 70 if small else 52
    # Browser window: outline, a header strip and two window-control dots.
    d.rounded_rectangle([190, 240, 834, 770], radius=70, outline=white, width=stroke)
    d.rounded_rectangle([190, 240, 834, 400], radius=70, fill=white)
    d.rectangle([190, 330, 834, 400], fill=white)
    dot = 34 if not small else 0
    if dot:
        for cx in (290, 390):
            d.ellipse([cx - dot, 320 - dot, cx + dot, 320 + dot], fill=(15, 110, 115, 255))
    # Pointer arrow, outlined in teal so it reads over the window edge.
    arrow = [(560, 470), (560, 880), (655, 790), (725, 930), (800, 895), (730, 755), (860, 745)]
    d.polygon(arrow, fill=(15, 98, 110, 255))
    inset = [(590, 535), (590, 810), (662, 742), (735, 885), (765, 871), (692, 727), (790, 720)]
    d.polygon(inset, fill=white)
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(ROOT / "extension" / "icons" / f"icon-{size}.png")
draw(300).save(ROOT / "store" / "logo-300.png")
print("icons written")
