/* Merging partial fills, shared by the flip history page and the Bank of
   Gielinor panel in the app.

   The Grand Exchange settles a large offer in pieces and the plugin books each
   piece as its own flip. One 8,218-bar trade arrives as five rows reading 549,
   2, 8, 7,558 and 15 — quantities that describe how the GE happened to fill the
   offer, not the trade that was made.

   This lives in its own file because both surfaces show the same ledger and
   were telling different stories about it: the history page merged the fills
   while the Bank's "Recent flips" listed them raw, so the same afternoon read
   as one row in one place and five in the other. Two copies of this rule would
   drift the moment either was tuned.

   Merged only when all three hold: same item, identical unit prices both sides,
   and closed within GROUP_WINDOW_MS of the running group. The price test keeps
   genuinely separate trades apart; the window separates a re-entry at the same
   price later in the day. Two Wine of Zamorak flips at 925 -> 972 sitting 3h22m
   apart stay two rows, which is correct — they were two decisions.

   Presentation only. Profit, quantity and tax are summed exactly; nothing is
   invented and nothing is dropped. */
(function (root) {
  'use strict';

  var GROUP_WINDOW_MS = 15 * 60 * 1000;

  function groupFills(flips, windowMs) {
    var win = windowMs == null ? GROUP_WINDOW_MS : windowMs;
    if (!flips || !flips.length) return [];
    var byTime = flips.slice().sort(function (a, b) { return a.closedAt - b.closedAt; });
    var open = {}, out = [];
    byTime.forEach(function (f) {
      var q = f.quantity > 0 ? f.quantity : 0;
      var buyU = q ? Math.round(f.buySpent / q) : 0;
      var sellU = q ? Math.round(f.sellGross / q) : 0;
      var key = f.itemId + '|' + buyU + '|' + sellU;
      var g = open[key];
      if (g && f.closedAt - g.closedAt <= win) {
        g.quantity += f.quantity; g.buySpent += f.buySpent;
        g.sellGross += f.sellGross; g.tax += f.tax; g.profit += f.profit;
        g.closedAt = Math.max(g.closedAt, f.closedAt);
        /* One part with no buy time makes the whole group's hold unknown. The
           earliest KNOWN time would understate the hold rather than estimate
           it, and a wrong duration is worse than an honest blank. */
        if (!f.openedAt || f.openedAt <= 0) g.openedAt = 0;
        else if (g.openedAt > 0) g.openedAt = Math.min(g.openedAt, f.openedAt);
        g.parts += 1;
        return;
      }
      g = { itemId: f.itemId, itemName: f.itemName, quantity: f.quantity,
            buySpent: f.buySpent, sellGross: f.sellGross, tax: f.tax,
            profit: f.profit, openedAt: f.openedAt, closedAt: f.closedAt, parts: 1 };
      open[key] = g;
      out.push(g);
    });
    return out;
  }

  root.PGEFlipGroup = { groupFills: groupFills, WINDOW_MS: GROUP_WINDOW_MS };
})(typeof window !== 'undefined' ? window : this);
