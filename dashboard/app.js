// Token Launch Radar dashboard: renders window.RADAR (written beside this page as ../data.js by
// main.ts), with a sortable, filterable board and a per-protocol detail view. No network, no imports.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;
  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUSD(v) {
    if (v == null) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v;
  }
  function fmtFull(v) { return v == null ? '—' : '$' + v.toLocaleString('en-US'); }
  function fmtPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function fmtAge(d) { return d == null ? '—' : d.toLocaleString('en-US') + 'd'; }
  function fmtX(v) { return v == null ? '—' : v.toFixed(4); }

  // Header, stats, model note, source line.
  $('m-version').textContent = R.model_version;
  $('m-asof').textContent = R.as_of;
  $('m-floor').textContent = fmtUSD(R.floor_usd);
  $('s-protocols').textContent = R.stats.protocols.toLocaleString('en-US');
  $('s-rows').textContent = R.stats.board_rows.toLocaleString('en-US');
  $('s-watch').textContent = R.stats.watchlist_rows + ' / ' + R.stats.board_rows;
  $('s-tvl').textContent = fmtUSD(R.stats.board_tvl_usd);
  $('s-mult').textContent = fmtX(R.stats.median_multiple);
  $('source').textContent = 'Snapshot: ' + R.source + ' · as of ' + R.as_of;
  var M = R.model;
  $('modeltext').textContent =
    'Implied value = TVL x category multiple x momentum x maturity x multichain. The category multiple is the median ' +
    'market-cap/TVL of the token-bearing protocols in the same DefiLlama category (each ratio clamped to [' +
    M.ratio_floor + ', ' + M.ratio_cap + ']), shrunk toward the global median of ' + fmtX(M.global_multiple) +
    ' with a pseudo-count of ' + M.shrink_weight + ', so thin categories borrow the market-wide figure. Momentum = 1 + clamp(7d TVL change, ' +
    M.momentum_floor + '%, +' + M.momentum_cap + '%) x ' + M.momentum_weight + '. Maturity = ' + M.maturity_base + ' + ' + M.maturity_span +
    ' x min(age, ' + M.maturity_days + ' days)/' + M.maturity_days + '. Multichain = 1 + ' + M.multichain_step +
    ' per extra chain beyond the first, up to ' + M.multichain_max_extra + '. A protocol enters the board when it records no token ' +
    '(no CoinGecko id, no symbol) and is not a wrapped, staked or bridged product of one that trades; every watchlist protocol is boarded.';

  // Filter controls.
  var catSel = $('cat'), chainSel = $('chain');
  function fillSelect(sel, values, allLabel) {
    var o = document.createElement('option');
    o.value = ''; o.textContent = allLabel; sel.appendChild(o);
    values.forEach(function (v) {
      var op = document.createElement('option');
      op.value = v; op.textContent = v; sel.appendChild(op);
    });
  }
  fillSelect(catSel, R.stats.categories, 'All categories');
  fillSelect(chainSel, R.stats.chains, 'All chains');

  var state = { q: '', cat: '', chain: '', wl: false, mintvl: 0, sort: 'rank', dir: 1, selected: null };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      if (state.cat && (r.category || 'Uncategorised') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.wl && !r.watchlist) return false;
      if (state.mintvl > 0 && r.tvl_usd < state.mintvl) return false;
      return true;
    });
  }
  var KEY = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    chg: function (r) { return r.change_7d == null ? -Infinity : r.change_7d; },
    val: function (r) { return r.implied_value_usd; },
    mult: function (r) { return r.model.category_multiple; },
    age: function (r) { return r.age_days == null ? -1 : r.age_days; }
  };
  function sorted(list) {
    var k = KEY[state.sort], d = state.dir;
    return list.slice().sort(function (a, b) {
      var x = k(a), y = k(b);
      if (x < y) return -d; if (x > y) return d;
      return a.rank - b.rank;
    });
  }

  var tbody = $('tbody');
  function renderBoard() {
    var list = sorted(filtered());
    $('count').textContent = list.length + ' of ' + rows.length + ' rows';
    $('empty').hidden = list.length !== 0;
    var html = '';
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' +
        (r.watchlist ? ' class="wl' : ' class="') + (state.selected === r.slug ? ' selected"' : '"') + '>' +
        '<td class="n rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="wltag">WL</span>' : '') +
        '<span class="pcat">' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td class="n">' + fmtUSD(r.tvl_usd) + '</td>' +
        '<td class="n ' + (r.change_7d == null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="n">' + fmtUSD(r.implied_value_usd) + '</td>' +
        '<td class="n">' + fmtX(r.model.category_multiple) + '</td>' +
        '<td class="n">' + fmtAge(r.age_days) + '</td>' +
        '<td class="n">' + r.chains.length + '</td></tr>';
    });
    tbody.innerHTML = html;
  }

  function renderDetail(r) {
    if (!r) { $('detail').innerHTML = '<p class="empty">Select a protocol.</p>'; return; }
    var m = r.model;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var chips = r.chains.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    $('detail').innerHTML =
      '<div class="biglab">Rank #' + r.rank + (r.watchlist ? ' · watchlist' : ' · early radar') + '</div>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="dsub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · records no token</div>' +
      '<div class="biglab">Implied value</div><div class="bigval">' + fmtFull(r.implied_value_usd) + '</div>' +
      '<div class="dgrid">' +
      '<div><span class="dk">TVL</span><span class="dv">' + fmtFull(r.tvl_usd) + '</span></div>' +
      '<div><span class="dk">7d change</span><span class="dv">' + fmtPct(r.change_7d) + '</span></div>' +
      '<div><span class="dk">Listed</span><span class="dv">' + esc(r.listed_at || 'unknown') + '</span></div>' +
      '<div><span class="dk">Age</span><span class="dv">' + fmtAge(r.age_days) + '</span></div>' +
      '</div>' +
      '<h3>Chains (' + r.chains.length + ')</h3><div>' + chips + '</div>' +
      '<h3>Value breakdown</h3>' +
      '<table class="breakdown">' +
      '<tr><td>TVL</td><td class="n">' + fmtFull(r.tvl_usd) + '</td></tr>' +
      '<tr><td>x Category multiple (' + esc(r.category || 'none') + ', n=' + m.category_sample + ')</td><td class="n">' + fmtX(m.category_multiple) + '</td></tr>' +
      '<tr><td>x Momentum (7d ' + fmtPct(r.change_7d) + ')</td><td class="n">' + fmtX(m.momentum_factor) + '</td></tr>' +
      '<tr><td>x Maturity (age ' + fmtAge(r.age_days) + ')</td><td class="n">' + fmtX(m.maturity_factor) + '</td></tr>' +
      '<tr><td>x Multichain (' + r.chains.length + ' chains)</td><td class="n">' + fmtX(m.multichain_factor) + '</td></tr>' +
      '<tr class="total"><td>= Implied value</td><td class="n">' + fmtFull(r.implied_value_usd) + '</td></tr>' +
      '</table>' +
      '<h3>Farm plan (' + r.farm_steps.length + ' steps)</h3>' +
      '<ol class="steps">' + steps + '</ol>';
  }

  function select(slug, scroll) {
    state.selected = slug;
    renderBoard();
    renderDetail(bySlug[slug]);
    if (scroll) {
      var el = tbody.querySelector('tr[data-slug="' + slug + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  tbody.addEventListener('click', function (ev) {
    var tr = ev.target.closest ? ev.target.closest('tr[data-slug]') : null;
    if (tr) select(tr.getAttribute('data-slug'), false);
  });

  // Sorting: click a header to sort, click again to reverse.
  var heads = Array.prototype.slice.call(document.querySelectorAll('#board th.sortable'));
  var labels = {};
  heads.forEach(function (th) { labels[th.getAttribute('data-sort')] = th.textContent; });
  function paintHeads() {
    heads.forEach(function (th) {
      var k = th.getAttribute('data-sort');
      th.innerHTML = esc(labels[k]) + (state.sort === k ? ' <span class="arr">' + (state.dir === 1 ? '▲' : '▼') + '</span>' : '');
    });
  }
  heads.forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = (k === 'rank' || k === 'name') ? 1 : -1; }
      paintHeads();
      renderBoard();
    });
  });

  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  chainSel.addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('wlonly').addEventListener('change', function (e) { state.wl = e.target.checked; renderBoard(); });
  $('mintvl').addEventListener('input', function (e) {
    state.mintvl = Number(e.target.value);
    $('mintvlVal').textContent = state.mintvl > 0 ? '>= ' + fmtUSD(state.mintvl) : 'any';
    renderBoard();
  });
  $('reset').addEventListener('click', function () {
    state = { q: '', cat: '', chain: '', wl: false, mintvl: 0, sort: 'rank', dir: 1, selected: state.selected };
    $('q').value = ''; catSel.value = ''; chainSel.value = '';
    $('wlonly').checked = false; $('mintvl').value = 0; $('mintvlVal').textContent = 'any';
    paintHeads();
    renderBoard();
  });

  // Live comparables strip.
  var lt = '';
  R.live.forEach(function (p) {
    lt += '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.symbol || '—') + '</td><td>' + esc(p.category || '—') + '</td>' +
      '<td class="n">' + fmtUSD(p.tvl_usd) + '</td><td class="n">' + fmtUSD(p.mcap_usd) + '</td><td class="n">' + p.ratio.toFixed(3) + '</td></tr>';
  });
  $('livetbody').innerHTML = lt;

  paintHeads();
  renderBoard();
  select(rows[0].slug, false);
})();
