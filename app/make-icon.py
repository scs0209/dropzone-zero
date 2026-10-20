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
