(function () {
  'use strict';
  if (window.__autosellSearchInstalled) return;
  window.__autosellSearchInstalled = true;

  var PAGES = [
    { label: 'Overview', group: 'Dashboard', words: 'home dashboard status summary landing' },
    { label: 'AutoSell Pairs', group: 'Dashboard', words: 'pairs accounts buyer seller threshold minecraft credentials microsoft email ign hot reload pair count' },
    { label: 'Analytics', group: 'Dashboard', words: 'analytics charts stats trends' },
    { label: 'Eldorado Orders', group: 'Eldorado Pipeline', words: 'orders sold deliveries marketplace buyer chat proof holds' },
    { label: 'Eldorado Setup', group: 'Eldorado Pipeline', words: 'eldorado browser chrome profile seller api client id secret offer listing undercut price reserve connection check delivery setup' },
    { label: 'Treasury & Sweeps', group: 'Eldorado Pipeline', words: 'treasury sweep holder transfer balance coins payout ltc' },
    { label: 'Sales & Activity', group: 'Sales & Members', words: 'sales activity log events history' },
    { label: 'Sellers & Cashouts', group: 'Sales & Members', words: 'sellers cashouts balances pending ltc addresses' },
    { label: 'Member Lookup', group: 'Sales & Members', words: 'member user lookup discord id ign history search' },
    { label: 'Environment Studio (.env)', group: 'Bot & Settings', words: 'environment env settings credentials discord token guild admin role owner id mc host port version home command reconnect wallet mnemonic wif send enabled fee blockcypher api key port host security' },
    { label: 'Wallet & Restock', group: 'Bot & Settings', words: 'wallet deposit address ltc balance restock qr copy address price rates safety limits' },
    { label: 'Buyer messages', group: 'Bot & Settings', words: 'ai chat safety assistant opening message replies limits' },
    { label: 'Controls & Console', group: 'Bot & Settings', words: 'controls console global autosell pause resume start stop lockdown emergency console commands terminal logs' },
    { label: 'Discord Intake Setup', group: 'Bot & Settings', words: 'discord intake sell panel log channels setup' }
  ];

  var css = [
    '#as-search-open{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;',
    'padding:10px 14px;border-radius:14px;border:1px solid rgba(148,163,184,.25);background:rgba(15,20,30,.92);',
    'color:#e2e8f0;font:600 12px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(8px);',
    'box-shadow:0 8px 30px rgba(0,0,0,.45)}',
    '#as-search-open:hover{border-color:rgba(244,63,94,.6);color:#fff}',
    '#as-search-open kbd{font:700 10px "JetBrains Mono",monospace;padding:2px 6px;border-radius:6px;border:1px solid rgba(148,163,184,.3);color:#94a3b8}',
    '#as-search-overlay{position:fixed;inset:0;z-index:2147483001;display:none;align-items:flex-start;justify-content:center;',
    'padding-top:12vh;background:rgba(3,6,12,.66);backdrop-filter:blur(3px)}',
    '#as-search-overlay.open{display:flex}',
    '#as-search-overlay .as-box{width:min(620px,92vw);border-radius:16px;border:1px solid rgba(148,163,184,.22);',
    'background:#0c101a;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;font-family:"Plus Jakarta Sans",system-ui,sans-serif}',
    '#as-search-input{width:100%;box-sizing:border-box;padding:16px 18px;border:0;outline:0;background:#080b12;color:#f1f5f9;',
    'font:600 15px "Plus Jakarta Sans",system-ui,sans-serif;border-bottom:1px solid rgba(148,163,184,.14)}',
    '#as-search-results{max-height:46vh;overflow:auto;padding:6px}',
    '.as-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:11px 12px;border:0;',
    'border-radius:10px;background:transparent;color:#e2e8f0;font:600 13px "Plus Jakarta Sans",system-ui,sans-serif;',
    'text-align:left;cursor:pointer}',
    '.as-row:hover,.as-row.active{background:rgba(244,63,94,.12);color:#fff}',
    '.as-row .as-group{font:700 9px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;color:#64748b}',
    '.as-hint{padding:9px 14px;border-top:1px solid rgba(148,163,184,.12);color:#64748b;font:500 11px "Plus Jakarta Sans",system-ui,sans-serif}',
    '.as-empty{padding:18px;color:#64748b;font:500 12px "Plus Jakarta Sans",system-ui,sans-serif}',
    '@media (max-width:600px){#as-search-open span{display:none}}'
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var button = document.createElement('button');
  button.id = 'as-search-open';
  button.type = 'button';
  button.innerHTML = '🔎 <span>Search</span> <kbd>Ctrl K</kbd>';
  document.body.appendChild(button);

  var overlay = document.createElement('div');
  overlay.id = 'as-search-overlay';
  overlay.innerHTML =
    '<div class="as-box" role="dialog" aria-label="Search AutoSell pages">' +
      '<input id="as-search-input" type="text" placeholder="Search pages, settings, features… (e.g. wallet, api, threshold)" autocomplete="off" spellcheck="false" />' +
      '<div id="as-search-results"></div>' +
      '<div class="as-hint">Enter opens the first result · Esc closes</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var input = overlay.querySelector('#as-search-input');
  var results = overlay.querySelector('#as-search-results');
  var matches = [];

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function render(query) {
    var q = normalize(query);
    matches = (q
      ? PAGES.filter(function (page) { return normalize(page.label + ' ' + page.group + ' ' + page.words).indexOf(q) !== -1; })
      : PAGES
    ).slice(0, 40);

    results.innerHTML = '';
    if (!matches.length) {
      results.innerHTML = '<div class="as-empty">No match — try “wallet”, “api”, “threshold”, “panel”, “logs”…</div>';
      return;
    }
    matches.forEach(function (page, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'as-row' + (index === 0 ? ' active' : '');
      var label = document.createElement('span');
      label.className = 'as-label';
      label.textContent = page.label;
      var group = document.createElement('span');
      group.className = 'as-group';
      group.textContent = page.group;
      row.appendChild(label);
      row.appendChild(group);
      row.addEventListener('click', function () { choose(page); });
      results.appendChild(row);
    });
  }

  function open() {
    overlay.classList.add('open');
    input.value = '';
    render('');
    setTimeout(function () { input.focus(); }, 10);
  }
  function close() {
    overlay.classList.remove('open');
  }

  function choose(page) {
    close();
    var sidebar = document.querySelector('aside');
    if (!sidebar) return;
    var wanted = normalize(page.label);
    var all = Array.prototype.slice.call(sidebar.querySelectorAll('*'));
    var exact = all.filter(function (el) {
      return normalize(el.textContent) === wanted && el.getClientRects().length;
    });
    exact.sort(function (a, b) { return a.querySelectorAll('*').length - b.querySelectorAll('*').length; });
    var target = exact[0] || all.filter(function (el) {
      return normalize(el.textContent).indexOf(wanted) !== -1 && el.getClientRects().length;
    })[0];
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
      target.click();
    }
  }

  input.addEventListener('input', function () { render(input.value); });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter' && matches[0]) choose(matches[0]);
  });
  overlay.addEventListener('click', function (event) { if (event.target === overlay) close(); });
  button.addEventListener('click', open);
  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
      event.preventDefault();
      if (overlay.classList.contains('open')) close(); else open();
    } else if (event.key === 'Escape' && overlay.classList.contains('open')) {
      close();
    }
  });
})();
