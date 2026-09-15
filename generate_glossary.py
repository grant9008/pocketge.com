#!/usr/bin/env python3
"""Build /glossary.html from the Help modal in index.html.

The badge glossary is 23 rows and ~1,290 words of genuinely useful writing --
what "5D HIGH" means, why a break alert is different from sitting near the
edge, how the chart markers differ -- and it was reachable only by opening a
modal inside a JS app. Every item page shipped its own copy of it: 12.5KB
each, 22.9MB across the set, and not one of those copies was a document
search could return for "what does 5d high mean in osrs".

Generated rather than written by hand so the page and the modal cannot drift
apart. index.html is the single source; this only ever reads it.

    python3 generate_glossary.py          # write glossary.html
    python3 generate_glossary.py --check  # verify it is up to date (CI)
"""
import argparse
import re
import sys
from pathlib import Path

SITE = "https://pocketge.com"
TEMPLATE = Path("./index.html")
OUT = Path("./glossary.html")

TITLE = "OSRS GE Badge &amp; Signal Glossary — What Every Marker Means | PocketGE"
DESC = ("What every badge, marker and tag on PocketGE means: 5D HIGH and 5D LOW, "
        "break alerts, margin tags, chart markers, the volume profile and the "
        "analyst rating — in plain language.")

# Pulled from app.css. Only the rules the glossary rows actually use, so this
# page costs ~2KB of CSS instead of loading the app's 257KB sheet for a
# document that is pure prose. The variable values are app.css's :root.
STYLE = """
  .glossary-body {
    --text-main:#D9D3C7; --text-muted:#8A8274; --border-main:#2B2621;
    --buy-color:#E5B842; --sell-color:#26A9AB; --positive:#10B981; --negative:#EF5350;
    --buy-rgb:229, 184, 66; --sell-rgb:38, 169, 171;
  }
  .glossary-section { margin-top:22px; margin-bottom:8px; font-size:11px; font-weight:700;
    color:var(--text-muted); text-transform:uppercase; letter-spacing:0.6px; }
  .glossary-section:first-of-type { margin-top:0; }
  .glossary-row { display:grid; grid-template-columns:110px 1fr; gap:12px; padding:9px 4px;
    font-size:13px; color:var(--text-main); align-items:center; line-height:1.5;
    border-top:1px solid var(--border-main); }
  .glossary-row > :first-child { justify-self:start; }
  .hl-badge { font-size:7.5px; font-weight:900; padding:1px 3px; border-radius:2px;
    letter-spacing:0.2px; line-height:1.3; white-space:nowrap; }
  .hl-badge.high { background:rgba(var(--sell-rgb),0.18); color:var(--sell-color); border:1px solid rgba(var(--sell-rgb),0.55); }
  .hl-badge.low { background:rgba(var(--buy-rgb),0.18); color:var(--buy-color); border:1px solid rgba(var(--buy-rgb),0.55); }
  .hl-badge.high5d { background:var(--sell-color); color:#04120f; box-shadow:0 0 10px rgba(var(--sell-rgb),0.7); }
  .hl-badge.high5d { color:color-mix(in srgb, var(--sell-color) 16%, #000); }
  .hl-badge.low5d { background:var(--buy-color); color:#140f04; box-shadow:0 0 10px rgba(var(--buy-rgb),0.7); }
  .hl-badge.low5d { color:color-mix(in srgb, var(--buy-color) 16%, #000); }
  .wl-trend { font-size:10px; white-space:nowrap; }
  .wl-trend.up { color:var(--positive); }
  .wl-trend.down { color:var(--negative); }
  .wl-trend.neutral { color:var(--text-muted); }
  .legend-dash { width:10px; height:2px; display:inline-block; }
  .legend-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .legend-ring { width:8px; height:8px; border-radius:50%; display:inline-block;
    border:2px solid; box-sizing:border-box; }
  .pg-verdict { font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; line-height:1; }
  .bk-icon { display:inline-block; vertical-align:middle; }
  @media (max-width:560px) { .glossary-row { grid-template-columns:86px 1fr; gap:10px; font-size:12.5px; } }
"""


