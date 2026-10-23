#!/usr/bin/env python3
"""Bouwt nevo/nevo2025_nutrients.json (overige voedingsstoffen) uit het officiële NEVO-bestand.

Gebruik:
    python3 nevo/build_nevo_nutrients.py pad/naar/NEVO2025_v9.0.zip

Per voedingsmiddel (NEVO-code) de waarden per 100 g of 100 ml, ongewijzigd overgenomen;
lege velden blijven leeg (null): onbekend is iets anders dan nul.
Bron: NEVO online versie 2025/9.0, RIVM, Bilthoven.
"""
import csv, io, json, sys, zipfile
from pathlib import Path

CSV_NAME = "NEVO2025_v9.0.csv"
OUT = Path(__file__).resolve().parent / "nevo2025_nutrients.json"
# [sleutel, NEVO-kolom, eenheid]
COLS = [
    ["vezel", "FIBT (g)", "g"], ["suiker", "SUGAR (g)", "g"], ["verzadigd", "FASAT (g)", "g"], ["natrium", "NA (mg)", "mg"],
    ["kalium", "K (mg)", "mg"], ["calcium", "CA (mg)", "mg"], ["fosfor", "P (mg)", "mg"], ["magnesium", "MG (mg)", "mg"],
    ["ijzer", "FE (mg)", "mg"], ["zink", "ZN (mg)", "mg"], ["selenium", "SE (µg)", "µg"], ["jodium", "ID (µg)", "µg"],
    ["vitA", "VITA_RAE (µg)", "µg"], ["vitD", "VITD (µg)", "µg"], ["vitE", "VITE (mg)", "mg"], ["vitK", "VITK (µg)", "µg"],
    ["vitB1", "THIA (mg)", "mg"], ["vitB2", "RIBF (mg)", "mg"], ["niacine", "NIAEQ (mg)", "mg"], ["vitB6", "VITB6 (mg)", "mg"],
    ["vitB12", "VITB12 (µg)", "µg"], ["folaat", "FOL (µg)", "µg"], ["vitC", "VITC (mg)", "mg"],
]


def num(value):
    v = str(value or "").strip().replace(",", ".")
    if v == "":
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return round(f, 3) if f < 1 else round(f, 2) if f < 100 else round(f, 1)


def main(src):
    src = Path(src)
    if src.suffix == ".zip":
        with zipfile.ZipFile(src) as z:
            raw = z.read(CSV_NAME).decode("utf-8-sig")
    else:
        raw = src.read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw), delimiter="|")
    rows = {}
    for r in reader:
        rows[str(int(r["NEVO-code"]))] = [num(r.get(c[1])) for c in COLS]
    out = {"bron": "NEVO online versie 2025/9.0, RIVM, Bilthoven", "per": "100 g of 100 ml",
           "cols": [c[0] for c in COLS], "units": [c[2] for c in COLS], "rows": rows}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} voedingsmiddelen, {len(COLS)} voedingsstoffen geschreven naar {OUT}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
