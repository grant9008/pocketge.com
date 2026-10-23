/* Flip history — the whole lifetime ledger, read from the RuneLite plugin's
   local bridge.

   Two endpoints, used very differently. /history is the ENTIRE ledger and can
   be megabytes, so it is fetched exactly once when the page opens. /flips is
   the poll that already exists for the terminal's sidebar; the only thing this
   page wants from it is `flipCount`, the ledger's true size. When that exceeds
   the `count` that came back with the copy we hold, the copy is stale and gets
   re-fetched. That is the whole staleness mechanism — no polling of /history,
   ever.

   Nothing here touches app.js's own bridge client. This page is standalone
   (no app.js at all), so the constants below are deliberately its own copy. */
(function () {
  'use strict';

  var root = window;
  /* A function, not a constant: the port is a plugin setting and the visitor
     can change the browser's copy of it from the status box below without
     reloading. See bridge-port.js. */
  function bridge(path) {
    return root.PGEBridge ? root.PGEBridge.url(path) : 'http://127.0.0.1:8477' + (path || '');
  }
  var POLL_MS = 5000;
  var PAGE_SIZE = 50;
  /* Under a minute of hold, gp/hr is a division by almost nothing: a 40-second
     flip of 3k profit reads as 270k/hr, which is not a rate anybody can
     sustain or plan around. Blanked rather than shown, same as an unknown
     hold. */
  var MIN_HOLD_MS = 60000;

  var state = {
    flips: [],        // as served: oldest first
    count: null,      // the `count` that came with this copy
    revision: null,   // the plugin's history revision with it, if it sends one
    generatedAt: 0,
    loaded: false,
    sortKey: 'closed',
    sortDir: -1,      // newest first
    page: 0,
    group: true,      // merge partial fills — see groupFills()
    q: '',            // item-name filter
    range: 'all',     // all | 7 | 30 days

    pollTimer: null,
    bank: null,     // the /flips payload — wealth, not the ledger
    portfolio: null,  // [[time, value], ...] oldest first, from /portfolio
    portfolioAt: 0,   // when it was last fetched
    pfRange: 'all',   // 1 | 7 | 30 | 365 days, or all
  };
  /* The plugin samples every 15 minutes, so the poll's every five seconds
     would ask for the same series a hundred and eighty times. */
  var PORTFOLIO_EVERY_MS = 5 * 60000;

  var $ = function (sel) { return document.querySelector(sel); };

  // ── formatting ──────────────────────────────────────────────────────────
  /* Matches abbreviateNumber() in app.js so a number means the same thing on
     both pages. */
  function abbrev(num) {
    if (num == null || isNaN(num)) return '—';
    var neg = num < 0; num = Math.abs(num);
    var out;
    if (num >= 1e9) out = (num / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
    else if (num >= 1e6) out = (num / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
    else if (num >= 1e3) out = (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    else out = Math.round(num).toLocaleString();
    return (neg ? '-' : '') + out;
  }
  function signed(n) { return (n >= 0 ? '+' : '') + abbrev(n); }
  function gp(n) { return n == null ? '—' : Math.round(n).toLocaleString(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function when(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' }) +
           ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function duration(ms) {
    if (ms == null) return '—';
    /* Rounding sent a 30-second hold out as "1m", which reads as longer than
       it was and, next to a blank gp/hr, invites the question "why no rate for
       a whole minute". Sub-minute holds say so. */
    if (ms < 60000) return '<1m';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return rm ? h + 'h ' + rm + 'm' : h + 'h';
    var d = Math.floor(h / 24), rh = h % 24;
    return rh ? d + 'd ' + rh + 'h' : d + 'd';
  }

  // ── derived, and the one rule that is easy to get wrong ─────────────────
  /* openedAt === 0 means the buy time is UNKNOWN, not 1970. Two kinds of flip
     carry it: anything closed before the plugin recorded buy times, and
     anything bought before that and sold after. Subtracting without checking
     would print "held 55 years" — and worse, a 0 would read as "filled
     instantly", the most flattering possible lie about a trade. The plugin
     returns -1 internally rather than a duration for exactly this reason; this
     returns null and every caller below is required to handle it.
     Every OTHER field on such a row — cost, profit, quantity — is real and
     displays normally. */
  function holdMs(f) {
    if (!f.openedAt || f.openedAt <= 0) return null;
    var ms = f.closedAt - f.openedAt;
    return ms > 0 ? ms : null;
  }
  function gpPerHour(f) {
    var ms = holdMs(f);
    if (ms == null || ms < MIN_HOLD_MS) return null;
    return f.profit / (ms / 3600000);
  }
  function roiPct(f) {
    return f.buySpent > 0 ? (f.profit / f.buySpent) * 100 : null;
  }

  // ── loading ─────────────────────────────────────────────────────────────
  function setStatus(kind, html) {
    var el = $('#fhStatus');
    if (!el) return;
    el.className = 'fh-status fh-' + kind;
    el.innerHTML = html;
    el.hidden = false;
  }

  /* Steps, not a sentence: the one thing someone landing here needs is what
     to click, in order. It is off by default, which is the usual reason this
     page finds nothing. */
  var OFFER_HELP =
    'To link it:<ol class="fh-steps">' +
    '<li>In RuneLite, open the <b>PocketGE</b> panel, click the <b>gear</b>, and under ' +
      '<b>Website link</b> switch on <b>Local website bridge</b>.</li>' +
    '<li>Keep RuneLite running and logged in on this computer.</li>' +
    '<li>This page finds it by itself within a few seconds.</li>' +
    '</ol>Then you get every flip, your bank, and your portfolio charted over time. ' +
    'Nothing leaves your computer: this page reads the plugin on 127.0.0.1.';

  /* The second reason, and the one nobody can guess: the plugin's Bridge port
     is a setting with a 1024-65535 range, and this page was hardcoded to the
     default. Anyone who moved it — because something else already had 8477, or
     because they run two clients — had no way to say so. The number goes here,
     next to the failure it explains. */
  function portControl() {
    var port = root.PGEBridge ? root.PGEBridge.get() : 8477;
    return '<div class="fh-port">' +
      '<label for="fhPort">Bridge port</label>' +
      '<input type="number" id="fhPort" min="1024" max="65535" step="1" value="' + port + '" ' +
        'inputmode="numeric" autocomplete="off">' +
      '<button type="button" id="fhPortGo">Connect</button>' +
      '<span class="fh-port-note">Match the <b>Bridge port</b> in the plugin\'s settings. ' +
        'Default is 8477.</span>' +
      '</div>';
  }

  async function loadHistory() {
    try {
      var res = await fetch(bridge('/history'), { cache: 'no-store', mode: 'cors' });
      /* A 404 here with the bridge otherwise answering means the plugin predates
         the release that serves the ledger. Worth saying precisely, because
         "no connection" would send someone to check a setting that is already
         on. */
      if (res.status === 404) {
        setStatus('warn', '<b>Connected, but this plugin version has no history endpoint.</b> ' +
          'Update PocketGE Flip Tracker from the RuneLite Plugin Hub, then reload this page.');
        return false;
      }
      if (!res.ok) throw new Error('bridge ' + res.status);
      var data = await res.json();
      state.flips = Array.isArray(data.flips) ? data.flips : [];
      state.count = typeof data.count === 'number' ? data.count : state.flips.length;
      state.revision = typeof data.revision === 'number' ? data.revision : null;
      state.generatedAt = Number(data.generatedAt) || Date.now();
      if (!state.loaded && !(state.portfolio && state.portfolio.length >= 2)) loadPortfolio();
      state.loaded = true;
      render();
      return true;
    } catch (e) {
      setStatus('off',
        '<b>No RuneLite bridge on this computer.</b> ' + OFFER_HELP +
        ' <a href="/runelite-plugin.html">Full setup steps →</a>' +
        portControl());
      return false;
    }
  }

  /* The portfolio's value over time. Its own endpoint, like /history: a
     year of it is thousands of points and the poll has no use for them. A
     404 is a plugin from before the series existed. */
  /* Whether the plugin has /portfolio at all. An older one answers 404
     with no CORS header, which this page cannot read — the fetch just
     fails — so the plugin says it in /flips instead, and a /flips without
     the flag is a plugin from before the chart. */
  function portfolioUnsupported() {
    return state.bank != null && state.bank.portfolioHistory !== true;
  }

  /* Fetched again in five minutes once there is a line to draw, the
     plugin's own pace. Until then every thirty seconds: the page may be
     opened before RuneLite, or at the login screen, and a chart about to
     start should show up when it does rather than five minutes later. */
  function portfolioRetrySoon() {
    state.portfolioAt = Date.now() - PORTFOLIO_EVERY_MS + 30000;
  }

  async function loadPortfolio() {
    portfolioRetrySoon();
    if (portfolioUnsupported()) { state.portfolio = null; renderPortfolio(); return; }
    try {
      var res = await fetch(bridge('/portfolio'), { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return;
      var data = await res.json();
      state.portfolioRecording = data.recording !== false;
      state.portfolio = Array.isArray(data.points) ? data.points.filter(function (p) {
        return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && p[1] > 0;
      }) : [];
      if (state.portfolio.length >= 2) state.portfolioAt = Date.now();
      renderPortfolio();
      scrollToPortfolio();
    } catch (e) {
      /* The bridge is not there, or is a plugin from before the chart;
         /flips decides which, and the next poll tries again. */
      if (portfolioUnsupported()) renderPortfolio();
    }
  }

  /* Arrived by the plugin's Portfolio value row: take them to it, once —
     but only once it is on screen. The series can land before the ledger
     has shown the page, and a jump to a hidden section goes nowhere. */
  function scrollToPortfolio() {
    if (location.hash !== '#portfolio' || state.pfScrolled) return;
    var live = $('#fhLive'), head = $('#portfolio');
    if (!head || !live || live.hidden || !head.offsetParent) return;
    state.pfScrolled = true;
    head.scrollIntoView({ block: 'start' });
  }

  function pfNote(text) {
    var el = $('#fhPfNote');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* A short word on the canvas when there is no line; the sentence goes in
     the note under it, which wraps — canvas text does not, and a sentence
     drawn across a phone-width chart lost both ends. */
  function portfolioEmpty(g, cssW, cssH, word, note) {
    g.fillStyle = '#8A8274';
    g.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    g.textAlign = 'center';
    g.fillText(word, cssW / 2, cssH / 2);
    pfNote(note);
  }

  function renderPortfolio() {
    var cv = $('#fhPortfolio');
    if (!cv) return;
    var wrap = cv.parentElement;
    var cssW = Math.max(240, wrap.clientWidth);
    var cssH = 220;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    if (portfolioUnsupported()) {
      portfolioEmpty(g, cssW, cssH, 'Not recorded yet',
        'Your PocketGE plugin does not record your portfolio yet — that comes with its next update ' +
        'on the RuneLite Plugin Hub.');
      return;
    }
    var paused = state.portfolioRecording === false
      ? 'Recorded while the plugin\'s Flip advisor is on — it needs live prices. ' : '';
    var all = state.portfolio || [];
    var cutoff = state.pfRange === 'all' ? -Infinity : Date.now() - Number(state.pfRange) * 86400000;
    var pts = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i][0] >= cutoff) pts.push({ t: all[i][0], v: all[i][1] });
    }
    /* Oldest first, whatever order they came in: the first and last points
       are the axis ends. */
    pts.sort(function (a, b) { return a.t - b.t; });
    if (pts.length < 2) {
      if (all.length < 2) {
        portfolioEmpty(g, cssW, cssH, 'No line yet', paused.trim() ||
          'The plugin notes your portfolio every 15 minutes while you play. The line starts at the second.');
      } else {
        portfolioEmpty(g, cssW, cssH, 'Nothing in this range', paused.trim() || 'Nothing recorded in this range yet.');
      }
      return;
    }
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    if (t1 <= t0) t1 = t0 + 1;
    /* Not from zero: a 148M portfolio moving 3M is the story, and an axis
       from nothing would draw it as a flat line along the top. Never below
       zero either, which the padding under a low first point reached. */
    var lo = Infinity, hi = -Infinity;
    for (var j = 0; j < pts.length; j++) { if (pts[j].v < lo) lo = pts[j].v; if (pts[j].v > hi) hi = pts[j].v; }
    var pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    lo = Math.max(0, lo - pad); hi += pad;
    var padL = 52, padR = 8, padT = 10, padB = 20;
    var x = function (t) { return padL + (t - t0) / (t1 - t0) * (cssW - padL - padR); };
    var y = function (v) { return padT + (hi - v) / (hi - lo) * (cssH - padT - padB); };

    g.strokeStyle = 'rgba(217,211,199,0.10)';
    g.fillStyle = '#8A8274';
    g.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    g.textAlign = 'right';
    g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) {
      var vv = lo + (hi - lo) * (k / 4);
      var yy = Math.round(y(vv)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(cssW - padR, yy); g.stroke();
      g.fillText(abbrev(vv), padL - 6, yy + 3);
    }
    /* Gold, the colour the plugin's own Portfolio value row is in. */
    g.beginPath();
    for (var p = 0; p < pts.length; p++) {
      var px = x(pts[p].t), py = y(pts[p].v);
      if (p === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokeStyle = '#E5C158'; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
    g.lineTo(x(pts[pts.length - 1].t), cssH - padB);
    g.lineTo(x(pts[0].t), cssH - padB);
    g.closePath();
    g.fillStyle = 'rgba(229,193,88,0.10)';
    g.fill();
    /* The ends, as dates — or with the time as well when the line covers
       less than two days, where both ends are otherwise the same date. */
    var label = function (t) {
      return t1 - t0 < 2 * 86400000 ? when(t) : when(t).split(' ').slice(0, 3).join(' ');
    };
    g.fillStyle = '#8A8274';
    g.textAlign = 'left';
    g.fillText(label(t0), padL, cssH - 6);
    g.textAlign = 'right';
    g.fillText(label(t1), cssW - padR, cssH - 6);
    /* The change over the range, said in words under the line. */
    var first = pts[0].v, last = pts[pts.length - 1].v, d = last - first;
    var pct = first > 0 ? (d / first) * 100 : 0;
    pfNote(paused + abbrev(last) + ' latest · ' + signed(d) + ' (' + (d >= 0 ? '+' : '') + pct.toFixed(1) +
      '%) over this range');
  }

  /* The poll exists only to notice that the ledger grew. It never fetches the
     ledger itself. */
  async function pollForGrowth() {
    loadBank();
    if (Date.now() - state.portfolioAt >= PORTFOLIO_EVERY_MS) loadPortfolio();
    try {
      var res = await fetch(bridge('/flips'), { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return;
      var data = await res.json();
      var live = Number(data.flipCount);
      if (!isFinite(live)) return;
      /* Grown, or a row corrected in place ("Correct what I paid…" in the
         plugin), which keeps the count and moves the revision on. */
      var rev = Number(data.historyRevision);
      /* A copy with no revision (from a plugin before 0.7.6) counts as stale
         once the plugin reports one, so the first correction after an
         upgrade is not missed. */
      var corrected = isFinite(rev) && rev !== state.revision;
      if (state.loaded && state.count != null && (live > state.count || corrected)) {
        loadHistory();
      } else if (!state.loaded) {
        loadHistory();      // bridge came back after a failed first load
      }
    } catch (e) { /* bridge gone; the page keeps what it has */ }
  }

  // ── summary ─────────────────────────────────────────────────────────────
  function summarise(flips) {
    var profit = 0, tax = 0, spent = 0, timedProfit = 0, timedHours = 0, timed = 0;
    for (var i = 0; i < flips.length; i++) {
      var f = flips[i];
      profit += f.profit; tax += f.tax; spent += f.buySpent;
      var ms = holdMs(f);
      /* Averages are over the rows that actually carry a buy time. Including
         the unknowns as zero-length would inflate every rate on the page. */
      if (ms != null && ms >= MIN_HOLD_MS) {
        timed++; timedProfit += f.profit; timedHours += ms / 3600000;
      }
    }
    return {
      flips: flips.length,
      profit: profit,
      tax: tax,
      roi: spent > 0 ? (profit / spent) * 100 : null,
      /* Time-weighted, not the mean of each row's rate: a 30-second flip and a
         three-day hold are not two equal samples of "gp per hour". Total profit
         over total slot-hours is the number that answers "what is an hour of
         slot time worth to me". */
      perSlotHour: timedHours > 0 ? timedProfit / timedHours : null,
      timed: timed,
      untimed: flips.length - timed,
    };
  }

  function renderSummary() {
    /* Over GROUPED flips, like the highlights below and the table above.
       This was the last thing on the page still counting raw fills, and it
       was the headline: a sale of 18,000 that the Exchange settled in
       eighteen chunks read "Flips 18" beside a highlight saying "6 of 6
       flips in the green". Reported as "website is tracking every sell, some
       sold in batches of like 1000 of 18000 and it counted that 18 times".

       Money is unaffected — profit, tax and spend are sums either way. What
       changes is every figure with a COUNT under it: the flip count itself,
       and per-slot-hour, whose denominator was summing each fragment's hold
       as if the fragments had occupied a slot each. */
    var s = summarise(groupFills(state.flips));
    var tile = function (label, val, cls, note) {
      return '<div class="fh-stat' + (cls ? ' ' + cls : '') + '">' +
             '<div class="fh-stat-label">' + label + '</div>' +
             '<div class="fh-stat-val">' + val + '</div>' +
             (note ? '<div class="fh-stat-note">' + note + '</div>' : '') + '</div>';
    };
    var out = '';
    out += tile('Lifetime profit', signed(s.profit) + ' gp',
                s.profit >= 0 ? 'pos' : 'neg', 'after the 2% GE tax');
    out += tile('Flips', s.flips.toLocaleString(), '', 'completed and booked');
    out += tile('Tax paid', abbrev(s.tax) + ' gp', '', 'already deducted above');
    out += tile('Return', s.roi == null ? '—' : s.roi.toFixed(1) + '%',
                s.roi != null && s.roi < 0 ? 'neg' : '', 'profit against gp spent');
    out += tile('Per slot-hour', s.perSlotHour == null ? '—' : signed(s.perSlotHour) + ' gp',
                s.perSlotHour != null && s.perSlotHour < 0 ? 'neg' : 'pos',
                s.timed ? 'across ' + s.timed.toLocaleString() + ' timed ' +
                          (s.timed === 1 ? 'flip' : 'flips')
                        : 'no timed flips yet');
    $('#fhStats').innerHTML = out;

    /* Sparse hold data is the NORMAL early state, not a fault: buy times only
       start being recorded from the release that added them, so a long-standing
       player's ledger is mostly unknowns at first. Said plainly, once, rather
       than leaving someone to wonder why a column is full of dashes. */
    var note = $('#fhSparse');
    if (s.untimed > 0 && s.flips > 0) {
      note.innerHTML = '<b>' + s.untimed.toLocaleString() + '</b> of ' +
        s.flips.toLocaleString() + ' flips were booked without a buy time, so their ' +
        'hold and gp/hr are shown as <b>—</b> and left out of the averages. ' +
        'Buy times are only recorded from newer plugin releases, so this thins out ' +
        'as you keep flipping.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // ── highlights ──────────────────────────────────────────────────────────
  /* The totals above say how much. These say what happened — the single flip
     that went best, the day that went best, the item carrying the account.
     Every one of them is derived from the ledger already on this page: no
     upload, no account, no comparison to anybody else.

     Deliberately NOT here: any ranking against other players. That needs a
     population this page does not have and by design never will, and the
     ledger it would rank is a file on the player's own machine that anyone can
     edit — a leaderboard of unverifiable self-reported gp ranks whoever is
     most willing to type a big number. Measured against your own history,
     every figure below is exactly as true as the ledger is. */
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function shortDay(ms) {
    var d = new Date(ms);
    return isNaN(d.getTime()) ? '—'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function plural(n, word) {
    return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's');
  }

  function highlights(raw) {
    /* Over GROUPED flips, not raw fills. The Grand Exchange splitting one
       offer into six rows would otherwise hand "best flip" to whichever
       fragment happened to be biggest, and count one decision six times in
       the win rate. */
    var flips = groupFills(raw);
    if (!flips.length) return [];

    var best = null, byDay = {}, byItem = {}, green = 0;
    flips.forEach(function (f) {
      if (!best || f.profit > best.profit) best = f;
      if (f.profit > 0) green++;
      var dk = dayKey(f.closedAt);
      byDay[dk] = byDay[dk] || { at: f.closedAt, profit: 0, n: 0 };
      byDay[dk].profit += f.profit; byDay[dk].n++;
      var ik = f.itemName || '—';
      byItem[ik] = byItem[ik] || { profit: 0, n: 0 };
      byItem[ik].profit += f.profit; byItem[ik].n++;
    });

    var topDay = Object.keys(byDay).map(function (k) { return byDay[k]; })
      .sort(function (a, b) { return b.profit - a.profit; })[0];
    var topName = Object.keys(byItem).sort(function (a, b) {
      return byItem[b].profit - byItem[a].profit;
    })[0];
    var topItem = byItem[topName];

    /* The streak walks BACKWARDS from the most recent close, because "current"
       means the run you are on and that is the one worth posting. When the last
       flip was a loss there is no current run, so it falls back to the best run
       ever rather than showing a zero. */
    var order = flips.slice().sort(function (a, b) { return a.closedAt - b.closedAt; });
    var cur = 0;
    for (var i = order.length - 1; i >= 0 && order[i].profit > 0; i--) cur++;
    var bestRun = 0, run = 0;
    order.forEach(function (f) {
      run = f.profit > 0 ? run + 1 : 0;
      if (run > bestRun) bestRun = run;
    });

    return [
      { label: 'Best flip', value: signed(best.profit) + ' gp', pos: best.profit >= 0,
        note: esc(best.itemName || '—') + ' · ' + shortDay(best.closedAt) },
      { label: 'Best day', value: signed(topDay.profit) + ' gp', pos: topDay.profit >= 0,
        note: shortDay(topDay.at) + ' · ' + plural(topDay.n, 'flip') },
      { label: 'Top earner', value: signed(topItem.profit) + ' gp', pos: topItem.profit >= 0,
        note: esc(topName) + ' · ' + plural(topItem.n, 'flip') },
      { label: 'Win rate', value: Math.round((green / flips.length) * 100) + '%',
        note: green.toLocaleString() + ' of ' + plural(flips.length, 'flip') + ' in the green' },
      /* Three states, not two. "0 flips — best run so far" was what fell out of
         treating this as one number with a caption, and it reads as a taunt;
         a ledger with no green flip in it has no streak to report. */
      cur ? { label: 'Green streak', value: plural(cur, 'flip'), pos: true, note: 'running now' }
        : bestRun ? { label: 'Green streak', value: plural(bestRun, 'flip'), pos: true,
          note: 'best run so far' }
          : { label: 'Green streak', value: '—', note: 'no green run yet' },
    ];
  }

  function renderHighlights() {
    var el = $('#fhKeys');
    if (!el) return;
    var rows = highlights(state.flips);
    if (!rows.length) { el.hidden = true; return; }
    el.innerHTML = rows.map(function (r) {
      return '<div class="fh-key">' +
        '<div class="fh-key-label">' + r.label + '</div>' +
        '<div class="fh-key-val' + (r.pos === true ? ' pos' : r.pos === false ? ' neg' : '') +
          '">' + r.value + '</div>' +
        '<div class="fh-key-note">' + r.note + '</div>' +
        '</div>';
    }).join('');
    el.hidden = false;
  }

  // ── cumulative profit ───────────────────────────────────────────────────
  // ── bank ────────────────────────────────────────────────────────────────
  /* The ledger answers "what have I made"; this answers "what am I holding".
     They were split across two surfaces — the Bank of Gielinor modal in the
     app and this page — so seeing both meant leaving one of them. Both come
     off the same bridge, so this page can simply ask for the other half.

     A separate endpoint from /history: /flips is the light poll payload
     (wealth, the recent window, flipCount) while /history is the whole
     append-only ledger. Wealth changes constantly and the ledger only when a
     flip closes, which is why they are fetched differently. */
  async function loadBank() {
    try {
      var res = await fetch(bridge('/flips'), { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return;
      var d = await res.json();
      var wasUnsupported = portfolioUnsupported();
      state.bank = d && typeof d === 'object' ? d : null;
      renderBank();
      /* The chart's own fetch learns of a plugin from before it only on its
         next try; /flips knows now. */
      if (portfolioUnsupported() !== wasUnsupported) loadPortfolio();
    } catch (e) { /* no bridge: the section simply stays hidden */ }
  }

  function renderBank() {
    var el = $('#fhBank');
    if (!el) return;
    var d = state.bank;
    var hasWealth = d && (Number(d.portfolioValue) > 0 || Number(d.cash) > 0);
    /* An empty tab is worse than no tab, but hiding it was worse still: with
       nothing here, the only route to Bank of Gielinor was a small link in the
       top bar that people did not find. So the empty state says why it is
       empty and still carries the link. */
    if (!hasWealth) {
      el.innerHTML = '<div class="fh-sparse" style="display:block">Nothing to show yet — the plugin ' +
        'reads your wealth from the game, so log in with RuneLite running and this fills in.</div>' +
        bankLink();
      return;
    }

    var stacks = Array.isArray(d.bankStacks) ? d.bankStacks.slice() : [];
    stacks.sort(function (a, b) { return (b.value || 0) - (a.value || 0); });

    var tile = function (label, val, note, cls) {
      return '<div class="fh-stat' + (cls ? ' ' + cls : '') + '">' +
             '<div class="fh-stat-label">' + label + '</div>' +
             '<div class="fh-stat-val">' + val + '</div>' +
             (note ? '<div class="fh-stat-note">' + note + '</div>' : '') + '</div>';
    };

    var html = '<div class="fh-stats">' +
      tile('Portfolio', abbrev(d.portfolioValue) + ' gp', 'cash + bank + inventory + worn + open offers') +
      tile('Liquid cash', abbrev(d.cash) + ' gp', 'coins + platinum tokens') +
      tile('Lifetime profit', signed(d.lifetimeProfit) + ' gp',
           'every flip the plugin has booked', Number(d.lifetimeProfit) >= 0 ? 'pos' : 'neg') +
      '</div>';

    /* The bank total only refreshes when the bank is opened in game, so a
       figure from hours ago is normal and needs saying rather than hiding —
       otherwise "Portfolio" reads as live when it is not. */
    if (d.bankSeen && d.bankSeenAt) {
      html += '<div class="fh-sparse" style="display:block">Bank last read <b>' +
        duration(Date.now() - Number(d.bankSeenAt)) +
        '</b> ago — open your bank in game to refresh the portfolio figure.</div>';
    } else if (!d.bankSeen) {
      html += '<div class="fh-sparse" style="display:block">The plugin has not seen your bank yet, so ' +
        '<b>Portfolio</b> counts only what it can see — inventory, worn items, open offers and coins. ' +
        'Open your bank in game once and it will fill in.</div>';
    }

    if (stacks.length) {
      html += '<h3 class="fh-bank-h">Biggest stacks</h3><div class="fh-stacks">' +
        stacks.slice(0, 10).map(function (st) {
          return '<div class="fh-stack"><span class="fh-stack-n">' + esc(st.name) +
            '<span class="fh-dim"> \u00d7' + Number(st.quantity || 0).toLocaleString() + '</span></span>' +
            '<span class="fh-stack-v">' + abbrev(st.value) + ' gp</span></div>';
        }).join('') +
        (stacks.length > 10 ? '<div class="fh-dim fh-stack-more">+ ' +
          (stacks.length - 10).toLocaleString() + ' more stacks</div>' : '') +
        '</div>';
    }

    html += bankLink();

    el.innerHTML = html;
  }

  /* One definition, used by both the populated and the empty state, so the way
     into Bank of Gielinor cannot go missing from whichever branch runs. */
  function bankLink() {
    return '<p class="fh-bank-link"><a class="fh-bank-cta" href="/#bank">Open Bank of Gielinor →</a>' +
      '<span>add your own stacks, set alerts, see live values</span></p>';
  }

  /* Tabs. The canvas sizes itself from its wrapper's clientWidth, which is 0
     while the panel is hidden, so the chart is redrawn on the way back in
     rather than left at whatever width it last saw. */
  function mountTabs() {
    var tabs = [['tabProfit', 'panelProfit'], ['tabBank', 'panelBank'], ['tabFlips', 'panelFlips']];
    tabs.forEach(function (pair) {
      var btn = $('#' + pair[0]);
      if (!btn) return;
      btn.onclick = function () {
        tabs.forEach(function (o) {
          var b = $('#' + o[0]), p = $('#' + o[1]);
          var on = o[0] === pair[0];
          if (b) { b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); }
          if (p) p.hidden = !on;
        });
        if (pair[0] === 'tabProfit') { renderChart(); renderPortfolio(); }
      };
    });
  }

  function renderChart() {
    var cv = $('#fhChart');
    if (!cv) return;
    var flips = state.flips;
    var wrap = cv.parentElement;
    var cssW = Math.max(240, wrap.clientWidth);
    var cssH = 220;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    if (flips.length < 2) {
      g.fillStyle = '#8A8274';
      g.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      g.textAlign = 'center';
      g.fillText(flips.length ? 'One flip so far — the curve starts at two.'
                              : 'No flips yet.', cssW / 2, cssH / 2);
      return;
    }
    /* The ledger arrives oldest first, which is already the order a cumulative
       curve wants. Sorting the table must not disturb this, so the running sum
       is built from state.flips rather than from the sorted view. */
    var pts = [], run = 0;
    for (var i = 0; i < flips.length; i++) {
      run += flips[i].profit;
      pts.push({ t: flips[i].closedAt, v: run });
    }
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    if (t1 <= t0) t1 = t0 + 1;
    var lo = 0, hi = 0;
    for (var j = 0; j < pts.length; j++) { if (pts[j].v < lo) lo = pts[j].v; if (pts[j].v > hi) hi = pts[j].v; }
    if (hi === lo) { hi = lo + 1; }
    var padL = 52, padR = 8, padT = 10, padB = 20;
    var x = function (t) { return padL + (t - t0) / (t1 - t0) * (cssW - padL - padR); };
    var y = function (v) { return padT + (hi - v) / (hi - lo) * (cssH - padT - padB); };

    // gridlines + y labels
    g.strokeStyle = 'rgba(217,211,199,0.10)';
    g.fillStyle = '#8A8274';
    g.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    g.textAlign = 'right';
    g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) {
      var vv = lo + (hi - lo) * (k / 4);
      var yy = Math.round(y(vv)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(cssW - padR, yy); g.stroke();
      g.fillText(abbrev(vv), padL - 6, yy + 3);
    }
    // the zero line, when the curve has been under water
    if (lo < 0 && hi > 0) {
      g.strokeStyle = 'rgba(217,211,199,0.28)';
      var zy = Math.round(y(0)) + 0.5;
      g.beginPath(); g.moveTo(padL, zy); g.lineTo(cssW - padR, zy); g.stroke();
    }
    // the curve
    var end = pts[pts.length - 1].v;
    var col = end >= 0 ? '#1FB85C' : '#EF5350';
    g.beginPath();
    for (var p = 0; p < pts.length; p++) {
      var px = x(pts[p].t), py = y(pts[p].v);
      if (p === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokeStyle = col; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
    // fill under it
    g.lineTo(x(pts[pts.length - 1].t), y(Math.max(lo, Math.min(hi, 0))));
    g.lineTo(x(pts[0].t), y(Math.max(lo, Math.min(hi, 0))));
    g.closePath();
    g.fillStyle = end >= 0 ? 'rgba(31,184,92,0.12)' : 'rgba(239,83,80,0.12)';
    g.fill();
    // x labels
    g.fillStyle = '#8A8274';
    g.textAlign = 'left';
    g.fillText(when(t0).split(' ').slice(0, 3).join(' '), padL, cssH - 6);
    g.textAlign = 'right';
    g.fillText(when(t1).split(' ').slice(0, 3).join(' '), cssW - padR, cssH - 6);
  }

  // ── grouping ────────────────────────────────────────────────────────────
  /* Shared with the Bank of Gielinor panel in the app — see flip-group.js for
     the rule and why it lives in its own file. Falls back to no grouping if
     that script did not load, rather than throwing and blanking the table. */
  function groupFills(flips) {
    return (root.PGEFlipGroup && root.PGEFlipGroup.groupFills)
      ? root.PGEFlipGroup.groupFills(flips)
      : flips.slice();
  }

  /* Filter BEFORE grouping, so a narrowed view never merges rows it is not
     showing, and sort last. */
  function visibleRows() {
    var rows = state.flips;
    if (state.range !== 'all') {
      var cutoff = Date.now() - Number(state.range) * 86400000;
      rows = rows.filter(function (f) { return f.closedAt >= cutoff; });
    }
    var q = state.q.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (f) {
        return String(f.itemName || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    /* The caption compares grouped rows against the fills they came from, so
       it needs the count AFTER filtering, not the size of the whole ledger:
       filtering to one item was reporting "2 flips from 7 fills" when five of
       those seven fills were a different item entirely. */
    state.fills = rows.length;
    if (state.group) rows = groupFills(rows);
    return rows;
  }

  // ── table ───────────────────────────────────────────────────────────────
  var COLS = [
    { key: 'item',  label: 'Item',   align: 'left' },
    { key: 'closed', label: 'Closed', align: 'left' },
    { key: 'qty',   label: 'Qty' },
    { key: 'bought', label: 'Bought' },
    { key: 'sold',  label: 'Sold' },
    { key: 'value', label: 'Value' },
    { key: 'tax',   label: 'Tax' },
    { key: 'profit', label: 'Profit' },
    { key: 'roi',   label: 'ROI' },
    { key: 'held',  label: 'Held' },
    { key: 'gphr',  label: 'gp/hr' },
  ];

  function valueOf(f, key) {
    switch (key) {
      case 'item': return String(f.itemName || '').toLowerCase();
      case 'closed': return f.closedAt;
      case 'qty': return f.quantity;
      case 'bought': return f.quantity > 0 ? f.buySpent / f.quantity : 0;
      case 'sold': return f.quantity > 0 ? f.sellGross / f.quantity : 0;
      case 'value': return f.sellGross;
      case 'tax': return f.tax;
      case 'profit': return f.profit;
      case 'roi': return roiPct(f);
      case 'held': return holdMs(f);
      case 'gphr': return gpPerHour(f);
    }
    return 0;
  }

  function sorted() {
    var key = state.sortKey, dir = state.sortDir;
    var copy = visibleRows().slice();
    copy.sort(function (a, b) {
      var av = valueOf(a, key), bv = valueOf(b, key);
      /* Unknowns sink to the bottom in BOTH directions. Sorting by gp/hr is the
         point of this table; letting a wall of blanks take the top half of it
         because they compare as null would defeat that. */
      if (av == null && bv == null) return b.closedAt - a.closedAt;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return b.closedAt - a.closedAt;
    });
    return copy;
  }

  function renderTable() {
    var rows = sorted();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    var start = state.page * PAGE_SIZE;
    var slice = rows.slice(start, start + PAGE_SIZE);

    var head = '<tr>' + COLS.map(function (c) {
      var on = state.sortKey === c.key;
      return '<th class="' + (c.align === 'left' ? 'l' : '') + (on ? ' sorted' : '') +
        '" data-key="' + c.key + '" tabindex="0" role="button" ' +
        'aria-sort="' + (on ? (state.sortDir === 1 ? 'ascending' : 'descending') : 'none') + '">' +
        c.label + (on ? '<span class="fh-arrow">' + (state.sortDir === 1 ? '▲' : '▼') + '</span>' : '') +
        '</th>';
    }).join('') + '</tr>';

    var body = slice.map(function (f) {
      var ms = holdMs(f);
      var rate = gpPerHour(f);
      var r = roiPct(f);
      var pcls = f.profit > 0 ? 'pos' : (f.profit < 0 ? 'neg' : '');
      return '<tr>' +
        '<td class="l fh-item"><img src="https://static.runelite.net/cache/item/icon/' +
          encodeURIComponent(f.itemId) + '.png" alt="" loading="lazy" width="20" height="20">' +
          '<span>' + esc(f.itemName) + '</span>' +
          (f.parts > 1 ? '<span class="fh-parts" title="' + f.parts +
            ' partial fills merged into this row">\u00d7' + f.parts + '</span>' : '') +
          '</td>' +
        '<td class="l fh-dim">' + when(f.closedAt) + '</td>' +
        '<td>' + Number(f.quantity || 0).toLocaleString() + '</td>' +
        '<td>' + gp(f.quantity > 0 ? f.buySpent / f.quantity : null) + '</td>' +
        '<td>' + gp(f.quantity > 0 ? f.sellGross / f.quantity : null) + '</td>' +
        '<td>' + abbrev(f.sellGross) + '</td>' +
        '<td class="fh-dim">' + abbrev(f.tax) + '</td>' +
        '<td class="' + pcls + '">' + signed(f.profit) + '</td>' +
        '<td class="' + (r != null && r < 0 ? 'neg' : '') + '">' +
          (r == null ? '—' : r.toFixed(1) + '%') + '</td>' +
        '<td class="' + (ms == null ? 'fh-dim' : '') + '">' + duration(ms) + '</td>' +
        '<td class="' + (rate == null ? 'fh-dim' : (rate < 0 ? 'neg' : 'pos')) + '">' +
          (rate == null ? '—' : signed(rate)) + '</td>' +
        '</tr>';
    }).join('');

    $('#fhHead').innerHTML = head;
    $('#fhBody').innerHTML = body ||
      '<tr><td class="l fh-dim" colspan="' + COLS.length + '">No flips to show.</td></tr>';

    var fills = state.fills != null ? state.fills : state.flips.length;
    var cap = $('#fhCount');
    if (cap) {
      var flipWord = rows.length === 1 ? ' flip' : ' flips';
      cap.textContent = rows.length === fills
        ? rows.length.toLocaleString() + flipWord
        : rows.length.toLocaleString() + flipWord + ' from ' + fills.toLocaleString() +
          (fills === 1 ? ' fill' : ' fills');
    }

    $('#fhPager').innerHTML = rows.length > PAGE_SIZE
      ? '<button type="button" id="fhPrev"' + (state.page === 0 ? ' disabled' : '') + '>← Newer</button>' +
        '<span>' + (start + 1).toLocaleString() + '–' +
          Math.min(start + PAGE_SIZE, rows.length).toLocaleString() +
          ' of ' + rows.length.toLocaleString() + '</span>' +
        '<button type="button" id="fhNext"' + (state.page >= pages - 1 ? ' disabled' : '') + '>Older →</button>'
      : '';
  }

  function render() {
    $('#fhLive').hidden = false;
    setStatus('ok', 'Connected to RuneLite · <b>' + state.flips.length.toLocaleString() +
      '</b> flips in the ledger · read ' + when(state.generatedAt));
    renderSummary();
    renderHighlights();
    renderBank();
    renderChart();
    renderPortfolio();
    renderTable();
    scrollToPortfolio();
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  function init() {
    document.addEventListener('click', function (e) {
      var th = e.target.closest && e.target.closest('#fhHead th[data-key]');
      if (th) {
        var key = th.getAttribute('data-key');
        if (state.sortKey === key) state.sortDir = -state.sortDir;
        else { state.sortKey = key; state.sortDir = (key === 'item') ? 1 : -1; }
        state.page = 0;
        renderTable();
        return;
      }
      if (e.target.id === 'fhPrev') { state.page = Math.max(0, state.page - 1); renderTable(); }
      if (e.target.id === 'fhNext') { state.page += 1; renderTable(); }
      if (e.target.id === 'fhGroup') { state.group = e.target.checked; state.page = 0; renderTable(); }
      if (e.target.id === 'fhPortGo') {
        var input = $('#fhPort');
        /* set() returns what was actually stored, so an out-of-range number is
           corrected in the box rather than left sitting there looking accepted. */
        var saved = root.PGEBridge ? root.PGEBridge.set(input.value) : null;
        if (saved != null) input.value = saved;
        setStatus('wait', 'Looking for RuneLite on 127.0.0.1:' + saved + '…');
        loadBank();
        loadPortfolio();
        loadHistory();
      }
    });
    /* Enter in the port box means the same as pressing Connect. */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'fhPort') {
        e.preventDefault();
        var go = $('#fhPortGo');
        if (go) go.click();
      }
    });
    var fq = $('#fhQuery');
    if (fq) fq.addEventListener('input', function () {
      state.q = fq.value; state.page = 0; renderTable();
    });
    var fr = $('#fhRange');
    if (fr) fr.addEventListener('change', function () {
      state.range = fr.value; state.page = 0; renderTable();
    });
    var pr = $('#fhPfRange');
    if (pr) pr.addEventListener('change', function () {
      state.pfRange = pr.value; renderPortfolio();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches &&
          e.target.matches('#fhHead th[data-key]')) {
        e.preventDefault(); e.target.click();
      }
    });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(function () {
        /* Both, whenever the page is up: renderPortfolio pins its canvas to
           a pixel width, and one left at the old width scrolls sideways. */
        if (state.loaded) { renderChart(); renderPortfolio(); }
      }, 150);
    });

    mountTabs();
    setStatus('wait', 'Looking for RuneLite on this computer…');
    loadBank();
    loadPortfolio();
    loadHistory().then(function () {
      /* Polls regardless of whether the first load worked: the client may not
         be running yet, and this is also how the page notices a ledger that
         grew while it sat open. */
      state.pollTimer = setInterval(pollForGrowth, POLL_MS);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
