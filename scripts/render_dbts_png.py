#!/usr/bin/env python3
"""Render DBTS-A01 PCB evidence PNGs from the live CLI readback (Pillow only).

Outputs (artifacts/final-5v-chg/):
  1. DBTS-A01-PCB-四层视图.png       four-panel layer view (top/bottom/inner1/inner2)
  2. DBTS-A01-排针对插界面.png        zoomed interface view: J7/J8 (1x6) + purchased
                                     module outline / pad columns / dimensions

Reads board-final.json, tracks.json, vias.json (all produced by `easyeda pcb ...`).
"""
import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

BASE = os.path.join(os.path.dirname(__file__), "..", "artifacts", "final-5v-chg")
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FALLBACK = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(size, bold=False):
    for path, idx in ((CJK, 0), (FALLBACK, 0)):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except Exception:
                continue
    return ImageFont.load_default()


def load(name):
    with open(os.path.join(BASE, name), encoding="utf-8") as fh:
        raw = fh.read()
    start = raw.find("{")
    return json.JSONDecoder().raw_decode(raw[start:])[0].get("result") or {}


def board_data():
    board = json.load(open(os.path.join(BASE, "board-final.json"), encoding="utf-8"))
    if "result" in board:
        board = board["result"]
    tracks = load("tracks.json").get("lines") or []
    vias = load("vias.json").get("vias") or []
    return board, tracks, vias


# ----------------------------------------------------------------------------- panels
def render_panels():
    board, tracks, vias = board_data()
    bb = board["outline"]["bbox"]
    pts = board["outline"]["points"]
    W, H = bb["maxX"] - bb["minX"], bb["maxY"] - bb["minY"]
    scale = 0.55           # px per mil
    pad = 40
    title = 46
    pw, ph = int(W * scale) + 2 * pad, int(H * scale) + 2 * pad
    cols = rows = 2
    img = Image.new("RGB", (cols * pw, rows * (ph + title)), "#101010")
    d = ImageDraw.Draw(img)
    panels = [
        ("Top Layer (L1)", 1, "#a5d6a7"),
        ("Bottom Layer (L2)", 2, "#90caf9"),
        ("Inner1 (L15) — GND plane", 15, "#ce93d8"),
        ("Inner2 (L16) — +3V3 plane", 16, "#ffcc80"),
    ]
    n = len([c for c in board["components"] if c.get("designator")])
    f_title, f_des, f_small = font(24), font(11), font(9)

    def tp(x, y, ox, oy):
        return ox + pad + (x - bb["minX"]) * scale, oy + pad + (bb["maxY"] - y) * scale

    for i, (label, layer, light) in enumerate(panels):
        ox = (i % cols) * pw
        oy = (i // cols) * (ph + title)
        d.rectangle([ox, oy, ox + pw, oy + ph + title], fill="#1b1b1b")
        d.text((ox + 14, oy + 10), f"{label}  —  DBTS-A01  {n} parts",
               fill="#ffffff", font=f_title)
        gy = oy + title
        poly = [tp(x, y, ox, gy) for x, y in pts]
        d.polygon(poly, fill="#0e2b12", outline="#66bb6a")
        # pads
        for comp in board["components"]:
            for p in comp.get("pads") or []:
                if p.get("layer") not in (layer, 12):
                    continue
                cx, cy = tp(p["x"], p["y"], ox, gy)
                w, h = p["width"] * scale, p["height"] * scale
                rot = p.get("rotation") or 0
                fill = "#ffd54f" if p.get("net") else "#9e9e9e"
                if rot:
                    box = Image.new("RGBA", (max(1, int(w)), max(1, int(h))), (0, 0, 0, 0))
                    bd = ImageDraw.Draw(box)
                    bd.rectangle([0, 0, w - 1, h - 1], fill=fill)
                    box = box.rotate(-rot, expand=True)
                    img.paste(box, (int(cx - box.width / 2), int(cy - box.height / 2)), box)
                else:
                    d.rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], fill=fill)
        # tracks
        for t in tracks:
            if t.get("layer") != layer:
                continue
            x1, y1 = tp(t["startX"], t["startY"], ox, gy)
            x2, y2 = tp(t["endX"], t["endY"], ox, gy)
            lw = max(1, t["lineWidth"] * scale)
            d.line([x1, y1, x2, y2], fill=light, width=int(round(lw)))
        # vias
        for v in vias:
            cx, cy = tp(v["x"], v["y"], ox, gy)
            r = v["diameter"] * scale / 2
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#ff7043")
            rh = v["holeDiameter"] * scale / 2
            d.ellipse([cx - rh, cy - rh, cx + rh, cy + rh], fill="#1b1b1b")
        # designators
        for comp in board["components"]:
            dsg = comp.get("designator")
            if not dsg:
                continue
            cx, cy = tp(comp["x"], comp["y"], ox, gy)
            d.text((cx, cy), dsg, fill="#ffffff", font=f_des, anchor="mm")

    out = os.path.join(BASE, "DBTS-A01-PCB-四层视图.png")
    img.save(out)
    print(f"✅ {out}  ({img.size[0]}×{img.size[1]})")


