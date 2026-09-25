"""Shrinks the photos stored by fetch-photos.js so the standalone file stays small.

    pip install Pillow
    python3 scripts/shrink-photos.py

Slack's photos are often large PNGs (hundreds of KB each). This re-encodes every stored photo
as a JPEG at most 320px on each side, which is plenty for the 260px profile picture. Photos
already at that size are left alone, so running it again doesn't degrade them.
"""

import base64
import io
import json
import pathlib
import sys

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("This script needs Pillow: pip install Pillow")

MEMBERS_FILE = pathlib.Path(__file__).resolve().parent.parent / "private" / "members.json"
MAX_SIDE = 320
QUALITY = 82
BACKGROUND = (255, 255, 255)  # Transparent areas are flattened onto white.


def shrink(data_uri):
    header, encoded = data_uri.split(",", 1)
    image = Image.open(io.BytesIO(base64.b64decode(encoded)))
    if header == "data:image/jpeg;base64" and max(image.size) <= MAX_SIDE:
        return data_uri

    image = ImageOps.exif_transpose(image)  # Also takes the first frame of an animated GIF.
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        flat = Image.new("RGB", image.size, BACKGROUND)
        flat.paste(image, mask=image.getchannel("A"))
        image = flat
    else:
        image = image.convert("RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)

    out = io.BytesIO()
    image.save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def main():
    if not MEMBERS_FILE.exists():
        sys.exit("No imported members yet. Run: node scripts/import-members.js path/to/members.json")
    members = json.loads(MEMBERS_FILE.read_text())
    before = after = 0
    for member in members:
        if not member.get("photo"):
            continue
        before += len(member["photo"])
        try:
            member["photo"] = shrink(member["photo"])
        except Exception as err:  # Keep the original rather than lose the photo.
            print(f"  could not shrink {member['name']}: {err}")
        after += len(member["photo"])
    MEMBERS_FILE.write_text(json.dumps(members, indent=1, ensure_ascii=False) + "\n")
    print(f"Photos: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
