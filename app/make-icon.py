# Renders app/zee-icon.png, the 1024x1024 source for Zee's app icons.
# Usage: uv run --no-project --with pillow==11.3.0 python app/make-icon.py
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# Body: a soft blob in teal.
d.ellipse((140, 200, 884, 900), fill=(46, 178, 150, 255))
d.ellipse((220, 150, 804, 700), fill=(46, 178, 150, 255))
# Belly highlight.
d.ellipse((330, 560, 694, 840), fill=(120, 214, 190, 255))
# Eyes.
for x in (380, 644):
    d.ellipse((x - 62, 380, x + 62, 504), fill=(255, 255, 255, 255))
    d.ellipse((x - 30, 414, x + 30, 474), fill=(30, 40, 48, 255))
# Smile.
d.arc((412, 470, 612, 620), start=20, end=160, fill=(30, 40, 48, 255), width=22)

out = Path(__file__).parent / "zee-icon.png"
img.save(out)
print(f"Wrote {out}")

# Menu bar icon: a black robot silhouette with transparent eyes. macOS treats it
# as a template image and recolors it for light and dark menu bars. 44 px = 22 pt @2x.
tray = Image.new("RGBA", (44, 44), (0, 0, 0, 0))
t = ImageDraw.Draw(tray)
t.line((22, 4, 22, 10), fill=(0, 0, 0, 255), width=3)
t.ellipse((18, 1, 26, 9), fill=(0, 0, 0, 255))
t.rounded_rectangle((6, 10, 38, 34), radius=8, fill=(0, 0, 0, 255))
for x in (15, 29):
    t.ellipse((x - 3, 18, x + 3, 24), fill=(0, 0, 0, 0))
t.rounded_rectangle((13, 35, 31, 42), radius=3, fill=(0, 0, 0, 255))
tray_out = Path(__file__).parent / "src-tauri" / "icons" / "tray.png"
tray.save(tray_out)
print(f"Wrote {tray_out}")
