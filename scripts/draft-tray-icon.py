# 从用户立绘派生托盘图标草稿（只做裁剪+缩放，不重绘任何图形）。
# 输出到 artifacts/icon-draft/，不碰 build/ 下任何文件。
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "brand", "tray-source.png")
OUT = os.path.join(ROOT, "artifacts", "icon-draft")
SIZES = [16, 20, 24, 32, 48]

src = Image.open(SRC).convert("RGBA")
alpha = src.getchannel("A")

LIGHT = (236, 236, 236)
DARK = (31, 31, 31)


def square_crop(im, box, pad=0.0):
    """按 box 取正方形区域（四周可留 pad 比例透明边），越界自动为透明。"""
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    side = int(round(side * (1 + pad * 2)))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    left, top = int(round(cx - side / 2)), int(round(cy - side / 2))
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(im.crop((left, top, left + side, top + side)), (0, 0))
    return out


def shrink(im, target):
    """逐级减半再落到目标尺寸，避免一次性大幅缩放丢细节。"""
    cur = im
    while cur.width > target * 2:
        cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
    return cur.resize((target, target), Image.LANCZOS)


# 头部：头顶 y≈16 起，到肩线上方 y≈620；x 以头部中心 561 对齐
HEAD_BOX = (251, 0, 871, 620)
# 围裙上的小鲸鱼（立绘自带的图案元素）
WHALE_BOX = (485, 780, 589, 870)
# 全身（原图内容外框 + 少量留白）
FULL_BOX = alpha.getbbox()

VARIANTS = [
    ("head 头部", square_crop(src, HEAD_BOX)),
    ("whale 围裙鲸鱼", square_crop(src, WHALE_BOX)),
    ("full 全身", square_crop(src, FULL_BOX, pad=0.03)),
]

os.makedirs(OUT, exist_ok=True)
for name, im in VARIANTS:
    key = name.split()[0]
    im.save(f"{OUT}/{key}-square.png")
    for s in SIZES:
        shrink(im, s).save(f"{OUT}/{key}-{s}.png")

# ---------------- 检查用拼版 ----------------
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


ZOOM = {16: 8, 20: 6, 24: 5, 32: 4, 48: 2}
GAP, LABEL_W, MARGIN, ROWGAP = 12, 150, 16, 10
ZOOM_BOX = 132
row_w = LABEL_W + MARGIN * 2 + (16 * len(SIZES) + GAP * len(SIZES)) + GAP * 3 + ZOOM_BOX * len(SIZES) + GAP * len(SIZES)
BAND_H = 140

bands = []
for label, im in VARIANTS:
    for bg_name, bg in (("浅色任务栏", LIGHT), ("深色任务栏", DARK)):
        bands.append((label, bg_name, bg, im))

sheet_h = MARGIN * 2 + len(bands) * (BAND_H + ROWGAP)
sheet = Image.new("RGB", (row_w, sheet_h), (250, 250, 250))
draw = ImageDraw.Draw(sheet)
f_label = font(19)
f_small = font(15)

y = MARGIN
for label, bg_name, bg, im in bands:
    band = Image.new("RGB", (row_w, BAND_H), bg)
    bd = ImageDraw.Draw(band)
    # 左侧标签画在浅色底上，避免深色底看不清
    bd.rectangle([0, 0, LABEL_W + MARGIN, BAND_H], fill=(250, 250, 250))
    bd.text((MARGIN, BAND_H // 2 - 26), label, font=f_label, fill=(20, 20, 20))
    bd.text((MARGIN, BAND_H // 2 + 2), bg_name, font=f_small, fill=(90, 90, 90))
    bd.text((MARGIN, BAND_H // 2 + 24), "左：1x 实际 ／ 右：放大", font=f_small, fill=(90, 90, 90))

    # 1x 实际大小（底对齐，便于比较轮廓）
    x = LABEL_W + MARGIN
    for s in SIZES:
        icon = shrink(im, s)
        band.paste(icon, (x, (BAND_H - s) // 2 + 30), icon)
        bd.text((x, BAND_H - 26), f"{s}", font=f_small, fill=(120, 120, 120))
        x += 16 + GAP
    x += GAP * 2
    bd.line([(x - GAP, 12), (x - GAP, BAND_H - 12)], fill=(150, 150, 150), width=1)

    # 放大（NEAREST，像素级还原）
    for s in SIZES:
        z = shrink(im, s).resize((s * ZOOM[s], s * ZOOM[s]), Image.NEAREST)
        cell = Image.new("RGB", (ZOOM_BOX, ZOOM_BOX), bg)
        cell.paste(z, ((ZOOM_BOX - z.width) // 2, (ZOOM_BOX - z.height) // 2), z)
        band.paste(cell, (x, (BAND_H - ZOOM_BOX) // 2))
        bd.text((x + ZOOM_BOX // 2 - 12, BAND_H - 26), f"{s}px", font=f_small, fill=(120, 120, 120))
        x += ZOOM_BOX + GAP

    sheet.paste(band, (0, y))
    y += BAND_H + ROWGAP

sheet.save(f"{OUT}/preview.png")
print("wrote", OUT)
for name, im in VARIANTS:
    print(f"  {name:16s} square={im.size}")
