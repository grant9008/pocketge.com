#!/usr/bin/env python3
"""Build /items.html — an A-Z index linking every prerendered item page.

706 of the 1,840 item pages (38%) had no inbound link from anywhere on the
site. They were in sitemap.xml and nowhere else.

The cause is in related_html(): it sorts candidate matches by daily volume
and takes the top four, so the busiest items absorb every related link and
the long tail gets none. Dragonstone bolts (e) had 80 inbound links; 745
pages had zero. A sitemap gets a page crawled, but it passes no internal
link equity, which is a poor place for 38% of the set on a site already
short on authority.

This is the conventional fix: one directory page that links all of them, so
every item page has at least one real inbound link. Prices are included so
the page is a usable price list rather than a bare wall of links — it is
meant to be worth landing on, not just worth crawling.

Run after prerender_items.py, which writes the item-pages.js this reads:

    python3 generate_item_index.py --snapshot /tmp/snapshot.json
    python3 generate_item_index.py --check     # verify it is up to date (CI)
"""
import argparse
import json
import re
import sys
from pathlib import Path

SITE = "https://pocketge.com"
PAGES_JS = Path("./item-pages.js")
OUT = Path("./items.html")

TITLE = "All OSRS Item Prices A-Z — Every Grand Exchange Item | PocketGE"
DESC = ("Every OSRS item PocketGE tracks, A to Z, with its live Grand Exchange "
        "price. Jump straight to any item's chart, margin and buy limit.")

STYLE = """
  .az-bar { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 28px; }
  .az-bar a { display:inline-block; min-width:28px; text-align:center; padding:5px 7px;
    border:1px solid var(--border); border-radius:5px; font-weight:700; font-size:13px; }
  .az-bar a:hover { border-color:var(--accent); text-decoration:none; }
  .az-group { margin:0 0 26px; }
  .az-group h2 { display:flex; align-items:baseline; gap:10px; margin:0 0 10px;
    padding-bottom:6px; border-bottom:1px solid var(--border); font-size:22px; scroll-margin-top:12px; }
  .az-group h2 span { font-size:12px; font-weight:400; color:var(--muted); }
  .az-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr));
    gap:2px 18px; list-style:none; margin:0; padding:0; }
  .az-list li { display:flex; justify-content:space-between; gap:10px; align-items:baseline;
    padding:3px 0; font-size:13.5px; border-bottom:1px solid rgba(255,255,255,0.04); }
  .az-list a { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .az-list .gp { flex:0 0 auto; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
  .az-top { font-size:12px; color:var(--muted); }
  @media (max-width:560px) { .az-list { grid-template-columns:1fr; } }
"""


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def slugify(name):
    """Must match slugify() in prerender_items.py and itemSlug() in app.js."""
    s = name.lower().replace("(-)", " minus ").replace("+", " plus ")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def abbrev(n):
    n = int(n)
    if n >= 1_000_000_000:
        return f"{n/1_000_000_000:.2f}B"
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return f"{n:,}"


def page_names():
    txt = PAGES_JS.read_text()
    m = re.search(r"=\s*(\[.*\])\s*;", txt, re.S)
    if not m:
        raise SystemExit("item-pages.js is not in the expected shape — run prerender_items.py")
    names = json.loads(m.group(1))
    if len(names) < 100:
        raise SystemExit(f"only {len(names)} pages listed — refusing to build an index that thin")
    return names


def prices(snapshot):
    """id -> insta-buy, keyed by lowercase NAME so it can be looked up without
    re-deriving ids. Absent snapshot just means no prices, not a failure: the
    index's job is the links."""
    if not snapshot:
        return {}
    try:
        snap = json.loads(Path(snapshot).read_text())
    except OSError as e:
        raise SystemExit(f"could not read snapshot: {e}")
    latest = snap.get("latest") or {}
    out = {}
    for it in snap.get("mapping") or []:
        node = latest.get(str(it.get("id"))) or {}
        if it.get("name") and node.get("high"):
            out[it["name"].lower()] = int(node["high"])
    return out


