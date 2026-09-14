# 从用户立绘派生托盘图标资产（只做裁剪 + 缩放，不重绘任何图形）。
#
# 产出：
#   build/tray/tray-<n>.png   托盘运行时按屏幕缩放比选取的原生像素图（16/20/24/28/32/40/48）
#   build/tray.ico            多尺寸 ico（16…256），供外部查看 / 其他 Windows 场景使用
#   artifacts/icon-draft/*    给用户检查用的草稿与对比图
#
# 不写、不改 build/icon.png、build/icon.ico、build/brand/*（用户手绘素材）。
import os
import struct

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "brand", "tray-source.png")
OUT = os.path.join(ROOT, "artifacts", "icon-draft")
BUILD = os.path.join(ROOT, "build")
# 屏幕缩放比 -> 托盘小图标边长（SM_CXSMICON）：100%→16 / 125%→20 / 150%→24 / 200%→32
TRAY_SIZES = [16, 20, 24, 28, 32, 40, 48]
ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

LIGHT = (236, 236, 236)
DARK = (31, 31, 31)

src = Image.open(SRC).convert("RGBA")


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


def write_ico(path, entries):
    """手写 ICO 容器，塞进我们自己渲染好的 PNG，避免库内部再插值一次。"""
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

# ---- 1) 托盘运行时用的原生尺寸 PNG ----
os.makedirs(os.path.join(BUILD, "tray"), exist_ok=True)
for s in TRAY_SIZES:
    shrink(FULL, s).save(os.path.join(BUILD, "tray", f"tray-{s}.png"))
print("wrote build/tray/tray-*.png", TRAY_SIZES)

# ---- 2) 多尺寸 ico ----
os.makedirs(OUT, exist_ok=True)
entries = []
for s in ICO_SIZES:
    p = os.path.join(OUT, f"_ico-{s}.png")
    shrink(FULL, s).save(p)
    with open(p, "rb") as f:
        entries.append((s, f.read()))
    os.remove(p)
write_ico(os.path.join(BUILD, "tray.ico"), entries)
print("wrote build/tray.ico", ICO_SIZES)

# ---- 3) 给用户检查用的对比拼版 ----
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except Exception:
        return ImageFont.load_default()


COLS = [16, 20, 24, 32]
ZOOM = {16: 10, 20: 8, 24: 7, 32: 5}
CELL = 190
MARGIN = 16
PAD = 10
COLW = CELL + PAD
F48 = shrink(FULL, 48)
BANDS = [
    ("① 只给一张 48px（系统负责缩到目标尺寸）", lambda t: F48.resize((t, t), Image.BILINEAR)),
    ("② 多尺寸 ico（每个尺寸都是原生像素）", lambda t: shrink(FULL, t)),
]

head_h = 76
title_h = 40
band_h = title_h + CELL + 34
sheet_w = MARGIN * 2 + COLW * len(COLS)
sheet_h = MARGIN + head_h + 2 * len(BANDS) * (band_h + 12) + MARGIN
sheet = Image.new("RGB", (sheet_w, sheet_h), (250, 250, 250))
d = ImageDraw.Draw(sheet)
f_title = font(24)
f_sub = font(16)
f_band = font(19)
f_small = font(14)

d.text((MARGIN, MARGIN + 2), "全身立绘做托盘图标：48px 单图  vs  多尺寸 ico", font=f_title, fill=(15, 15, 15))
d.text((MARGIN, MARGIN + 38), "两台显示器都是 125% 缩放，Windows 托盘实际取 20px。每个尺寸都放大到像素级对比。",
       font=f_sub, fill=(95, 95, 95))

y = MARGIN + head_h
for bg_name, bg in (("浅色任务栏 / Light taskbar", LIGHT), ("深色任务栏 / Dark taskbar", DARK)):
    for title, render in BANDS:
        band = Image.new("RGB", (sheet_w - MARGIN * 2, band_h), bg)
        bd = ImageDraw.Draw(band)
        bd.text((16, 8), f"{title}    〔{bg_name}〕", font=f_band,
                fill=(20, 20, 20) if bg == LIGHT else (240, 240, 240))
        for i, t in enumerate(COLS):
            z = ZOOM[t]
            big = render(t).resize((t * z, t * z), Image.NEAREST)
            if big.width > CELL - 16:
                big = render(t).resize((CELL - 16, CELL - 16), Image.NEAREST)
            cell = Image.new("RGB", (CELL, CELL), bg)
            cell.paste(big, ((CELL - big.width) // 2, (CELL - big.height) // 2), big)
            band.paste(cell, (16 + i * COLW, title_h))
            tag = f"{t}px" + ("  ← 托盘实际" if t == 20 else "")
            bd.text((16 + i * COLW + 6, title_h + CELL + 8), tag, font=f_small,
                    fill=(120, 120, 120) if bg == LIGHT else (165, 165, 165))
        sheet.paste(band, (MARGIN, y))
        y += band_h + 12

sheet.save(os.path.join(OUT, "full-vs-ico.png"))
print("wrote full-vs-ico.png")