def inner_html(s, start_pat, tag="div"):
    """Inner HTML of the first element matching start_pat, by depth counting.

    A regex cannot do this: the modal body is 12KB of nested divs, and
    ``.*?</div>`` stops at the first inner close.
    """
    m = re.search(start_pat, s)
    if not m:
        raise SystemExit(f"index.html: no match for {start_pat!r} — markup changed?")
    open_end = s.index(">", m.start()) + 1
    depth = 1
    for tok in re.finditer(rf"<{tag}\b|</{tag}>", s[open_end:]):
        depth += 1 if tok.group(0).startswith(f"<{tag}") else -1
        if depth == 0:
            return s[open_end:open_end + tok.start()]
    raise SystemExit("index.html: unbalanced divs in the help modal")


def build():
    src = TEMPLATE.read_text()
    modal = inner_html(src, r'<div id="helpModal"[\s>]')
    body = inner_html(modal, r'<div class="modal-body"[\s>]').strip()
    rows = body.count('glossary-row')
    if rows < 10:
        raise SystemExit(f"only {rows} glossary rows found — markup changed?")

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<link rel="canonical" href="{SITE}/glossary.html">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://oldschool.runescape.wiki/images/Gilded_scimitar.png">
<link rel="apple-touch-icon" sizes="180x180" href="https://oldschool.runescape.wiki/images/Gilded_scimitar.png">
<link rel="shortcut icon" href="/favicon.png">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<meta property="og:type" content="website">
<meta property="og:url" content="{SITE}/glossary.html">
<meta property="og:image" content="{SITE}/og-image-v2.png">
<meta property="og:site_name" content="PocketGE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{TITLE}">
<meta name="twitter:description" content="{DESC}">
<meta name="twitter:image" content="{SITE}/og-image-v2.png">
<script type="application/ld+json">
{{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
{{"@type":"ListItem","position":1,"name":"PocketGE","item":"{SITE}/"}},
{{"@type":"ListItem","position":2,"name":"Badge & Signal Glossary","item":"{SITE}/glossary.html"}}]}}
</script>
<!-- Generated by generate_glossary.py from the Help modal in index.html.
     Do not edit by hand: edit index.html and re-run, or CI will fail. -->
<link rel="stylesheet" href="finder-page.css">
<style>{STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="brand" href="/"><img src="https://oldschool.runescape.wiki/images/Gilded_scimitar.png" alt="PocketGE logo">PocketGE</a>
    <a class="cta" href="/">Open the trading terminal →</a>
  </div>

  <h1>OSRS GE Badge &amp; Signal Glossary</h1>
  <p class="sub">Every badge, marker and tag the PocketGE terminal can put on a row, a chart or a price — and what each one is actually telling you. This is the same glossary the app's Help button opens, on a page of its own so it can be read, linked and searched without opening the terminal first.</p>

  <div class="glossary-body">
{body}
  </div>

  <a class="big-cta" href="/">▶ See these markers live on the trading terminal</a>

  <div class="footer">
    Prices and signals update live from the OSRS Wiki Grand Exchange API. PocketGE is a free, independent fan tool — not affiliated with Jagex Ltd. · <a href="/">Home</a> · <a href="/flipping-guide.html">Flipping Guide</a> · <a href="/runelite-plugin.html">RuneLite Plugin</a> · <a href="https://ko-fi.com/pocketge" rel="noopener" target="_blank">Support PocketGE</a>
  </div>
</div>
<script src="site-nav.js" defer></script>
</body>
</html>
"""
    return page, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail if glossary.html is not what index.html would produce")
    args = ap.parse_args()

    page, rows = build()
    if args.check:
        if not OUT.exists():
            sys.exit("glossary.html is missing — run generate_glossary.py")
        if OUT.read_text() != page:
            sys.exit("glossary.html is stale — index.html's Help modal changed. "
                     "Run: python3 generate_glossary.py")
        print(f"glossary.html is up to date ({rows} rows)")
        return
    OUT.write_text(page)
    print(f"wrote {OUT} — {rows} glossary rows, {len(page)/1000:.1f} KB")


if __name__ == "__main__":
    main()
