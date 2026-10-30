#!/usr/bin/env python3
"""Render the charger-module assembly-zone clearance figure (DBTS-A01).

Board outline + every component courtyard, the 50x30 mm module footprint between
J7/J8, the OLD (colliding) and NEW positions of C39 / L2, plus a height table of
every part still inside the zone.  Reads the live CLI readback board-final.json.
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

BASE = os.path.join(os.path.dirname(__file__), "..", "artifacts", "final-5v-chg")
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
CANVAS = (2060, 1560)
SC = 0.255                     # px per mil
OX, OY = 96, 210

# seated height (mm) by device family
HT = [("CD11Z", 25.0), ("XAL8080", 8.1), ("SWPA6045", 6.0), ("HoLR2512", 0.8),
      ("XT60", 12.0), ("PZ254", 8.5), ("CSD19535", 2.3), ("LM5146", 1.0),
      ("LM5017", 1.0), ("CL31A106", 1.8), ("RVT4.7UF", 7.7), ("RVT", 7.7), ("CL05A", 0.5),
      ("CC0805", 0.8), ("0402", 0.4)]


def font(size):
    for p in (CJK, "/System/Library/Fonts/Supplemental/Arial.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def height(dev):
    d = (dev or "").upper()
    for k, v in HT:
        if k.upper() in d:
            return v
    if "0805" in d:
        return 0.8
    if "0402" in d or "1005" in d:
        return 0.4
    if "1206" in d or "3216" in d:
        return 0.9
    return 1.0


b = json.load(open(os.path.join(BASE, "board-final.json"), encoding="utf-8"))
b = b.get("result") or b
BB = b["outline"]["bbox"]
W, H = CANVAS
X = lambda x: OX + (x - BB["minX"]) * SC
Y = lambda y: H - OY - (y - BB["minY"]) * SC

im = Image.new("RGB", CANVAS, "#0e1116")
dr = ImageDraw.Draw(im)
F = {s: font(s) for s in (14, 15, 17, 19, 21, 24, 31)}
REC = []


def T(xy, txt, fnt, fill):
    dr.text(xy, txt, font=fnt, fill=fill)
    REC.append((txt, dr.textbbox(xy, txt, font=fnt)))


T((OX, 40), "DBTS-A01 充电模块装配区 · 高度 / 干涉复核（2026-10-29 15:40 更正版）", F[31], "#f2f6fa")
T((OX, 86), "硬门禁已清：C39(25 mm)、L2(8.1 mm) 迁出装配区；残留 C40(7.7 mm)、L1(6.0 mm) 侵入模块投影边缘 → 待签核", F[19], "#9fb3c8")
T((OX, 120), "数据源：EasyEDA 实板 readback board-final.json + 型号高度表   比例 0.255 px/mil", F[15], "#6b7f95")

dr.rectangle([X(BB["minX"]), Y(BB["maxY"]), X(BB["maxX"]), Y(BB["minY"])], outline="#39506b", width=3)

ZONE = (2394, 1738, 4363, 2919)
comps = [c for c in b["components"] if c.get("designator")]
inside = []
for c in comps:
    bx = c["bbox"]
    dr.rectangle([X(bx["minX"]), Y(bx["maxY"]), X(bx["maxX"]), Y(bx["minY"])], outline="#2c3a4c", width=1)
    ix = min(bx["maxX"], ZONE[2]) - max(bx["minX"], ZONE[0])
    iy = min(bx["maxY"], ZONE[3]) - max(bx["minY"], ZONE[1])
    if ix > 0 and iy > 0:
        inside.append((c["designator"], c.get("device", ""), height(c.get("device")), ix, iy))

# module assembly zone
dr.rectangle([X(ZONE[0]), Y(ZONE[3]), X(ZONE[2]), Y(ZONE[1])], outline="#3ba3ff", width=3)
T((X(ZONE[0]) + 6, Y(ZONE[3]) - 96), "充电模块装配区  x 2394–4363 / y 1738–2919 mil", F[19], "#3ba3ff")

# J7 / J8 pin columns
for name, xx in (("J7", 4300), ("J8", 2450)):
    dr.rectangle([X(xx - 40), Y(2234), X(xx + 40), Y(1624)], outline="#e8b23a", width=2)
    T((X(xx) - 34, Y(1624) + 26), name, F[17], "#e8b23a")


def dashed_box(x0, y0, x1, y1, colour):
    for i in range(0, int((x1 - x0) * SC), 9):
        dr.line([X(x0) + i, Y(y0), min(X(x0) + i + 4, X(x1)), Y(y0)], fill=colour, width=2)
        dr.line([X(x0) + i, Y(y1), min(X(x0) + i + 4, X(x1)), Y(y1)], fill=colour, width=2)
    for i in range(0, int((y1 - y0) * SC), 9):
        dr.line([X(x0), Y(y0) + i, X(x0), min(Y(y0) + i + 4, Y(y1))], fill=colour, width=2)
        dr.line([X(x1), Y(y0) + i, X(x1), min(Y(y0) + i + 4, Y(y1))], fill=colour, width=2)


# OLD positions (collision) — dashed red, labels above the box
dashed_box(3680, 2330, 4320, 2970, "#ff5a5a")
T((X(3680) + 2, Y(2970) - 26), "C39 旧位 Φ16 · 25 mm", F[17], "#ff5a5a")
dashed_box(3720, 2180, 4070, 2510, "#ff5a5a")
T((X(4070) + 14, Y(2510) - 26), "L2 旧位 8.1 mm", F[17], "#ff5a5a")

# NEW positions — solid green, labels to the right
for name, x, y, w, h, hgt, note in (
        ("C39  4760,660", 4760, 660, 640, 640, 25.0, "1000µF/63V 电解 Φ16 · 25 mm · 已在区外"),
        ("L2  4700,1190", 4700, 1190, 350, 330, 8.1, "22 µH 一体成型 8.1 mm · 已在区外"),):
    x0, y0, x1, y1 = x - w / 2, y - h / 2, x + w / 2, y + h / 2
    dr.rectangle([X(x0), Y(y1), X(x1), Y(y0)], outline="#4ee08a", width=3)
    T((X(x1) + 14, Y(y1) - 24), name, F[17], "#4ee08a")
    T((X(x1) + 14, Y(y1) + 2), note, F[14], "#8fe6b3")

# user arrow
ax0, ay0 = X(4152), Y(1620)
ax1, ay1 = X(4660), Y(1080)
dr.line([ax0, ay0, ax1, ay1], fill="#f2c14e", width=4)
dr.polygon([(ax1, ay1), (ax1 - 15, ay1 + 7), (ax1 - 7, ay1 + 15)], fill="#f2c14e")
T((ax0 - 130, ay0 + 10), "用户箭头指向", F[17], "#f2c14e")

# height table
tx, ty = 1440, 214
T((tx, ty - 60), "装配区内剩余元件（高度降序）", F[21], "#f2f6fa")
T((tx, ty - 30), "位号", F[15], "#6b7f95")
T((tx + 52, ty - 30), "型号", F[15], "#6b7f95")
T((tx + 258, ty - 30), "高度", F[15], "#6b7f95")
T((tx + 336, ty - 30), "侵入 mil", F[15], "#6b7f95")
inside.sort(key=lambda r: -r[2])
for i, (d, dev, h, ix, iy) in enumerate(inside[:14]):
    col = "#ff9f43" if h >= 3 else "#9fb3c8"
    yy = ty + i * 26
    T((tx, yy), d, F[15], col)
    T((tx + 52, yy), dev[:19], F[15], col)
    T((tx + 258, yy), "%4.1f mm" % h, F[15], col)
    T((tx + 336, yy), "%3.0fx%-3.0f" % (ix, iy), F[15], col)
T((tx, ty + 14 * 26 + 14), "限高：模块 PCB 底面 8.5 mm（PZ254-1-06 直接对插，待实测复核）", F[17], "#3ba3ff")
T((tx, ty + 14 * 26 + 42), "结论：最高件 C40 7.7 mm → 余量 0.8 mm，须签核", F[19], "#ff9f43")

T((OX, H - 46), "图例：蓝框 = 装配区   黄框 = J7/J8 排针列   红虚线 = 旧位置（干涉）   绿实线 = 新位置   灰框 = 器件外框",
  F[15], "#6b7f95")


def report():
    bad = []
    for i in range(len(REC)):
        for j in range(i + 1, len(REC)):
            A, B = REC[i][1], REC[j][1]
            if A[0] < B[2] - 2 and B[0] < A[2] - 2 and A[1] < B[3] - 2 and B[1] < A[3] - 2:
                bad.append((REC[i][0][:26], REC[j][0][:26]))
    for x in bad:
        print("  TEXT OVERLAP:", x)
    out_of_canvas = [r[0][:30] for r in REC if r[1][2] > W - 6 or r[1][3] > H - 6 or r[1][0] < 4]
    print("overlaps:", len(bad), "outside:", len(out_of_canvas), out_of_canvas[:3])


out = os.path.join(BASE, "DBTS-A01-装配区高度复核.png")
im.save(out)
report()
print("✅", out, im.size)
