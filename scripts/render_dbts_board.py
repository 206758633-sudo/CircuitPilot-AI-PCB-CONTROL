#!/usr/bin/env python3
"""Render the DBTS-A01 PCB (top/bottom/inner layers) to SVG from live CLI readback.

Inputs (produced by the easyeda CLI):
  artifacts/final-5v-chg/board-final.json   (pcb dump: components + pads + silk + outline)
  artifacts/final-5v-chg/tracks.json        (pcb track-list)
  artifacts/final-5v-chg/vias.json          (pcb via-list)
  artifacts/final-5v-chg/pours.json         (pcb pour-list)

Output: artifacts/final-5v-chg/board-panels.svg  (4-panel layer view)
"""
import json
import os
import sys

BASE = os.path.join(os.path.dirname(__file__), "..", "artifacts", "final-5v-chg")


def load(name):
    with open(os.path.join(BASE, name), encoding="utf-8") as fh:
        raw = fh.read()
    start = raw.find("{")
    return json.JSONDecoder().raw_decode(raw[start:])[0].get("result", {})


def main():
    board = json.load(open(os.path.join(BASE, "board-final.json"), encoding="utf-8"))
    tracks = load("tracks.json").get("lines") or []
    vias = load("vias.json").get("vias") or []

    outline = board["outline"]
    pts = outline["points"]
    bb = outline["bbox"]
    W = bb["maxX"] - bb["minX"]
    H = bb["maxY"] - bb["minY"]
    pad = 90
    panels = [
        ("Top Layer (L1)", 1, "#1b5e20", "#a5d6a7"),
        ("Bottom Layer (L2)", 2, "#0d47a1", "#90caf9"),
        ("Inner1 (L15)", 15, "#4a148c", "#ce93d8"),
        ("Inner2 (L16)", 16, "#e65100", "#ffcc80"),
    ]
    ncomp = len([c for c in board["components"] if c.get("designator")])
    pw, ph = W + 2 * pad, H + 2 * pad
    title = 64
    cols, rows = 2, 2
    svg_w = cols * pw
    svg_h = rows * (ph + title)

    def poly_points():
        return " ".join(f"{x - bb['minX'] + pad},{(bb['maxY'] - y) + pad}" for x, y in pts)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{svg_w}" height="{svg_h}" '
        f'viewBox="0 0 {svg_w} {svg_h}" font-family="Helvetica,Arial,sans-serif">',
        f'<rect width="{svg_w}" height="{svg_h}" fill="#111"/>',
    ]

    for i, (label, layer, dark, light) in enumerate(panels):
        ox = (i % cols) * pw
        oy = (i // cols) * (ph + title)
        parts.append(f'<g transform="translate({ox},{oy})">')
        parts.append(f'<rect width="{pw}" height="{ph + title}" fill="#1b1b1b"/>')
        parts.append(
            f'<text x="18" y="40" fill="#fff" font-size="34" font-weight="bold">'
            f"{label} — DBTS-A01 ({ncomp} parts, 130×88 mm)</text>"
        )
        # board body
        parts.append(
            f'<polygon points="{poly_points()}" fill="#0e2b12" stroke="#66bb6a" '
            f'stroke-width="3" transform="translate(0,{title})"/>'
        )
        parts.append(f'<g transform="translate(0,{title})">')
        # pads (component footprint)
        for comp in board["components"]:
            for p in comp.get("pads") or []:
                pl = p.get("layer")
                if pl not in (layer, 12):
                    continue
                x = p["x"] - bb["minX"] + pad
                y = bb["maxY"] - p["y"] + pad
                w, h = p["width"], p["height"]
                rot = p.get("rotation") or 0
                fill = "#ffd54f" if p.get("net") else "#9e9e9e"
                parts.append(
                    f'<rect x="{x - w / 2:.2f}" y="{y - h / 2:.2f}" width="{w:.2f}" '
                    f'height="{h:.2f}" fill="{fill}" fill-opacity="0.85" '
                    f'transform="rotate({-rot},{x:.2f},{y:.2f})"/>'
                )
        # tracks
        for t in tracks:
            if t.get("layer") != layer:
                continue
            x1 = t["startX"] - bb["minX"] + pad
            y1 = bb["maxY"] - t["startY"] + pad
            x2 = t["endX"] - bb["minX"] + pad
            y2 = bb["maxY"] - t["endY"] + pad
            parts.append(
                f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" '
                f'stroke="{light}" stroke-width="{t["lineWidth"]:.2f}" '
                f'stroke-linecap="round"/>'
            )
        # vias
        for v in vias:
            x = v["x"] - bb["minX"] + pad
            y = bb["maxY"] - v["y"] + pad
            parts.append(
                f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{v["diameter"] / 2:.2f}" '
                f'fill="#ff7043" fill-opacity="0.9"/>'
            )
            parts.append(
                f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{v["holeDiameter"] / 2:.2f}" fill="#1b1b1b"/>'
            )
        # designators
        for comp in board["components"]:
            d = comp.get("designator") or ""
            if not d:
                continue
            x = comp["x"] - bb["minX"] + pad
            y = bb["maxY"] - comp["y"] + pad
            parts.append(
                f'<text x="{x:.1f}" y="{y:.1f}" fill="#ffffff" fill-opacity="0.75" '
                f'font-size="26" text-anchor="middle">{d}</text>'
            )
        parts.append("</g></g>")

    parts.append("</svg>")
    out = os.path.join(BASE, "board-panels.svg")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))
    print(f"✅ {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    sys.exit(main())
