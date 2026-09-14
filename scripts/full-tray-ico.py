# 只用「全身」裁切做托盘图标：生成多尺寸 .ico，并对比「只给 48px」的差别。
# 只做裁剪 + 缩放，不重绘任何图形；输出仍在 artifacts/icon-draft/，不碰 build/。
import os
import struct
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "brand", "tray-source.png")
OUT = os.path.join(ROOT, "artifacts", "icon-draft")

# 托盘在 Windows 上按 DPI 取 16 / 20 / 24 / 32；48 以上给应用图标等场景用。
ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

LIGHT = (236, 236, 236)
DARK = (31, 31, 31)

src = Image.open(SRC).convert("RGBA")


def square_crop(im, box, pad=0.0):
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    side = int(round(side * (1 + pad * 2)))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    left, top = int(round(cx - side / 2)), int(round(cy - side / 2))
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(im.crop((left, top, left + side, top + side)), (0, 0))
    return out


def shrink(im, target):
    """逐级减半再落到目标尺寸（高质量路径，ico 内每个尺寸都这样生成）。"""
    cur = im
    while cur.width > target * 2:
        cur = cur.resize((cur.width // 2, cur.height // 2), Image.LANCZOS)
    return cur.resize((target, target), Image.LANCZOS)


def naive(im, target):
    """一次性缩放：模拟「只给一张 48px，系统自己缩到目标尺寸」的路径。"""
    return im.resize((target, target), Image.BILINEAR)


def write_ico(path, entries):
    """手写 ICO 容器，塞进我们自己高质量渲染的 PNG，避免库内部再插值一次。"""
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    dirs, blobs = b"", []
    for size, blob in entries:
        dim = 0 if size >= 256 else size
        dirs += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs.append(blob)
    with open(path, "wb") as f:
        f.write(header + dirs + b"".join(blobs))


FULL = square_crop(src, src.getchannel("A").getbbox(), pad=0.03)
print("full square:", FULL.size)

# ---- 1) 多尺寸 ico ----
entries = []
for s in ICO_SIZES:
    p = f"{OUT}/_ico-{s}.png"
    shrink(FULL, s).save(p)
    with open(p, "rb") as f:
        entries.append((s, f.read()))
    os.remove(p)
write_ico(f"{OUT}/full-body.ico", entries)
print("wrote full-body.ico", ICO_SIZES)

# ---- 2) 对比拼版 ----
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


COLS = [16, 20, 24, 32]
ZOOM = {16: 10, 20: 8, 24: 7, 32: 5}   # 放大到接近 CELL 见方，像素级还原
CELL = 190
MARGIN = 16
PAD = 10
COLW = CELL + PAD
F48 = shrink(FULL, 48)

BANDS = [
    ("① 只给一张 48px（系统负责缩到目标尺寸）", lambda t: naive(F48, t)),
    ("② 多尺寸 ico（每个尺寸都是原生像素）", lambda t: shrink(FULL, t)),
]
head_h = 76
title_h = 40
band_h = title_h + CELL + 34

sheet_w = MARGIN * 2 + COLW * len(COLS)
sheet_h = MARGIN + head_h + 2 * len(BANDS) * (band_h + 12) + MARGIN
sheet = Image.new("RGB", (sheet_w, sheet_h), (250, 250, 250))
d = ImageDraw.Draw(sheet)

f_title = font(23)
f_sub = font(15)
f_lab = font(17)
f_small = font(13)


def ink(bg):
    return (20, 20, 20) if bg == LIGHT else (235, 235, 235)


def dim(bg):
    return (105, 105, 105) if bg == LIGHT else (170, 170, 170)


d.text((MARGIN, MARGIN + 2), "全身立绘做托盘图标：一张 48px  对比  多尺寸 ico",
       font=f_title, fill=(15, 15, 15))
d.text((MARGIN, MARGIN + 40),
       "本机两块屏都是 125% 缩放，Windows 托盘实际取 20px。下方每个格子都放大到像素级。",
       font=f_sub, fill=(95, 95, 95))

y = MARGIN + head_h
for bg_name, bg in (("浅色任务栏  Light", LIGHT), ("深色任务栏  Dark", DARK)):
    for band_title, render in BANDS:
        band = Image.new("RGB", (sheet_w - MARGIN * 2, band_h), bg)
        bd = ImageDraw.Draw(band)
        bd.text((2, 2), f"{band_title}    ·    {bg_name}", font=f_lab, fill=ink(bg))

        for c, target in enumerate(COLS):
            z = ZOOM[target]
            x = c * COLW
            cell = Image.new("RGB", (CELL, CELL), bg)
            big = render(target).resize((target * z, target * z), Image.NEAREST)
            cell.paste(big, ((CELL - big.width) // 2, (CELL - big.height) // 2), big)
            band.paste(cell, (x, title_h))
            tag = f"{target}px" + ("  ← 托盘实际" if target == 20 else "")
            bd.text((x + 4, title_h + CELL + 8), tag, font=f_small, fill=dim(bg))
            if c:
                bd.line([(x - PAD // 2, title_h + 6), (x - PAD // 2, title_h + CELL - 6)],
                        fill=(215, 215, 215) if bg == LIGHT else (66, 66, 66), width=1)

        sheet.paste(band, (MARGIN, y))
        y += band_h + 12
    y += 12

sheet.save(f"{OUT}/full-vs-ico.png")
print("wrote full-vs-ico.png", sheet.size)
