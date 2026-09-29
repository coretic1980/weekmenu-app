#!/usr/bin/env python3
"""Bouwt data/nevo2025_macros.json uit het officiële NEVO-bestand.

Gebruik:
    python3 scripts/build_nevo_subset.py pad/naar/NEVO2025_v9_0.zip

Neemt per voedingsmiddel ongewijzigd over: NEVO-code, Nederlandse naam,
energie (kcal), eiwit, koolhydraten en vet (per 100 g of 100 ml).
Bron: NEVO online versie 2025/9.0, RIVM, Bilthoven.
"""
import csv, io, json, sys, zipfile
from pathlib import Path

CSV_NAME = "NEVO2025_v9.0.csv"
OUT = Path(__file__).resolve().parent.parent / "data" / "nevo2025_macros.json"


def num(value):
    try:
        return round(float(str(value).replace(",", ".")), 1)
    except ValueError:
        return 0.0


def main(src):
    src = Path(src)
    if src.suffix == ".zip":
        with zipfile.ZipFile(src) as z:
            raw = z.read(CSV_NAME).decode("utf-8-sig")
    else:
        raw = src.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw), delimiter="|")
    rows = []
    for r in reader:
        rows.append([
            int(r["NEVO-code"]),
            r["Voedingsmiddelnaam/Dutch food name"].strip(),
            num(r["ENERCC (kcal)"]),
            num(r["PROT (g)"]),
            num(r["CHO (g)"]),
            num(r["FAT (g)"]),
        ])
    OUT.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} voedingsmiddelen geschreven naar {OUT}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
