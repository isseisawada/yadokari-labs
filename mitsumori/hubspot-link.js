/* HubSpot 連携（テスト中）— test.html だけで読み込む。
 * 顧客情報の下に「HubSpot の取引」「支払条件」「概算で保存」を足し、
 * 「見積もりを確定」したら承認依頼（Slack）を出す。処理は Supabase の quote-hubspot。
 */
(function () {
  if (typeof IS_TEST === 'undefined' || !IS_TEST) return;   // 本番ページでは何もしない

  var API = SUPABASE_URL + '/functions/v1/quote-hubspot';
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

  function call(body) {
    body.ns = NS;
    return fetch(API, {
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
    var c = sectionCard('HubSpot 連携（テスト中）', 'テスト用パイプラインの取引にだけ書き込みます');
    var msg = h('div', { style: 'font-size:12px;margin-top:6px;min-height:1em' });
    function say(t, bad) { msg.textContent = t; msg.style.color = bad ? '#b00020' : '#555'; }

    // 取引
    var dealBox = h('div', { class: 'cust-field' });
    function drawDeal() {
      dealBox.innerHTML = '<label>HubSpot の取引</label>';
      if (st.deal) {
        var row = h('div', { style: 'display:flex;gap:8px;align-items:center' },
          '<span>' + escapeHtml(st.deal.name || '') + '</span>');
        var a = h('a', { href: '#', style: 'font-size:12px' }, '選び直す');
        a.onclick = function (ev) { ev.preventDefault(); st.deal = null; save(); drawDeal(); };
        row.appendChild(a);
        dealBox.appendChild(row);
        return;
      }
      var inp = h('input', { type: 'text', placeholder: '取引名で検索（Enter）' });
      inp.value = state.customerName || '';
      var list = h('div', { style: 'font-size:13px' });
      function search() {
        say('検索中…');
        call({ action: 'search', q: inp.value }).then(function (r) {
          say(r.deals.length ? '' : '見つかりませんでした');
          list.innerHTML = '';
          r.deals.forEach(function (d) {
            var b = h('button', { type: 'button', class: 'btn-b', style: 'display:block;margin:4px 0;text-align:left' }, escapeHtml(d.name || d.id));
            b.onclick = function () { st.deal = { id: d.id, name: d.name }; save(); drawDeal(); say(''); };
            list.appendChild(b);
          });
          var nb = h('button', { type: 'button', class: 'btn-b', style: 'display:block;margin:4px 0' }, '＋ 新しく取引を作る');
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
      '<select id="hsTerms"><option value="lump">一括</option><option value="deposit">着手金＋残金</option></select> ' +
      '<span id="hsPctWrap">着手金 <input id="hsPct" type="number" min="1" max="99" style="width:4em">%</span>' +
      '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-weight:normal"><input type="checkbox" id="hsNew" style="width:auto;margin:0"> 新規の取引先</label>');
    var sel = termsBox.querySelector('#hsTerms'), pct = termsBox.querySelector('#hsPct'), wrap = termsBox.querySelector('#hsPctWrap'), nc = termsBox.querySelector('#hsNew');
    sel.value = st.terms.kind; pct.value = st.terms.depositPct; nc.checked = !!st.newCustomer;
    wrap.style.display = st.terms.kind === 'deposit' ? '' : 'none';
    sel.onchange = function () { st.terms.kind = sel.value; wrap.style.display = sel.value === 'deposit' ? '' : 'none'; save(); };
    pct.onchange = function () { st.terms.depositPct = pct.value; save(); };
    nc.onchange = function () { st.newCustomer = nc.checked; save(); };

    var est = h('button', { type: 'button', class: 'btn-b', style: 'margin-top:8px' }, '概算で保存（HubSpot へ）');
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

  // 「見積もりを確定」→ 承認依頼
  var origComplete = window.showCompletionFromData;
  window.showCompletionFromData = function (q, saveToHistory) {
    var r = origComplete.apply(this, arguments);
    if (!saveToHistory) return r;
    var box = h('div', { style: 'margin-top:12px;padding:10px;border:1px solid #e0ddd5;font-size:13px' });
    document.getElementById('compBody').appendChild(box);
    if (!st.deal) { box.textContent = 'HubSpot の取引が選ばれていないので、承認依頼は出していません（テスト中）'; return r; }
    box.textContent = '承認依頼を出しています…';
    call({ action: 'confirm', dealId: st.deal.id, quote: q, terms: terms(), newCustomer: !!st.newCustomer }).then(function (res) {
      var who = res.steps.length > 1 ? '上長 → コーポレート' : '上長';
      box.innerHTML = 'Slack に承認依頼を出しました（' + who + '）。' +
        (res.reasons.length ? '<br>コーポレートに回る理由：' + escapeHtml(res.reasons.join('、')) : '');
      var chk = h('button', { type: 'button', class: 'btn-b', style: 'margin-top:6px;display:block' }, '承認の状態を見る');
      chk.onclick = function () {
        call({ action: 'status', quoteId: q.id }).then(function (s) {
          var label = { estimate: '概算', pending: '承認待ち', approved: '承認済み（B.クロージング）', rejected: '差し戻し' }[s.status] || 'なし';
          chk.textContent = '状態：' + label + '（もう一度押すと更新）';
        }).catch(function (e) { chk.textContent = e.message; });
      };
      box.appendChild(chk);
    }).catch(function (e) { box.textContent = '承認依頼に失敗しました：' + e.message; });
    return r;
  };

  // 読み込む前に描かれていた画面にも出す
  var main = document.getElementById('mainContent');
  if (main && main.children.length && typeof update === 'function') update();
})();
