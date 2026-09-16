/* The port the RuneLite plugin's local bridge is listening on.
 *
 * It was hardcoded to 8477 in two places — app.js for the Bank of Gielinor
 * panel and flip-history.js for the ledger — which is fine until someone
 * changes it. The plugin exposes "Bridge port" as a real setting with a
 * 1024-65535 range, so anyone who already had something on 8477, or who runs
 * two clients, could set a port the website had no way of ever finding. The
 * instructions on /runelite-plugin.html tell people to match the two numbers;
 * this is the half of that which lives in the browser.
 *
 * Loaded by index.html and flip-history.html ahead of their own scripts, the
 * same way flip-group.js is shared, so the two cannot drift.
 *
 * Stored per browser in localStorage and never sent anywhere. Reads are
 * defensive: private mode and blocked site data both throw on access rather
 * than returning null, and the bridge should still work on the default port
 * for someone who never changed it. */
(function (root) {
  'use strict';
  var KEY = 'ge_bridge_port';
  var DEFAULT_PORT = 8477;

  /* Clamped to the same range the plugin's @Range allows. A stored value
     outside it cannot be what the plugin is on, so the default is a better
     guess than honouring it. */
  function valid(n) {
    return Number.isInteger(n) && n >= 1024 && n <= 65535;
  }

  function get() {
    try {
      var n = parseInt(localStorage.getItem(KEY), 10);
      return valid(n) ? n : DEFAULT_PORT;
    } catch (e) {
      return DEFAULT_PORT;
    }
  }

  /* Returns what was actually stored, so a caller can show the corrected
     value rather than leaving a rejected number sitting in its input. */
  function set(port) {
    var n = parseInt(port, 10);
    if (!valid(n)) return get();
    try {
      if (n === DEFAULT_PORT) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(n));
    } catch (e) { /* unwritable storage: this session still uses n below */ }
    return n;
  }

  /* 127.0.0.1 rather than localhost, deliberately: localhost can resolve to
     ::1 first, and the plugin binds IPv4 only. */
  function url(path) {
    return 'http://127.0.0.1:' + get() + (path || '');
  }

  root.PGEBridge = { get: get, set: set, url: url, DEFAULT_PORT: DEFAULT_PORT, KEY: KEY };
})(typeof window !== 'undefined' ? window : this);
