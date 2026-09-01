from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CHARACTER_ICON_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PNG_DIR = CHARACTER_ICON_ROOT / "source"
QA_DIR = CHARACTER_ICON_ROOT / "qa" / "reports"


def load_font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def build(size: int) -> None:
    names = sorted(path.stem for path in PNG_DIR.glob("*.png"))
    output_dir = (
        REPOSITORY_ROOT / "ui" / "assets" / "character-icons" / "64"
        if size == 64
        else CHARACTER_ICON_ROOT / "qa" / "thumbnails" / str(size)
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    thumbs = {}
    for name in names:
        with Image.open(PNG_DIR / f"{name}.png") as source:
            icon = source.convert("RGBA")
            icon.thumbnail((size, size), Image.Resampling.LANCZOS)
        thumb = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        thumb.alpha_composite(icon, ((size - icon.width) // 2, (size - icon.height) // 2))
        thumb.save(output_dir / f"{name}.png")
        thumbs[name] = thumb

    columns, cell_width, cell_height = 8, 128, 96
    rows = (len(names) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), (38, 42, 52))
    draw = ImageDraw.Draw(sheet)
    label_font = load_font(13)
    image_y, label_y = ((4, 72) if size == 64 else (20, 58))
    for index, name in enumerate(names):
        col, row = index % columns, index // columns
        x0, y0 = col * cell_width, row * cell_height
        sheet.paste(thumbs[name], (x0 + (cell_width - size) // 2, y0 + image_y), thumbs[name])
        bounds = draw.textbbox((0, 0), name, font=label_font)
        text_width = bounds[2] - bounds[0]
        draw.text((x0 + (cell_width - text_width) // 2, y0 + label_y), name, font=label_font, fill=(239, 242, 248))
    sheet.save(QA_DIR / f"recognizability-contact-sheet-{size}px.png")


for target_size in (64, 32):
    build(target_size)
