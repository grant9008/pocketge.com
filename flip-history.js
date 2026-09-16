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
  var BRIDGE = 'http://127.0.0.1:8477';
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
  };

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

  var OFFER_HELP =
    'In RuneLite, open the <b>PocketGE Flip Tracker</b> settings and switch on ' +
    '<b>Local website bridge</b>. It is off by default, which is the usual reason ' +
    'this page finds nothing.';

  async function loadHistory() {
    try {
      var res = await fetch(BRIDGE + '/history', { cache: 'no-store', mode: 'cors' });
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
      state.generatedAt = Number(data.generatedAt) || Date.now();
      state.loaded = true;
      render();
      return true;
    } catch (e) {
      setStatus('off',
        '<b>No RuneLite bridge on this computer.</b> ' + OFFER_HELP +
        ' <a href="/runelite-plugin.html">How to install the plugin →</a>');
      return false;
    }
  }

  /* The poll exists only to notice that the ledger grew. It never fetches the
     ledger itself. */
  async function pollForGrowth() {
    loadBank();
    try {
      var res = await fetch(BRIDGE + '/flips', { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return;
      var data = await res.json();
      var live = Number(data.flipCount);
      if (!isFinite(live)) return;
      if (state.loaded && state.count != null && live > state.count) {
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
    var s = summarise(state.flips);
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
      var res = await fetch(BRIDGE + '/flips', { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return;
      var d = await res.json();
      state.bank = d && typeof d === 'object' ? d : null;
      renderBank();
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
        if (pair[0] === 'tabProfit') renderChart();
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
    renderTable();
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
    });
    var fq = $('#fhQuery');
    if (fq) fq.addEventListener('input', function () {
      state.q = fq.value; state.page = 0; renderTable();
    });
    var fr = $('#fhRange');
    if (fr) fr.addEventListener('change', function () {
      state.range = fr.value; state.page = 0; renderTable();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches &&
          e.target.matches('#fhHead th[data-key]')) {
        e.preventDefault(); e.target.click();
      }
    });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(function () { if (state.loaded) renderChart(); }, 150);
    });

    mountTabs();
    setStatus('wait', 'Looking for RuneLite on this computer…');
    loadBank();
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