def build(snapshot=None):
    names = sorted(page_names(), key=lambda n: (n.lower(), n))
    px = prices(snapshot)

    groups = {}
    for n in names:
        first = n[0].upper()
        groups.setdefault(first if first.isalpha() else "#", []).append(n)
    # "#" first so numeric names (3rd Age, 4-dose potions) are not orphaned at
    # the bottom of an index that exists to stop things being orphaned.
    letters = (["#"] if "#" in groups else []) + [c for c in
               "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if c in groups]

    bar = "".join(f'<a href="#g{("num" if L == "#" else L)}">{esc(L)}</a>' for L in letters)

    body = []
    for L in letters:
        items = groups[L]
        rows = []
        for n in items:
            gp = px.get(n.lower())
            gp_html = f'<span class="gp">{abbrev(gp)}</span>' if gp else ""
            rows.append(f'<li><a href="/item/{slugify(n)}/">{esc(n)}</a>{gp_html}</li>')
        body.append(
            f'  <div class="az-group">\n'
            f'    <h2 id="g{"num" if L == "#" else L}">{esc(L)} <span>{len(items)} items</span></h2>\n'
            f'    <ul class="az-list">\n      ' + "\n      ".join(rows) + "\n    </ul>\n"
            f'    <p class="az-top"><a href="#top">Back to top</a></p>\n'
            f'  </div>')

    priced = sum(1 for n in names if n.lower() in px)
    # Only promise prices if most rows actually carry one. Run without a
    # snapshot (or with a partial one) the column is mostly empty, and a lede
    # claiming a price column that isn't there is the kind of small lie that
    # makes the rest of the page look untrustworthy.
    lede = (f"Every one of the {len(names):,} items PocketGE has a page for, A to Z"
            + (", with its Grand Exchange insta-buy price" if priced > len(names) // 2 else "")
            + ". Each links to that item's chart, margin after tax, buy limit and "
              "trade volume.")

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<link rel="canonical" href="{SITE}/items.html">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://oldschool.runescape.wiki/images/Gilded_scimitar.png">
<link rel="apple-touch-icon" sizes="180x180" href="https://oldschool.runescape.wiki/images/Gilded_scimitar.png">
<link rel="shortcut icon" href="/favicon.png">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<meta property="og:type" content="website">
<meta property="og:url" content="{SITE}/items.html">
<meta property="og:image" content="{SITE}/og-image-v2.png">
<meta property="og:site_name" content="PocketGE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{TITLE}">
<meta name="twitter:description" content="{DESC}">
<meta name="twitter:image" content="{SITE}/og-image-v2.png">
<script type="application/ld+json">
{{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
{{"@type":"ListItem","position":1,"name":"PocketGE","item":"{SITE}/"}},
{{"@type":"ListItem","position":2,"name":"All item prices A-Z","item":"{SITE}/items.html"}}]}}
</script>
<!-- Generated by generate_item_index.py from item-pages.js.
     Do not edit by hand: re-run the generator, or CI will fail. -->
<link rel="stylesheet" href="finder-page.css">
<style>{STYLE}</style>
</head>
<body>
<div class="wrap" id="top">
  <div class="topbar">
    <a class="brand" href="/"><img src="https://oldschool.runescape.wiki/images/Gilded_scimitar.png" alt="PocketGE logo">PocketGE</a>
    <a class="cta" href="/">Open the trading terminal →</a>
  </div>

  <h1>All OSRS item prices, A-Z</h1>
  <p class="sub">{lede}</p>

  <nav class="az-bar" aria-label="Jump to letter">{bar}</nav>

{chr(10).join(body)}

  <div class="footer">
    Prices are a snapshot from when this page was built; the terminal shows live ones. PocketGE is a free, independent fan tool — not affiliated with Jagex Ltd. · <a href="/">Home</a> · <a href="/flipping-guide.html">Flipping Guide</a> · <a href="/glossary.html">Badge Glossary</a> · <a href="https://ko-fi.com/pocketge" rel="noopener" target="_blank">Support PocketGE</a>
  </div>
</div>
<script src="site-nav.js" defer></script>
</body>
</html>
"""
    return page, len(names), priced


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", help="price snapshot JSON, for the gp column")
    ap.add_argument("--check", action="store_true",
                    help="fail if items.html is missing or lists a page that does not exist")
    args = ap.parse_args()

    if args.check:
        if not OUT.exists():
            sys.exit("items.html is missing — run generate_item_index.py")
        html = OUT.read_text()
        listed = set(re.findall(r'href="/item/([^/"]+)/"', html))
        want = {slugify(n) for n in page_names()}
        missing = want - listed
        extra = listed - want
        if missing:
            sys.exit(f"items.html is stale — {len(missing)} pages not listed: {sorted(missing)[:10]}")
        if extra:
            sys.exit(f"items.html links {len(extra)} pages that do not exist: {sorted(extra)[:10]}")
        print(f"items.html lists all {len(want):,} item pages")
        return

    page, n, priced = build(args.snapshot)
    OUT.write_text(page)
    print(f"wrote {OUT} — {n:,} items linked, {priced:,} with a price, {len(page)/1000:.0f} KB")


if __name__ == "__main__":
    main()