# ------------------------------------------------------------------- interface fit
MOD = dict(x0=2394, y0=1738, x1=4363, y1=2919)   # module body (mm→mil, measured from photo)
VIN_X, BAT_X = 4300, 2450                        # header pad columns under the module
PITCH = 100                                      # 2.54 mm in mil
VIN_Y = [2128, 2028, 1928, 1828, 1728, 1628]
BAT_Y = [2180, 2080, 1980, 1880, 1780, 1680]
VIN_SIG = ["CHG_EN (EN)", "NC", "GND", "NC", "CHG_VBUS (VIN)", "NC"]
BAT_SIG = ["NTC_BAT (NTC)", "NC", "INT_24V_HDR", "NC", "GND", "NC"]
# module-side pad names (inferred, order = top→bottom of each column)
VIN_MOD = ["EN", "ST", "GND", "GND", "VIN", "VIN"]
BAT_MOD = ["NTC", "NTC", "VBAT", "VBAT", "GND", "GND"]


def render_interface():
    board, tracks, vias = board_data()
    X0, X1, Y0, Y1 = 1850, 4780, 1400, 3200
    scale = 0.86
    mx, my = 46, 96
    title_h, foot_h = 78, 210
    Wp, Hp = int((X1 - X0) * scale), int((Y1 - Y0) * scale)
    img = Image.new("RGB", (Wp + 2 * mx, Hp + title_h + foot_h), "#0d1117")
    d = ImageDraw.Draw(img)

    f_t = font(30)
    f_s = font(15)
    f_m = font(13)
    f_xs = font(11)

    def tp(x, y):
        return mx + (x - X0) * scale, title_h + (Y1 - y) * scale

    # clip area
    top, bottom = title_h, title_h + Hp
    left, right = mx, mx + Wp
    board_bb = board["outline"]["bbox"]
    bg = Image.new("RGB", (Wp, Hp), "#0b1a10")
    bd = ImageDraw.Draw(bg)
    poly = [((x - X0) * scale, (Y1 - y) * scale) for x, y in board["outline"]["points"]]
    bd.polygon(poly, fill="#0e2b12", outline="#2e7d32")
    # inner-layer power rulers (L15 GND / L16 +3V3 tracks) as faint context
    for t in tracks:
        if t.get("layer") not in (15, 16):
            continue
        x1, y1 = (t["startX"] - X0) * scale, (Y1 - t["startY"]) * scale
        x2, y2 = (t["endX"] - X0) * scale, (Y1 - t["endY"]) * scale
        bd.line([x1, y1, x2, y2], fill="#24483a" if t["layer"] == 15 else "#3a2f18",
                width=max(1, int(t["lineWidth"] * scale)))
    # TOP-layer tracks (the interface routing)
    for t in tracks:
        if t.get("layer") != 1:
            continue
        x1, y1 = (t["startX"] - X0) * scale, (Y1 - t["startY"]) * scale
        x2, y2 = (t["endX"] - X0) * scale, (Y1 - t["endY"]) * scale
        col = {"CHG_EN": "#ff8a65", "ST_SENSE": "#4dd0e1", "CHG_VBUS": "#ffd54f",
               "NTC_BAT": "#ce93d8", "INT_24V": "#f06292", "INT_24V_HDR": "#ba68c8",
               "GND": "#90a4ae"}.get(str(t.get("net")), "#5b6b73")
        bd.line([x1, y1, x2, y2], fill=col, width=max(1, int(t["lineWidth"] * scale)))
    # module body + pads
    m = MOD
    mx0, my0 = (m["x0"] - X0) * scale, (Y1 - m["y1"]) * scale
    mx1, my1 = (m["x1"] - X0) * scale, (Y1 - m["y0"]) * scale
    overlay = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle([mx0, my0, mx1, my1], fill=(46, 125, 50, 40), outline=(129, 199, 132, 255), width=3)
    # dashed accent border
    def dashed(x0, y0, x1, y1, dash=12, gap=8, col=(255, 183, 77, 230)):
        if y0 == y1:
            x = x0
            while x < x1:
                od.line([(x, y0), (min(x + dash, x1), y0)], fill=col, width=2)
                x += dash + gap
        else:
            y = y0
            while y < y1:
                od.line([(x0, y), (x0, min(y + dash, y1))], fill=col, width=2)
                y += dash + gap
    dashed(mx0, my0 - 6, mx1, my0 - 6)
    bg = Image.alpha_composite(bg.convert("RGBA"), overlay).convert("RGB")
    bd = ImageDraw.Draw(bg)

    # module pad circles + labels
    for x, ys, mods, side in ((VIN_X, VIN_Y, VIN_MOD, "vin"), (BAT_X, BAT_Y, BAT_MOD, "bat")):
        for y, nm in zip(ys, mods):
            cx, cy = (x - X0) * scale, (Y1 - y) * scale
            bd.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=(255, 235, 59))
            bd.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(40, 40, 40))
            if side == "vin":
                bd.text((cx - 16, cy), nm, fill="#ffe082", font=f_xs, anchor="rm")
            else:
                bd.text((cx + 16, cy), nm, fill="#ffe082", font=f_xs, anchor="lm")
    # module text block
    bd.text(((mx0 + mx1) / 2, my0 + 26),
            "外购充电模块 50.0 × 30.0 mm（贴装于板下，焊盘面朝上）",
            fill="#c8e6c9", font=f_m, anchor="mm")
    bd.text(((mx0 + mx1) / 2, my0 + 48),
            "VIN 列 → J7 (1×6)    │    电池列 → J8 (1×6)",
            fill="#a5d6a7", font=f_xs, anchor="mm")

    # pads of the two headers + designators
    for comp in board["components"]:
        if comp.get("designator") not in ("J7", "J8", "J12", "J9"):
            continue
        for p in comp.get("pads") or []:
            cx, cy = tp(p["x"], p["y"])
            w, h = p["width"] * scale, p["height"] * scale
            rot = (p.get("rotation") or 0)
            if rot:
                box = Image.new("RGBA", (max(2, int(w)), max(2, int(h))), (0, 0, 0, 0))
                bdx = ImageDraw.Draw(box)
                bdx.rounded_rectangle([0, 0, w - 1, h - 1], radius=3, fill=(255, 213, 79, 235))
                box = box.rotate(-rot, expand=True)
                img.paste(box, (int(cx - box.width / 2) - mx, int(cy - box.height / 2) - title_h), box)
            else:
                d.rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                            fill="#ffd54f")

    img.paste(bg, (left, top))
    d = ImageDraw.Draw(img)

    # header silhouettes + pin labels
    for des, x, ys, sigs, side in (("J7", VIN_X, VIN_Y, VIN_SIG, "vin"),
                                   ("J8", BAT_X, BAT_Y, BAT_SIG, "bat")):
        cx, cy = tp(x, ys[0])
        col = "#ff7043" if des == "J7" else "#4dd0e1"
        lab = "J7 1×6 (VIN 侧)" if des == "J7" else "J8 1×6 (电池侧)"
        ly = tp(x, ys[-1])[1] + 26
        d.text((cx, ly), lab, fill=col, font=f_m, anchor="ma")
        for i, (y, s) in enumerate(zip(ys, sigs), start=1):
            px, py = tp(x, y)
            d.text((px + (34 if side == "vin" else -34), py), f"{i}", fill="#ffffff",
                   font=f_xs, anchor="rm" if side == "vin" else "lm")
            tx = px + 60 if side == "vin" else px - 60
            d.text((tx, py + 9), s, fill="#b0bec5", font=f_xs,
                   anchor="lm" if side == "vin" else "rm")
    for des, note in (("J12", "INT_24V 隔离跳线（默认开路）"), ("J9", "NTC/电池侧 2P")):
        comp = next((c for c in board["components"] if c.get("designator") == des), None)
        if not comp:
            continue
        cx, cy = tp(comp["x"], comp["y"])
        d.text((cx, cy - 26), f"{des}  {note}", fill="#ba68c8", font=f_xs, anchor="ms")

    # dimensions --------------------------------------------------------------
    def arrow(x1, y1, x2, y2, lbl, col="#ffb74d", off=0):
        d.line([x1, y1, x2, y2], fill=col, width=2)
        d.text(((x1 + x2) / 2, (y1 + y2) / 2 + off), lbl, fill=col, font=f_m, anchor="mm")

    y_ref = tp(0, 1620)[1]
    px1, _ = tp(VIN_X, 0)
    px2, _ = tp(BAT_X, 0)
    arrow(px2, y_ref, px1, y_ref, "焊盘列中心距 1850 mil = 47.0 mm")
    for xx, col in ((px1, "#ff7043"), (px2, "#4dd0e1")):
        d.line([xx, y_ref - 10, xx, y_ref + 10], fill=col, width=2)

    # vertical pitch / span annotation at right of J7
    xann, _ = tp(4540, 0)
    y_a = tp(0, VIN_Y[0])[1]
    y_b = tp(0, VIN_Y[-1])[1]
    arrow(xann, y_a, xann, y_b, "6 位 / 2.54 mm 间距 / 总跨 12.7 mm", col="#80cbc4", off=0)
    d.line([xann - 8, y_a, xann + 8, y_a], fill="#80cbc4", width=2)
    d.line([xann - 8, y_b, xann + 8, y_b], fill="#80cbc4", width=2)
    # module edge distance note
    d.text((mx - 8, top + 8), "板下安装：模块体 60~76 mil 间隙，仅 THT 排针尾穿过",
           fill="#9e9e9e", font=f_xs, anchor="la")

    # titles / footer ----------------------------------------------------------
    d.text((mx, 22), "DBTS-A01 排针对插界面（J7 / J8 ⇄ 外购 6S 充电模块）", fill="#ffffff", font=f_t)
    fy = title_h + Hp + 18
    d.text((mx, fy), "左列 J7 = VIN 侧（CHG_VBUS 输入 / CHG_EN / ST / GND）   "
                     "右列 J8 = 电池侧（VBAT→INT_24V / NTC / GND）", fill="#cfd8dc", font=f_s)
    d.text((mx, fy + 26), "排距 1850 mil = 47.0 mm（与模块两列焊盘实测一致）；单列 6 位、2.54 mm 间距、跨 12.7 mm；"
                          "模块 50.0×30.0 mm 全部落在板框内。", fill="#90a4ae", font=f_s)
    d.text((mx, fy + 52), "安全设计：每个信号在模块侧只接 1 个焊盘（成对焊盘另一只留 NC）；"
                          "INT_24V 串入 J12 跳线，模块插上但未核对引脚前保持开路。", fill="#ffcc80", font=f_s)
    d.text((mx, fy + 84), "⚠ 模块焊盘→信号映射为照片推断（VIN 列自顶：EN/ST/GND/GND/VIN/VIN；"
                          "电池列自顶：NTC/NTC/VBAT/VBAT/GND/GND），上电前必须用万用表逐对核对。",
           fill="#ef9a9a", font=f_s)

    out = os.path.join(BASE, "DBTS-A01-排针对插界面.png")
    img.save(out)
    print(f"✅ {out}  ({img.size[0]}×{img.size[1]})")


if __name__ == "__main__":
    render_panels()
    render_interface()
