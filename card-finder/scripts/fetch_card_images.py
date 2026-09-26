#!/usr/bin/env python3
"""Download card images into images/cards/ and point data/card-images.json at them.

1. Put the official image URL for each card in data/card-images.json:
       { "hdfc-bank-infinia-metal-edition": "https://.../infinia.png", ... }
   (keys are card ids from data/cards.js)
2. Run:  python3 scripts/fetch_card_images.py
3. Then: python3 scripts/import_cards.py data/Indian_Credit_Card_Catalogue_v0_5.xlsx

Entries that already point at a local file are left alone, and a failed
download keeps its URL, so re-running only retries what's missing.
"""
import json
import mimetypes
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAP = ROOT / "data" / "card-images.json"
OUT = ROOT / "images" / "cards"
EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}


def main():
    images = json.loads(MAP.read_text(encoding="utf-8")) if MAP.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    fetched = failed = 0
    for card_id, src in sorted(images.items()):
        if not src or not src.startswith(("http://", "https://")):
            continue
        try:
            req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0 (CardFinder image fetch)"})
            with urllib.request.urlopen(req, timeout=30) as res:
                ctype = res.headers.get_content_type()
                if not ctype.startswith("image/"):
                    raise ValueError(f"not an image ({ctype})")
                data = res.read(5 * 1024 * 1024 + 1)
            if len(data) > 5 * 1024 * 1024:
                raise ValueError("larger than 5 MB")
            ext = Path(src.split("?")[0]).suffix.lower()
            if ext not in EXTS:
                ext = mimetypes.guess_extension(ctype) or ".png"
            path = OUT / f"{card_id}{ext}"
            path.write_bytes(data)
            images[card_id] = path.relative_to(ROOT).as_posix()
            fetched += 1
        except Exception as err:  # keep going; report at the end
            failed += 1
            print(f"  {card_id}: {err}", file=sys.stderr)
    MAP.write_text(json.dumps(images, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Downloaded {fetched} images, {failed} failed. Now re-run scripts/import_cards.py.")


if __name__ == "__main__":
    main()
