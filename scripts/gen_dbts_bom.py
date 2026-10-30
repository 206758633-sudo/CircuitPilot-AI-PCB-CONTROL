#!/usr/bin/env python3
"""Generate the DBTS-A01 BOM (CSV + XLSX) from the live schematic readback."""
import csv
import json
import os
import re

BASE = os.path.join(os.path.dirname(__file__), "..", "artifacts", "final-5v-chg")
SRC = os.path.join(BASE, "schlist.json")
OUT_CSV = os.path.join(BASE, "BOM_DBTS-A01_5V_外置充电模块.csv")
OUT_XLSX = os.path.join(BASE, "BOM_DBTS-A01_5V_外置充电模块.xlsx")


def load_parts():
    raw = open(SRC, encoding="utf-8").read()
    res = json.JSONDecoder().raw_decode(raw[raw.find("{"):])[0]["result"]
    board = json.load(open(os.path.join(BASE, "board-final.json"), encoding="utf-8"))
    on_board = {c["designator"] for c in board["components"] if c.get("designator")}
    rows = []
    seen = set()
    for c in res.get("components") or []:
        if c.get("componentType") != "part":
            continue
        if not c.get("addIntoBom", True):
            continue
        op = c.get("otherProperty") or {}
        des = (c.get("designator") or "").strip()
        if not des or des in seen or des not in on_board:
            continue
        seen.add(des)
        lcsc = (c.get("supplierId") or "").strip()
        mpn = (c.get("manufacturerId") or "").strip()
        mfr = (c.get("manufacturer") or "").strip()
        fp = ((c.get("footprint") or {}).get("name") or "").strip()
        lcsc_name = (op.get("LCSC Part Name") or "").strip()
        desc = (op.get("Description") or "").strip()
        value = lcsc_name.split(" ")[0] if lcsc_name else mpn
        if not value:
            m = re.search(r"阻值:([^;]+)", desc) or re.search(r"容值:([^;]+)", desc)
            value = m.group(1) if m else mpn
        rows.append(
            dict(
                designator=des,
                value=value,
                lcsc_name=lcsc_name or mpn,
                footprint=fp,
                mfr=mfr,
                mpn=mpn,
                lcsc=lcsc,
                remarks=(op.get("JLCPCB Part Class") or "").strip(),
            )
        )
    return rows


def sort_key(des):
    m = re.match(r"([A-Za-z]+)(\d+)", des)
    return (m.group(1), int(m.group(2))) if m else ("ZZZ", 9999)


def main():
    rows = load_parts()
    groups = {}
    for r in rows:
        key = (r["lcsc"], r["mpn"], r["footprint"], r["value"])
        groups.setdefault(key, []).append(r["designator"])
    out = []
    for i, (key, des) in enumerate(
        sorted(groups.items(), key=lambda kv: sort_key(sorted(kv[1], key=sort_key)[0])), start=1
    ):
        lcsc, mpn, fp, value = key
        sample = next(r for r in rows if r["designator"] == des[0])
        out.append(
            [
                i,
                " ".join(sorted(des, key=sort_key)),
                len(des),
                value,
                fp,
                sample["mfr"],
                mpn,
                lcsc,
                sample["remarks"],
            ]
        )

    header = ["序号", "位号", "数量", "值/规格", "封装", "厂商", "厂商料号", "LCSC编号", "备注"]
    with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(out)
    print(f"✅ {OUT_CSV} — {len(out)} 行 / {len(rows)} 个器件")

    try:
        import xlsxwriter

        wb = xlsxwriter.Workbook(OUT_XLSX)
        ws = wb.add_worksheet("BOM")
        head = wb.add_format({"bold": True, "bg_color": "#1f4e78", "font_color": "white", "border": 1, "align": "center"})
        cell = wb.add_format({"border": 1})
        for c, h in enumerate(header):
            ws.write(0, c, h, head)
        for r, row in enumerate(out, start=1):
            for c, v in enumerate(row):
                ws.write(r, c, v, cell)
        widths = [6, 42, 6, 26, 30, 18, 22, 14, 18]
        for c, wd in enumerate(widths):
            ws.set_column(c, c, wd)
        ws.freeze_panes(1, 0)
        ws.autofilter(0, 0, len(out), len(header) - 1)
        wb.close()
        print(f"✅ {OUT_XLSX}")
    except ImportError:
        print("(xlsxwriter 不可用，仅输出 CSV)")


if __name__ == "__main__":
    main()
