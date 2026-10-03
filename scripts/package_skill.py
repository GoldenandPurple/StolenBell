#!/usr/bin/env python3
"""Zip the Stolen Bell tip-out skill for upload to Claude (Settings > Capabilities > Skills).

Usage: python scripts/package_skill.py [output.zip]   (default: stolen-bell-tipout.zip)
Leaves out tests and Python caches; the skill only needs SKILL.md, scripts, examples and forms.
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "skills" / "stolen-bell-tipout"
SKIP = {"tests", "__pycache__"}

out = Path(sys.argv[1] if len(sys.argv) > 1 else "stolen-bell-tipout.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(SKILL.rglob("*")):
        if path.is_file() and not SKIP & set(path.relative_to(SKILL).parts) and path.suffix != ".pyc":
            zf.write(path, Path(SKILL.name) / path.relative_to(SKILL))
print(f"Wrote {out}")
