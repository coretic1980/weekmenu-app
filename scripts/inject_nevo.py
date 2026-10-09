#!/usr/bin/env python3
"""Zet data/nevo2025_macros.json in het <script id="nevo-data">-blok van index.html.

index.html blijft zo één zelfstandig bestand (vereist voor publicatie als Claude-artifact).
Gebruik:  python3 scripts/inject_nevo.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
html_path = ROOT / "index.html"
data = (ROOT / "data" / "nevo2025_macros.json").read_text(encoding="utf-8").replace("</", "<\\/")
html = html_path.read_text(encoding="utf-8")
pattern = re.compile(r'(<script type="application/json" id="nevo-data">)(.*?)(</script>)', re.S)
if not pattern.search(html):
    raise SystemExit("nevo-data-blok niet gevonden in index.html")
html = pattern.sub(lambda m: m.group(1) + data + m.group(3), html, count=1)
html_path.write_text(html, encoding="utf-8")
print("NEVO-data bijgewerkt in index.html")
