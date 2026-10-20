/*
 * Zoning Studio 連携
 *
 * 1. Zoning Studio の「見積もりを詰める」から、URL の #zs=... に案件の情報 (お客様名・住所・トレーラーの種類と棟数) を付けて開かれる。
 *    → パスワード画面の前に sessionStorage へ退避し、起動後 (bootApp の最後) に入力欄へ入れる。
 *    → 前に反映した見積もりがあれば (quote_id)、その見積もりを「修正」で開く。
 * 2. 見積もりを確定した画面に「Zoning Studio に反映」ボタンを出す。
 *    → お客様向けの明細と合計だけを #zsq=... に付けて Zoning Studio の案件に戻る (原価・粗利・社内向けの行は渡さない)。
 *
 * 本体 (quote_app.html / test.html) のグローバル関数・変数 (state, update, resetAll, editQuote, loadQuotes,
 * PREFECTURES, PREF_CITIES, buildAreaString, showCompletionFromData) を使う。
 * 本体には <head> でこのファイルを読み込み、bootApp の最後で window.zsAfterBoot() を呼ぶ 1 行だけを足している。
 */
(function () {
  'use strict';

  var KEY = 'zs_link_v1';
  // 戻り先として許す Zoning Studio の URL (見積もりの内容を他のサイトへ送らないため)
  var RETURN_OK = /^(https:\/\/zoning-simulator[\w-]*\.vercel\.app|http:\/\/localhost(:\d+)?)\/projects\/[\w-]+\/step-04$/;

  function decode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function encode(o) {
    var bytes = new TextEncoder().encode(JSON.stringify(o));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function getLink() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function setLink(l) {
    try { l ? sessionStorage.setItem(KEY, JSON.stringify(l)) : sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  // ---- 1. 受け取り (パスワード画面より前) ----
  var m = location.hash.match(/[#&]zs=([^&]+)/);
  if (m) {
    try {
      var p = decode(m[1]);
      if (p && p.v === 1 && p.project_id && RETURN_OK.test(p.return_url || '')) {
        p.applied = false;
        setLink(p);
      } else {
        console.warn('[zoning-link] 受け取った内容が正しくありません');
      }
    } catch (e) {
      console.warn('[zoning-link] 受け取りに失敗しました', e);
    }
    history.replaceState(null, '', location.pathname + location.search);
  }

  // 住所の文字列 → 都道府県・市区町村・以降
  function splitAddress(addr) {
    addr = (addr || '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').replace(/^日本[、,\s]*/, '').trim();
    var pref = (typeof PREFECTURES !== 'undefined' ? PREFECTURES : []).find(function (x) { return addr.indexOf(x) === 0; });
    if (!pref) return { pref: '', city: '', sub: addr };
    var rest = addr.slice(pref.length);
    var cities = ((typeof PREF_CITIES !== 'undefined' && PREF_CITIES[pref]) || [])
      .filter(function (c) { return rest.indexOf(c) === 0; })
      .sort(function (a, b) { return b.length - a.length; });
    // 「北佐久郡軽井沢町」の郡を省いた書き方 (軽井沢町…) にも合わせる
    if (!cities.length) {
      cities = ((PREF_CITIES && PREF_CITIES[pref]) || [])
        .filter(function (c) { var t = c.replace(/^.+?郡/, ''); return t !== c && rest.indexOf(t) === 0; });
      if (cities.length) return { pref: pref, city: cities[0], sub: rest.slice(cities[0].replace(/^.+?郡/, '').length).trim() };
    }
    if (!cities.length) return { pref: pref, city: '', sub: rest.trim() };
    return { pref: pref, city: cities[0], sub: rest.slice(cities[0].length).trim() };
  }

  function applyPrefill(L) {
    // 前に Zoning Studio へ反映した見積もりがあれば、それを「修正」で開く
    if (L.quote_id && typeof loadQuotes === 'function' && loadQuotes().some(function (q) { return q.id === L.quote_id; })) {
      editQuote(L.quote_id);
      return;
    }
    resetAll();
    state.customerName = L.customer_name || '';
    var a = splitAddress(L.address);
    state.areaPref = a.pref;
    state.areaCity = a.city;
    state.areaSub = a.sub;
    state.area = buildAreaString();
    var first = null;
    (L.items || []).forEach(function (it) {
      var s = state[it.series];
      if (!s || !s.modelQtys) return;
      s.modelQtys[it.id] = (s.modelQtys[it.id] || 0) + (it.qty || 1);
      first = first || it.series;
    });
    // 見積もりに型番が無いトレーラーは「その他車両」の追加オプションに名前と台数だけ入れる (金額は営業が入れる)
    (L.extras || []).forEach(function (x) {
      state.other.customOpts.push({ name: x.name, qty: x.qty || 1, price: 0 });
      first = first || 'other';
    });
    if (first) state.active = first;
    update();
  }

  function showBanner(L) {
    if (document.getElementById('zsBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'zsBanner';
    bar.setAttribute('style', [
      'position:sticky', 'top:0', 'z-index:900', 'display:flex', 'flex-wrap:wrap', 'align-items:center', 'gap:8px 12px',
      'padding:8px 14px', 'background:#1a1a1a', 'color:#fff', 'font-size:12px', 'line-height:1.5',
    ].join(';'));
    var txt = document.createElement('span');
    txt.style.flex = '1 1 260px';
    txt.textContent = 'Zoning Studio の「' + (L.customer_name || 'お客様') + ' 様」の案件から開いています。オプション・配送などを選んで見積もりを確定し、「Zoning Studio に反映」を押してください。';
    var back = document.createElement('a');
    back.href = L.return_url;
    back.textContent = '反映せずに戻る';
    back.setAttribute('style', 'color:#fff;opacity:.75;text-decoration:underline;white-space:nowrap');
    back.onclick = function () { setLink(null); };
    bar.append(txt, back);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  function sendBack(q) {
    var L = getLink();
    if (!L || !q) return;
    var payload = {
      v: 1,
      project_id: L.project_id,
      quote_id: q.id,
      created_at: q.createdAt,
      customer_name: q.customerName || '',
      area: q.area || '',
      // お客様向けの明細だけ (社内向けの行・原価は渡さない)
      sections: (q.sections || []).map(function (s) {
        return {
          title: s.title,
          lines: (s.lines || []).filter(function (l) { return !l.internalOnly; })
            .map(function (l) { return { name: l.name, amount: Math.round(l.val || 0) }; }),
        };
      }).filter(function (s) { return s.lines.length; }),
      discount: Math.round(q.discount || 0),
      total_pre: Math.round(q.totalPre || 0),
      total_tax: Math.round(q.totalTax || 0),
    };
    setLink(null);
    location.href = L.return_url + '#zsq=' + encode(payload);
  }

  // 確定画面 (completionPage) に反映ボタンを出す
  var lastQuote = null;
  function hookCompletion() {
    if (window.__zsHooked || typeof showCompletionFromData !== 'function') return;
    window.__zsHooked = true;
    var orig = showCompletionFromData;
    window.showCompletionFromData = function (q, save) {
      var r = orig.apply(this, arguments);
      lastQuote = q;
      addSendButton();
      return r;
    };
  }
  function addSendButton() {
    if (!getLink()) return;
    var actions = document.querySelector('#completionPage .comp-actions');
    if (!actions || document.getElementById('zsSendBtn')) return;
    var wrap = document.createElement('div');
    wrap.setAttribute('style', 'padding:0 0 12px');
    var btn = document.createElement('button');
    btn.id = 'zsSendBtn';
    btn.textContent = 'この見積もりを Zoning Studio に反映 →';
    btn.setAttribute('style', 'display:block;width:100%;background:#1a1a1a;color:#fff;border:0;border-radius:999px;padding:14px 18px;font-size:15px;font-weight:700;cursor:pointer');
    btn.onclick = function () { sendBack(lastQuote); };
    wrap.appendChild(btn);
    actions.parentNode.insertBefore(wrap, actions);
  }

  window.zsAfterBoot = function () {
    var L = getLink();
    if (!L) return;
    hookCompletion();
    if (!L.applied) {
      applyPrefill(L);
      L.applied = true;
      setLink(L);
    }
    showBanner(L);
  };

  // テスト用
  window.__zsLink = { decode: decode, encode: encode, splitAddress: splitAddress };
})();
