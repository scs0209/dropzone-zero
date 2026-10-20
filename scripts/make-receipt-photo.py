# Renders scripts/assets/receipt-photo.jpg: a fictional shop receipt, slightly
# rotated on a table, like a phone photo. The seed copies it in as IMG_2041.jpg,
# so only the model's vision (not the file name) can tell it is a receipt.
# Usage: uv run --with pillow==11.3.0 python scripts/make-receipt-photo.py
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LINES = [
    ("JUNIPER MARKET", 44),
    ("12 Orchard Lane", 26),
    ("", 20),
    ("2026-10-11  17:42", 28),
    ("Receipt 0417-22", 28),
    ("", 20),
    ("Sourdough loaf      5.20", 28),
    ("Oat milk 1L         2.90", 28),
    ("Apples 1kg          3.75", 28),
    ("Coffee beans       11.50", 28),
    ("", 20),
    ("TOTAL USD          23.35", 34),
    ("CARD ****0000", 26),
    ("", 20),
    ("Thank you!", 28),
]

paper = Image.new("RGB", (520, 820), (248, 246, 240))
draw = ImageDraw.Draw(paper)
y = 40
for text, size in LINES:
    font = ImageFont.load_default(size=size)
    width = draw.textlength(text, font=font)
    draw.text(((520 - width) / 2, y), text, fill=(40, 40, 40), font=font)
    y += size + 14

table = Image.new("RGB", (900, 1100), (122, 98, 76))
rotated = paper.rotate(4, expand=True, resample=Image.BICUBIC, fillcolor=(122, 98, 76))
table.paste(rotated, ((900 - rotated.width) // 2, (1100 - rotated.height) // 2))
photo = table.filter(ImageFilter.GaussianBlur(0.6))

out = Path(__file__).parent / "assets" / "receipt-photo.jpg"
photo.save(out, quality=80)
print(f"Wrote {out} ({out.stat().st_size} bytes)")
