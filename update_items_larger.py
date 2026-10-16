#!/usr/bin/env python3
import requests
import struct
import time
from pathlib import Path
from urllib.parse import quote

# The OSRS Wiki asks every automated client for exactly one thing: "Please set
# a descriptive User-Agent! This is the only thing we ask!" (their API page),
# and generic ones such as python-requests' own default are what gets blocked.
# A bare requests call sends python-requests/x.y and pandas.read_html on a URL
# sends Python-urllib/x.y, so every wiki request goes through this session.
WIKI = requests.Session()
WIKI.headers["User-Agent"] = (
    "pocketge.com item tools - contact via github.com/grant9008/pocketge-flip-tracker"
)

def png_width(path):
    """Width from a PNG's IHDR chunk, or 0 if the file is missing or not a PNG."""
    try:
        with open(path, 'rb') as f:
            head = f.read(24)
    except OSError:
        return 0
    if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return 0
    return struct.unpack('>I', head[16:20])[0]

# Directories
IMAGES_DIR = Path('./images')
IMAGES_DIR.mkdir(exist_ok=True)

# Fetch latest GEIDs {name: id}
print("Fetching latest GE IDs...")
geids_url = "https://oldschool.runescape.wiki/?title=Module:GEIDs/data.json&action=raw&ctype=application/json"
geids_resp = WIKI.get(geids_url)
geids = geids_resp.json()
if '%LAST_UPDATE%' in geids: del geids['%LAST_UPDATE%']
if '%LAST_UPDATE_F%' in geids: del geids['%LAST_UPDATE_F%']
print(f"Loaded {len(geids)} items.")

# Items the wiki had no larger image for on an earlier run. Most icons never
# get one, and without this every run asked again for all ~22,000 of them —
# two requests each, half a day of traffic, for the same 404s. Delete the
# file to re-check everything.
MISSES_PATH = Path('./images-larger-misses.txt')
misses = set(MISSES_PATH.read_text().split()) if MISSES_PATH.exists() else set()

def save_misses():
    MISSES_PATH.write_text("\n".join(sorted(misses, key=int)) + "\n")

# Download larger images (overwrite existing to upgrade to larger)
print("Upgrading images that are still small; already-upgraded ones are skipped...")
new_or_updated = 0
total_items = len(geids)
for idx, (name, ge_id) in enumerate(geids.items(), 1):
    try:
        ge_id = int(ge_id)
    except ValueError:
        continue
    id_str = str(ge_id)
    img_path = IMAGES_DIR / f"{id_str}.png"

    # Skip anything already upgraded. This script used to re-download every
    # item's image on every run — about 160 MB from the wiki's image servers
    # each time — because "overwrite to upgrade" never asked whether a file
    # had been upgraded already. The original icons are at most 36 px wide
    # and every upgrade is wider, so the width in the PNG header says which
    # is which; file size does not (some 36x32 icons are over 1 KB).
    if png_width(img_path) > 36 or id_str in misses:
        continue
    print(f"[{idx}/{total_items}] Processing {id_str} ({name})...")

    wiki_name = quote(name.replace(' ', '_').replace("'", "%27").strip())
    
    # Priority 1: Detailed larger image (~200-500px render)
    detail_url = f"https://oldschool.runescape.wiki/images/{wiki_name}_detail.png"
    resp = WIKI.get(detail_url, timeout=10)
    if resp.status_code == 200 and len(resp.content) > 1000:  # Valid larger image (size check to avoid tiny placeholders)
        with open(img_path, 'wb') as f:
            f.write(resp.content)
        new_or_updated += 1
        print("  ✅ Downloaded/Updated detailed large image!")
    else:
        # Priority 2: 100px thumb (larger than 32px, pixelated no blur)
        thumb_url = f"https://oldschool.runescape.wiki/images/thumb/{wiki_name}/100px-{wiki_name}.png?pixelated=true"
        resp = WIKI.get(thumb_url, timeout=10)
        if resp.status_code == 200 and len(resp.content) > 500:
            with open(img_path, 'wb') as f:
                f.write(resp.content)
            new_or_updated += 1
            print("  ✅ Downloaded/Updated 100px thumb (non-blurry)!")
        else:
            print(f"  ❌ No larger image found (status {resp.status_code}) - keeping existing or skipping.")
            if resp.status_code == 404:
                misses.add(id_str)  # only a definite "not there"; errors are retried next run
                if len(misses) % 100 == 0:
                    save_misses()

    time.sleep(1)  # 1-sec delay for safety

save_misses()
print(f"Downloaded/Updated {new_or_updated} larger images in total.")
print("\nDone! Commit: git add images/ && git commit -m 'Upgrade to larger wiki images (Oct 2025)' && git push")
print("New instructions: Run this from your repo root. It overwrites small images with larger ones where available.")
print("Test: Refresh site - images should be bigger/sharper (wiki has details for ~16k items).")