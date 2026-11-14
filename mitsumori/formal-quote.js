/* 正式な見積書（PDF）（テスト中）— test.html だけで読み込む。
 * 確定画面に「正式な見積書（PDF）」ボタンと追加の入力欄を足し、
 * samples/formal-quote-sample.html と同じ体裁の A4 1枚を隠し iframe に描いて印刷（PDF 保存）する。
 */
(function () {
  if (typeof IS_TEST === 'undefined' || !IS_TEST) return;   // 本番ページでは何もしない

  // ── 発行元と定型文（freee の「【2024年4月発行から】見積書・請求書フォーマット」と同じ内容。2026-11-14） ──
  var ISSUER = {
    name: 'YADOKARI株式会社',
    zip: '240-0006',
    address: '神奈川県横浜市保土ケ谷区星川1-1-1 星天qlay',
    regNo: 'T3020003008399',        // 適格請求書発行事業者の登録番号
    seal: 'samples/seal.png',       // 社印。freee の請求書（2024年4月発行からの書式）に押されているものを写した
    logo: 'samples/logo.svg',
  };
  var VALID_DAYS = 30;
  // 支払いの条件と納期は案件ごとに違うので、確定画面の入力欄から入れる（空なら「（要確認）」）
  function notesFor(st) { return [
    '【見積り有効期限】' + VALID_DAYS + '日間',
    '【お支払い条件】' + (st.pay || '（要確認）'),
    '※恐れ入りますが、振込手数料は御社負担にてお願い申し上げます。',
    '【納期】' + (st.lead || '（要確認）') + '　※納期に関しましては、前後する可能性がございます。',
    '・車庫証明、印鑑証明等車検取得に関わる書類の取得はお客様にご準備をいただきます。',
    '・敷地に障害物がある・進入路や敷地形状が事前確認のものと異なるなどの場合、搬入ができないことや、本見積もり外に別途費用がかかる可能性があります。',
    '・現地での給排水費用は含まれておりません。',
  ]; }

  var KEY = 'fq_v1';
  var st = {};
  try { st = JSON.parse(sessionStorage.getItem(KEY) || 'null') || {}; } catch (e) { /* ignore */ }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var num = function (n) { return Math.round(n).toLocaleString('ja-JP'); };
  var yen = function (n) { return num(n) + '円'; };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var ymd = function (d, sep) { return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join(sep); };

  function defaultSubject(q) {
    var first = (q.sections || []).filter(function (s) { return s.key; })[0] || (q.sections || [])[0];
    return [first && first.title, q.area].filter(Boolean).join('｜');
  }

  // 見積データ → 見積書の HTML（1枚分）
  function render(q) {
    var d = new Date(q.createdAt);
    var until = new Date(d.getTime()); until.setDate(until.getDate() + VALID_DAYS);
    var no = 'Q-' + ymd(d, '') + '-' + String(q.id || '').slice(-4).toUpperCase();
    var tax = q.totalTax - q.totalPre;   // totalTax は税込の合計

    var row = function (name, qty, unit, amt, cls) {
      return '<tr class="' + (cls || '') + '"><td>' + esc(name) + '</td><td class="c-qty">' + qty + '</td><td class="c-unit num">' + unit + '</td><td class="c-amt num">' + amt + '</td></tr>';
    };
    var rows = '';
    q.sections.forEach(function (sec) {
      var lines = sec.lines.filter(function (l) { return !l.internalOnly; });
      if (!lines.length) return;
      rows += '<tr class="sec"><td colspan="4">▼' + esc(sec.title) + '</td></tr>';
      lines.forEach(function (l) {
        var m = l.name.match(/^(.*?)\s*×(\d+)台$/);   // 名前の末尾「×N台」を数量に
        var n = m ? +m[2] : 1;
        rows += row((m ? m[1] : l.name).replace(/^【ベース】/, ''), m ? n + '台' : '1式', num(l.val / n), num(l.val), l.cls);
      });
    });
    if (q.discount > 0) rows += row('お値引き', '1式', '−' + num(q.discount), '−' + num(q.discount), 'disc');

    // 自己チェック：明細の合計−値引き＝税抜合計
    var sum = q.sections.reduce(function (a, s) { return a + s.lines.reduce(function (b, l) { return b + (l.internalOnly ? 0 : l.val); }, 0); }, 0) - (q.discount || 0);
    console.assert(sum === q.totalPre, '見積書：明細の合計と税抜合計が合いません', sum, q.totalPre);

    var notes = notesFor(st).concat((st.note || '').split('\n').filter(function (s) { return s.trim(); }));
    var seal = ISSUER.seal ? '<img class="seal" src="' + esc(ISSUER.seal) + '" alt="社印">' : '';

    return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><base href="' + esc(location.href) + '">' +
      '<title>見積書_' + esc(no) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">' +
      '<style>' + CSS + '</style></head><body><div class="sheet">' +
      '<header><div><h1>見積書</h1><div class="en">QUOTATION</div></div><img src="' + esc(ISSUER.logo) + '" alt="YADOKARI"></header>' +
      '<section class="top"><div>' +
        '<div class="to-name">' + esc(q.customerName || '（お客様名）') + '<small>御中</small></div>' +
        '<div class="to-addr">' + esc(st.address || '') + '</div>' +
      '</div><div>' +
        '<table class="meta">' +
          '<tr><th>見積日</th><td class="num">' + ymd(d, '-') + '</td></tr>' +
          '<tr><th>見積書番号</th><td class="num">' + esc(no) + '</td></tr>' +
          '<tr><th>有効期限</th><td class="num">' + ymd(until, '-') + '</td></tr>' +
        '</table>' +
        '<div class="from">' + seal + '<b>' + esc(ISSUER.name) + '</b><br>担当：' + esc(q.staffName || '') + '<br>〒' + esc(ISSUER.zip) + '<br>' + esc(ISSUER.address) + '<br>登録番号：' + esc(ISSUER.regNo) + '</div>' +
      '</div></section>' +
      '<div class="subject"><span>件名</span><span>' + esc(st.subject || defaultSubject(q)) + '</span></div>' +
      '<div class="total">' +
        '<div><span class="lbl">小計（税抜）</span><span class="v num">' + yen(q.totalPre) + '</span></div>' +
        '<div><span class="lbl">消費税（10%）</span><span class="v num">' + yen(tax) + '</span></div>' +
        '<div class="grand"><span class="lbl">お見積金額（税込）</span><span class="v num">' + yen(q.totalTax) + '</span></div>' +
      '</div><p class="lead">下記のとおりお見積り申し上げます。</p>' +
      '<table class="items"><thead><tr><th>摘要</th><th class="c-qty">数量</th><th class="c-unit">単価</th><th class="c-amt">明細金額</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="breakdown"><table>' +
        '<tr><th>10%対象（税抜）</th><td class="num">' + yen(q.totalPre) + '</td></tr>' +
        '<tr><th>10%消費税</th><td class="num">' + yen(tax) + '</td></tr>' +
        '<tr class="sum"><th>合計（税込）</th><td class="num">' + yen(q.totalTax) + '</td></tr>' +
      '</table></div>' +
      '<div class="deliv"><span>納品期限</span><span>' + esc(st.due || '（要確認）') + '</span><span>納品場所</span><span>' + esc(st.place || '（要確認）') + '</span></div>' +
      '<div class="notes"><h2>備考</h2><ul>' + notes.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' +
      '<footer><span>' + esc(ISSUER.name) + '</span></footer>' +
      '</div></body></html>';
  }

  // samples/formal-quote-sample.html の CSS と同じ（画面用の余白だけ外した）
  var CSS =
    ':root{--k:#000;--g:#787878;--lg:#c8c8c8;--pg:#f5f5f5}@page{size:A4 portrait;margin:10mm 0}*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:"Inter","Noto Sans JP",sans-serif;color:var(--k);font-size:9.5pt;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.sheet{width:210mm;min-height:276.5mm;padding:3mm 15mm 0;background:#fff;display:flex;flex-direction:column}' +
    '.num{font-family:"Inter",sans-serif;font-variant-numeric:tabular-nums}' +
    'header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid var(--k);padding-bottom:4mm}' +
    'header h1{font-size:20pt;font-weight:700;letter-spacing:.5em}header .en{font-size:8pt;letter-spacing:.2em;color:var(--g)}header img{height:9mm}' +
    '.top{display:grid;grid-template-columns:1fr 72mm;gap:8mm;margin-top:5mm}' +
    '.to-name{font-size:14pt;font-weight:700;border-bottom:1px solid var(--k);padding-bottom:1.5mm}.to-name small{font-size:10pt;margin-left:.5em}' +
    '.to-addr{margin-top:2mm;font-size:8.5pt;color:var(--g)}.meta{width:100%;border-collapse:collapse}' +
    '.meta th,.meta td{border-bottom:1px solid var(--lg);padding:1mm 0;font-size:8.5pt}.meta th{text-align:left;font-weight:500;color:var(--g);width:22mm}.meta td{text-align:right}' +
    '.from{position:relative;margin-top:3mm;font-size:8.5pt;line-height:1.55}.from b{font-size:10.5pt}' +
    '.seal{position:absolute;right:0;top:0;width:17mm;height:17mm;border:1px dashed var(--lg);color:var(--g);font-size:7pt;display:grid;place-items:center;text-align:center;line-height:1.3}img.seal{border:0;object-fit:contain;mix-blend-mode:multiply;top:3.5mm;right:5mm}' +
    '.subject{display:grid;grid-template-columns:14mm 1fr;margin-top:4mm;font-size:10pt}.subject span:first-child{color:var(--g)}' +
    '.total{display:grid;grid-template-columns:1fr 1fr 1.6fr;margin-top:3mm;border:1px solid var(--k)}.total div{padding:2mm 3mm}.total div+div{border-left:1px solid var(--lg)}' +
    '.total .lbl{display:block;font-size:7.5pt;color:var(--g)}.total .v{font-size:11pt}.total .grand{background:var(--k);color:#fff}.total .grand .lbl{color:var(--lg)}.total .grand .v{font-size:17pt;font-weight:600}' +
    '.lead{margin-top:2mm;font-size:8pt;color:var(--g)}' +
    'table.items thead{display:table-header-group}table.items{width:100%;border-collapse:collapse;margin-top:4mm}table.items th{background:var(--k);color:#fff;font-weight:500;font-size:8pt;padding:1.5mm 2mm}' +
    'table.items td{border-bottom:1px solid var(--lg);padding:1mm 2mm;font-size:8.5pt}table.items tr{break-inside:avoid}' +
    '.c-qty{width:16mm;text-align:center}.c-unit,.c-amt{width:27mm;text-align:right}tr.sec td{background:var(--pg);font-weight:700;font-size:8pt}tr.base td:first-child{font-weight:500}' +
    '.breakdown{display:flex;justify-content:flex-end;margin-top:3mm}.breakdown table{border-collapse:collapse;width:82mm}' +
    '.breakdown th,.breakdown td{padding:.8mm 2mm;font-size:8.5pt;border-bottom:1px solid var(--lg)}.breakdown th{text-align:left;font-weight:400;color:var(--g)}.breakdown td{text-align:right}' +
    '.breakdown tr.sum th,.breakdown tr.sum td{color:var(--k);font-weight:700;border-bottom:2px solid var(--k)}' +
    '.deliv{margin-top:3mm;display:grid;grid-template-columns:18mm 1fr;row-gap:1mm;font-size:8.5pt}.deliv span:nth-child(odd){color:var(--g)}' +
    '.notes{margin-top:4mm;border:1px solid var(--lg);padding:3mm 4mm;font-size:8pt;line-height:1.6;break-inside:avoid}.notes h2{font-size:8.5pt;font-weight:700;margin-bottom:1mm}' +
    '.notes li{list-style:none;padding-left:1em;text-indent:-1em}' +
    'footer{margin-top:auto;padding-top:5mm;display:flex;justify-content:space-between;font-size:7.5pt;color:var(--g)}';

  // 隠し iframe に描いて印刷（ポップアップを止められないように新しいウィンドウは使わない）
  function printQuote(q) {
    var old = document.getElementById('fqFrame');
    if (old) old.remove();
    var f = document.createElement('iframe');
    f.id = 'fqFrame';
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    f.onload = function () {
      var w = f.contentWindow;
      var imgs = Array.prototype.map.call(w.document.images, function (i) { return i.complete ? 0 : new Promise(function (ok) { i.onload = i.onerror = ok; }); });
      Promise.all(imgs.concat([w.document.fonts.ready])).then(function () { w.focus(); w.print(); });
    };
    f.srcdoc = render(q);
    document.body.appendChild(f);
  }

  function field(label, key, ph, multi) {
    var wrap = document.createElement('label');
    wrap.style.cssText = 'display:block;margin-top:6px;font-size:12px;color:#555';
    wrap.textContent = label;
    var inp = document.createElement(multi ? 'textarea' : 'input');
    inp.placeholder = ph || '';
    inp.value = st[key] || '';
    inp.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:6px;font:inherit;font-size:13px;border:1px solid #e0ddd5' + (multi ? ';height:4.5em' : '');
    inp.oninput = function () { st[key] = inp.value; save(); };
    wrap.appendChild(inp);
    return wrap;
  }

  // 確定画面（履歴から開いたときも）にボタンと入力欄を出す
  var origComplete = window.showCompletionFromData;
  window.showCompletionFromData = function (q) {
    var r = origComplete.apply(this, arguments);
    var box = document.createElement('div');
    box.style.cssText = 'margin-top:12px;padding:10px;border:1px solid #e0ddd5;font-size:13px';
    box.innerHTML = '<div style="font-weight:700">正式な見積書（テスト中）</div>';
    box.appendChild(field('件名', 'subject', defaultSubject(q)));
    box.appendChild(field('宛先の住所（任意）', 'address', '〒000-0000 …'));
    box.appendChild(field('お支払い条件', 'pay', '例：ご契約時に着手金50%、納品時に残金50%'));
    box.appendChild(field('納期', 'lead', '例：ご契約日より4〜5か月後'));
    box.appendChild(field('納品期限（任意）', 'due', '（要確認）'));
    box.appendChild(field('納品場所（任意）', 'place', '（要確認）'));
    box.appendChild(field('備考の追記（任意・1行ずつ）', 'note', '', true));
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-b';
    btn.id = 'fqBtn';
    btn.style.cssText = 'margin-top:8px';
    btn.textContent = '正式な見積書（PDF）';
    btn.onclick = function () { printQuote(q); };
    box.appendChild(btn);
    document.getElementById('compBody').appendChild(box);
    return r;
  };
  window.renderFormalQuote = render;   // 確かめ用
})();
