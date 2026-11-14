// Yツール版テスト（test-ytool.html）専用の写し。動きは ../hubspot-link.js と同じで、見た目だけ Yツールの部品にしている
/* HubSpot 連携（テスト中）— test.html だけで読み込む。
 * 顧客情報の下に「HubSpot の取引」「支払条件」「概算で保存」を足し、
 * 「見積もりを確定」したら承認依頼（Slack）を出す。処理は Supabase の quote-hubspot。
 */
(function () {
  if (typeof IS_TEST === 'undefined' || !IS_TEST) return;   // 本番ページでは何もしない

  var FN = SUPABASE_URL + '/functions/v1/';
  var KEY = 'hs_link_v1';
  var st = load();

  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }
  if (!st.terms) st.terms = { kind: 'lump', depositPct: 50 };

  // Zoning Studio から取引ID付きで開かれたら、それを選んでおく
  try {
    var zs = JSON.parse(sessionStorage.getItem('zs_link_v1') || 'null');
    if (zs && zs.hubspot_deal_id && !st.deal) { st.deal = { id: zs.hubspot_deal_id, name: zs.hubspot_deal_name || ('取引 ' + zs.hubspot_deal_id) }; save(); }
  } catch (e) { /* ignore */ }

  // ?demo=1 のときは HubSpot・Slack を呼ばず、にせものの返事で画面の流れだけ見せる
  var DEMO = /[?&]demo=1\b/.test(location.search);
  function demo(body) {
    var deal = { id: 'demo1', name: (state.customerName || 'サンプル顧客') + '（見学用）' };
    var q = body.quote || {};
    var reasons = [q.discount > 0 ? '値引きあり' : '', q.marginPct < 30 ? '粗利率が基準未満' : ''].filter(Boolean);
    var res = {
      search: { deals: [deal] },
      create: { deal: { id: 'demo2', name: body.dealname } },
      estimate: { status: 'estimate' },
      confirm: { status: 'pending', steps: reasons.length ? ['manager', 'corporate'] : ['manager'], reasons: reasons },
      status: { status: 'approved' },
      'mock-decide': { results: [{ step: body.app === 'delivery' ? 'on_delivered' : 'on_ordered' }] },
      flow: { status: 'delivery_pending', project_no: 'H-demo1' },
    }[body.action === 'status' && body.dealId ? 'flow' : body.action];
    return new Promise(function (ok) { setTimeout(function () { ok(res); }, 400); });
  }

  function call(body, fn) {
    body.ns = NS;
    if (DEMO) return demo(body);
    return fetch(FN + (fn || 'quote-hubspot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      return j;
    });
  }

  function currentQuote() {
    var sections = collectLines();
    if (!sections.length) throw new Error('モデルを選択してください');
    var q = buildQuoteData(sections);
    applyCostOverridesToQuote(q);
    return q;
  }

  function terms() {
    return st.terms.kind === 'deposit' ? { kind: 'deposit', depositPct: Number(st.terms.depositPct) } : { kind: 'lump' };
  }

  function h(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  function panel() {
    var c = sectionCard('HubSpot 連携（テスト中）', DEMO ? '見学用モード：HubSpot・Slack には何も送りません' : 'テスト用パイプラインの取引にだけ書き込みます');
    var msg = h('div', { class: 'yt-msg' });
    function say(t, bad) { msg.textContent = t; msg.style.color = bad ? 'var(--danger)' : 'var(--sub)'; }

    // 取引
    var dealBox = h('div', { class: 'cust-field' });
    function drawDeal() {
      dealBox.innerHTML = '<label>HubSpot の取引</label>';
      if (st.deal) {
        var row = h('div', { style: 'display:flex;gap:var(--s2);align-items:center' },
          '<span>' + escapeHtml(st.deal.name || '') + '</span>');
        var a = h('a', { href: '#', class: 'yt-link' }, '選び直す');
        a.onclick = function (ev) { ev.preventDefault(); st.deal = null; save(); drawDeal(); };
        row.appendChild(a);
        dealBox.appendChild(row);
        return;
      }
      var inp = h('input', { type: 'text', class: 'yt-input', placeholder: '取引名で検索（Enter）' });
      inp.value = state.customerName || '';
      var list = h('div', { class: 'yt-btns', style: 'margin-top:var(--s2)' });
      function search() {
        say('検索中…');
        call({ action: 'search', q: inp.value }).then(function (r) {
          say(r.deals.length ? '' : '見つかりませんでした');
          list.innerHTML = '';
          r.deals.forEach(function (d) {
            var b = h('button', { type: 'button', class: 'yt-btn yt-btn--secondary yt-btn--s' }, escapeHtml(d.name || d.id));
            b.onclick = function () { st.deal = { id: d.id, name: d.name }; save(); drawDeal(); say(''); };
            list.appendChild(b);
          });
          var nb = h('button', { type: 'button', class: 'yt-btn yt-btn--ghost yt-btn--s' }, '<svg class="yt-ic" aria-hidden="true"><use href="#i-plus"/></svg>新しく取引を作る');
          nb.onclick = function () {
            var name = [state.customerName, state.area].filter(Boolean).join('｜') || inp.value;
            if (!name) return say('顧客名か検索欄に取引名を入れてください', true);
            say('作成中…');
            call({ action: 'create', dealname: name }).then(function (r) {
              st.deal = { id: r.deal.id, name: r.deal.name }; save(); drawDeal(); say('取引を作りました');
            }).catch(function (e) { say(e.message, true); });
          };
          list.appendChild(nb);
        }).catch(function (e) { say(e.message, true); });
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      dealBox.appendChild(inp);
      dealBox.appendChild(list);
    }
    drawDeal();

    // 支払条件・新規取引先
    var termsBox = h('div', { class: 'cust-field' },
      '<label>支払条件</label>' +
      '<select id="hsTerms" class="yt-select"><option value="lump">一括</option><option value="deposit">着手金＋残金</option></select> ' +
      '<span id="hsPctWrap" class="yt-inline">着手金 <input id="hsPct" class="yt-input" type="number" min="1" max="99" style="width:5em">%</span>' +
      '<label class="yt-check"><input type="checkbox" id="hsNew"> 新規の取引先</label>');
    var sel = termsBox.querySelector('#hsTerms'), pct = termsBox.querySelector('#hsPct'), wrap = termsBox.querySelector('#hsPctWrap'), nc = termsBox.querySelector('#hsNew');
    sel.value = st.terms.kind; pct.value = st.terms.depositPct; nc.checked = !!st.newCustomer;
    wrap.style.display = st.terms.kind === 'deposit' ? '' : 'none';
    sel.onchange = function () { st.terms.kind = sel.value; wrap.style.display = sel.value === 'deposit' ? '' : 'none'; save(); };
    pct.onchange = function () { st.terms.depositPct = pct.value; save(); };
    nc.onchange = function () { st.newCustomer = nc.checked; save(); };

    var est = h('button', { type: 'button', class: 'yt-btn yt-btn--secondary', style: 'margin-top:var(--s3)' }, '概算で保存（HubSpot へ）');
    est.onclick = function () {
      if (!st.deal) return say('先に HubSpot の取引を選んでください', true);
      var q;
      try { q = currentQuote(); } catch (e) { return say(e.message, true); }
      say('保存中…');
      call({ action: 'estimate', dealId: st.deal.id, quote: q, terms: terms() })
        .then(function () { say('HubSpot の取引に概算を入れ、「D.提案」にしました'); })
        .catch(function (e) { say(e.message, true); });
    };

    var grid = div('cust-grid');
    grid.appendChild(dealBox); grid.appendChild(termsBox);
    c.appendChild(grid); c.appendChild(est); c.appendChild(msg);
    return c;
  }

  // 顧客情報のカードのすぐ下に出す
  var origCustomer = window.renderCustomerCard;
  window.renderCustomerCard = function () {
    var frag = document.createDocumentFragment();
    frag.appendChild(origCustomer.apply(this, arguments));
    frag.appendChild(panel());
    return frag;
  };

  // 見積もりが承認されたあとの「受注稟議 → 納品完了報告 → 請求書」をテストで進める（バクラク・freee はにせもの）
  function flowPanel(dealId) {
    var p = h('div', { class: 'yt-flow' },
      '<div class="yt-sub-card__ttl">受注〜請求 <span class="yt-tag yt-tag--warn">テスト</span></div><div class="yt-note">Slack で最後の承認をすると、受注稟議の下書きができます。バクラクと freee はまだにせものです</div>');
    var out = h('div', { class: 'yt-msg' });
    var LABEL = { order_pending: '受注稟議の承認待ち', order_rejected: '受注稟議が差し戻し', delivery_pending: '納品完了報告の承認待ち（着手金の請求書は下書き済み）', delivery_rejected: '納品完了報告が差し戻し', done: '完了（残金の請求書を下書き済み）' };
    function show() {
      call({ action: 'status', dealId: dealId }, 'deal-flow').then(function (s) {
        out.textContent = s.status ? '状態：' + (LABEL[s.status] || s.status) + '（案件番号 ' + s.project_no + '）' + (s.last_error ? '／止まっている理由：' + s.last_error : '') : 'まだ始まっていません（Slack で最後の承認を）';
      }).catch(function (e) { out.textContent = e.message; });
    }
    function btn(label, body) {
      var b = h('button', { type: 'button', class: 'yt-btn yt-btn--secondary yt-btn--s', style: 'margin:var(--s2) var(--s2) 0 0' }, label);
      b.onclick = function () { out.textContent = '進めています…'; call(body, 'deal-flow').then(show).catch(function (e) { out.textContent = e.message; }); };
      p.appendChild(b);
    }
    btn('受注稟議を承認する（にせもの）', { action: 'mock-decide', dealId: dealId, app: 'order', decision: 'approved' });
    btn('納品完了報告を承認する（にせもの）', { action: 'mock-decide', dealId: dealId, app: 'delivery', decision: 'approved' });
    var s = h('button', { type: 'button', class: 'yt-btn yt-btn--ghost yt-btn--s', style: 'margin-top:var(--s2)' }, '<svg class="yt-ic" aria-hidden="true"><use href="#i-refresh"/></svg>流れの状態を見る');
    s.onclick = show;
    p.appendChild(s);
    p.appendChild(out);
    return p;
  }

  // 「見積もりを確定」→ 承認依頼
  var origComplete = window.showCompletionFromData;
  window.showCompletionFromData = function (q, saveToHistory) {
    var r = origComplete.apply(this, arguments);
    if (!saveToHistory) return r;
    var box = h('div', { class: 'yt-card yt-card--tight yt-sub-card' });
    document.getElementById('compBody').appendChild(box);
    if (!st.deal) { box.textContent = 'HubSpot の取引が選ばれていないので、承認依頼は出していません（テスト中）'; return r; }
    box.textContent = '承認依頼を出しています…';
    call({ action: 'confirm', dealId: st.deal.id, quote: q, terms: terms(), newCustomer: !!st.newCustomer }).then(function (res) {
      var who = res.steps.length > 1 ? '上長 → コーポレート' : '上長';
      box.innerHTML = 'Slack に承認依頼を出しました（' + who + '）。' +
        (res.reasons.length ? '<br>コーポレートに回る理由：' + escapeHtml(res.reasons.join('、')) : '');
      var chk = h('button', { type: 'button', class: 'yt-btn yt-btn--secondary yt-btn--s', style: 'margin-top:var(--s2);display:flex' }, '承認の状態を見る');
      chk.onclick = function () {
        call({ action: 'status', quoteId: q.id }).then(function (s) {
          var label = { estimate: '概算', pending: '承認待ち', approved: '承認済み（B.クロージング）', rejected: '差し戻し' }[s.status] || 'なし';
          chk.textContent = '状態：' + label + '（もう一度押すと更新）';
        }).catch(function (e) { chk.textContent = e.message; });
      };
      box.appendChild(chk);
      box.appendChild(flowPanel(st.deal.id));
    }).catch(function (e) { box.textContent = '承認依頼に失敗しました：' + e.message; });
    return r;
  };

  // 読み込む前に描かれていた画面にも出す
  var main = document.getElementById('mainContent');
  if (main && main.children.length && typeof update === 'function') update();
})();
