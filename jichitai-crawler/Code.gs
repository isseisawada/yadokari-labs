// 自治体ごとのトレーラーハウス公式情報を毎月自動で集める（管理表のスプレッドシートに付ける Apps Script）
// 使い方は同じフォルダの README.md

const SHEET_MASTER = '1_自治体マスタ';
const SHEET_LOG = '2_公式情報（クロール履歴）';
const SHEET_HEARING = '3_ヒアリング履歴';
const MODEL = 'claude-haiku-5-5';
const BATCH_MS = 4.5 * 60 * 1000; // Apps Script は1回6分で止まるので、その手前で区切る
const MAX_PAGES = 3;
// shortcut: 本文は1ページ8,000字、PDFは800KBまでしかAIに渡さない。長い取扱基準集で見落とすなら上げる
const MAX_CHARS = 8000;
const MAX_PDF_BYTES = 800 * 1024;
const KANTO = ['08', '09', '10', '11', '12', '13', '14'];
// Brave の無料枠は月1,000件。1回（24日〜翌月23日）の検索をこの数までにして、町村は残りの枠で少しずつ回す
const SEARCH_CAP = 900;

// ---- メニュー ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('自動取得')
    .addItem('キーを登録', 'saveKeys')
    .addItem('関東で試運転', 'pilotKanto')
    .addItem('今すぐ調べる（無料枠の範囲で）', 'runAllNow')
    .addItem('毎月の自動実行を開始', 'setup')
    .addToUi();
}

// キーは本人だけが見える「ユーザープロパティ」に入れる（スクリプトプロパティだと共有した編集者にも見える）
function saveKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();
  [['ANTHROPIC_API_KEY', 'Claude API キー'], ['BRAVE_API_KEY', 'Brave Search API キー'],
   ['SLACK_WEBHOOK_URL', 'Slack Webhook URL（まだ無ければ空のままOK）'],
   ['SLACK_BOT_TOKEN', 'Slack Bot Token（xoxb- で始まるもの。ヒアリング取り込み用）'],
   ['HEARING_CHANNEL', 'ヒアリング用チャンネルのID（C で始まるもの）']].forEach(([k, label]) => {
    const r = ui.prompt(label, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) props.setProperty(k, r.getResponseText().trim());
  });
  ui.alert('登録しました');
}

// 30分ごとに tick を動かす。毎月24日になると自動で新しい回を始める
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(30).create();
  SpreadsheetApp.getActive().toast('30分ごとの自動実行を設定しました');
}

function pilotKanto() {
  startRun_(KANTO.join(','));
}

// 今の回を最初からやり直す（県・特定行政庁のあと、無料枠の残りで町村を前回の続きから）
function runAllNow() {
  startRun_('');
}

function startRun_(prefixes) {
  newRun_(PropertiesService.getScriptProperties(), prefixes);
  setup();
  tick();
}

function newRun_(p, prefixes) {
  p.setProperties({ RUN_MONTH: month_(), CURSOR: '0', PREFIXES: prefixes, SEARCHES: '0', TOWN_START: p.getProperty('TOWN_NEXT') || '0' });
}

// ---- 本体 ----

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const start = Date.now();
  const p = PropertiesService.getScriptProperties();
  const keys = PropertiesService.getUserProperties();
  const ss = SpreadsheetApp.getActive();
  const master = ss.getSheetByName(SHEET_MASTER);
  hearings_(p, keys, ss, master); // ヒアリングの取り込みと集計は毎回（公式情報の回が終わっていても）

  if (p.getProperty('RUN_MONTH') !== month_()) newRun_(p, '');
  let cursor = Number(p.getProperty('CURSOR'));
  if (cursor < 0) return lock.releaseLock();
  const log = ss.getSheetByName(SHEET_LOG);
  const prefixes = (p.getProperty('PREFIXES') || '').split(',').filter(Boolean);
  const townStart = Number(p.getProperty('TOWN_START') || 0);
  const { list: targets, monthly, towns } = targets_(master.getRange(2, 1, master.getLastRow() - 1, 6).getValues(), prefixes, townStart);
  const budget = { left: SEARCH_CAP - Number(p.getProperty('SEARCHES') || 0), used: () => p.setProperty('SEARCHES', String(SEARCH_CAP - budget.left)) };
  const prev = lastRows_(log.getRange(2, 1, Math.max(log.getLastRow() - 1, 1), 19).getValues());
  const changes = [];

  try {
    while (cursor < targets.length && Date.now() - start < BATCH_MS) {
      const t = targets[cursor];
      const before = prev[t.code];
      const row = crawlOne_(t, before, keys, budget);
      log.appendRow(row);
      prev[t.code] = row;
      if (!keepMaster_(t.current, row[5])) master.getRange(t.row, 6, 1, 5).setValues([[row[5], row[10], row[11], row[13], row[0]]]);
      if (row[17] === '変更') changes.push(changeLine_(t, before, row));
      cursor++;
      p.setProperty('CURSOR', String(cursor));
      if (cursor > monthly) p.setProperty('TOWN_NEXT', String((townStart + cursor - monthly) % towns));
    }
    if (cursor >= targets.length) {
      p.setProperty('CURSOR', '-1');
      slack_(keys, `今回の自動取得が終わりました（${targets.length}件）`);
    }
    p.deleteProperty('LAST_ERROR');
  } catch (e) {
    if (e.budget) {
      // 無料枠を使い切ったら今回はここまで。町村は次の回に続きから
      p.setProperty('CURSOR', '-1');
      const next = cursor < monthly ? '県・特定行政庁の残りから' : `町村は${(targets[cursor] || {}).name || ''}から`;
      slack_(keys, `無料枠の範囲で${cursor}件まで調べました。続きは次の24日に（${next}）`);
      return;
    }
    // 同じエラーは1回だけ通知。カーソルは進めないので、次の回に同じ自治体からやり直す
    if (p.getProperty('LAST_ERROR') !== String(e)) slack_(keys, `自動取得が止まりました：${e}`);
    p.setProperty('LAST_ERROR', String(e));
    throw e;
  } finally {
    // 変化は30分ごとの回でまとめて1通
    if (changes.length) slack_(keys, `公式情報の変化 ${changes.length}件（<${ss.getUrl()}|管理表を開く>）\n` + changes.join('\n'));
    lock.releaseLock();
  }
}

// 通知の1行：・【要確認】神奈川県厚木市　掲載あり → 掲載なし｜継続使用なら建築物 <URL|ページ>
function changeLine_(t, before, row) {
  const short = x => String(x || 'なし').replace(/（.*）$/, '');
  const warn = t.current === '掲載あり' && row[5] !== '掲載あり' ? '【要確認】' : '';
  return `・${warn}${t.pref}${place_(t)}　${short(before && before[5])} → ${short(row[5])}${row.oneline ? '｜' + row.oneline : ''}` + (row[6] ? ` <${row[6]}|ページ>` : '');
}

function crawlOne_(t, prev, keys, budget) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  const base = [today, "'" + t.code, t.pref, t.name, '公式ページ'];

  // 前回のページの本文が同じなら、検索もAIも使わずに「変化なし」
  const prevPage = prev && prev[6] ? fetchPage_(prev[6]) : null;
  if (prevPage && prevPage.ok && prev[16] && prevPage.hash === prev[16]) {
    return base.concat(prev.slice(5, 16), [prevPage.hash, '変化なし', '本文変化なし（自動）']);
  }

  let found = search_(t, keys.getProperty('BRAVE_API_KEY'), budget).filter(u => !prevPage || u !== prevPage.url);
  // 見つからなければ、基準総則の言い方でもう1回だけ探す
  if (!found.length && !prevPage) found = search_(t, keys.getProperty('BRAVE_API_KEY'), budget, `${t.pref}${place_(t)} 車両を利用した工作物 建築基準法`);
  const pages = (prevPage ? [prevPage] : []).concat(found.slice(0, MAX_PAGES - (prevPage ? 1 : 0)).map(fetchPage_));
  const ok = pages.filter(x => x.ok);
  if (!ok.length) {
    const status = !pages.length ? '未発見（要確認）' : pages.some(x => x.error === 'robots') ? '取得拒否（robots）' : '取得エラー';
    const memo = pages.map(x => `${x.url} ${x.error}`).join(' ／ ') || '検索で公式サイトのページが見つからず';
    // 取れなかっただけで見解が変わったわけではないので「変更」にはしない（マスタも書き換えない）
    return base.concat([status, '', '', '', '', '', '', '', '', '', '', '', prev ? '変化なし' : '新規', memo + '（自動）']);
  }

  let r = ask_(t, ok, keys.getProperty('ANTHROPIC_API_KEY'));
  const chosen = ok.find(x => x.url === r.url);
  // AIが他の自治体のページを根拠にしたら採らない
  if (r.status !== '未発見（要確認）' && !(chosen && isOwn_(t, chosen))) {
    r = { status: '未発見（要確認）', url: '', kind: '', updated: '', title: '', summary: '', tendency: '', aobon: '', rev2026: '', dept: '', contact: '',
      memo: `他の自治体のページを根拠にしていたため不採用（${r.url || 'URLなし'}）` };
  }
  // コンテナだけのページを「掲載あり」にしてくることがあるので、本文に語が無ければ「掲載なし」に直す
  if (r.status === '掲載あり' && chosen && !chosen.pdf && !/トレーラー|車両を利用/.test(chosen.text)) {
    r = Object.assign({}, r, { status: '掲載なし（確認済）', memo: 'ページにトレーラーハウス・車両を利用した工作物の語が無いため掲載なしに直した。' + r.memo });
  }
  if (t.current === '掲載あり' && r.status !== '掲載あり') {
    r = Object.assign({}, r, { memo: '要確認：マスタは掲載ありのまま。人が確かめて直す。' + r.memo });
  }
  const row = base.concat([r.status, r.url, r.kind, r.updated, r.title, r.summary, r.tendency, r.aobon, r.rev2026, r.dept,
    r.contact, r.url && chosen ? chosen.hash : '', judgeChange_(prev, r), (r.memo ? r.memo.replace(/。+$/, '') + '。' : '') + '自動取得']);
  row.oneline = r.oneline; // Slack 通知用（シートには書かない）
  return row;
}

// ---- 判定（テストあり） ----

// 県・特定行政庁を先に全部、そのあと町村を townStart から一周ぶん並べる（試運転で県を絞ったときは町村なし）
function targets_(rows, prefixes, townStart) {
  const all = rows.map((r, i) => ({ row: i + 2, code: String(r[0]).padStart(6, '0'), pref: r[1], name: r[2], kind: r[3], madoguchi: String(r[4]), current: String(r[5] || '') }))
    .filter(t => !prefixes.length || prefixes.includes(t.code.slice(0, 2)));
  const monthly = all.filter(isMonthly_);
  const towns = prefixes.length ? [] : all.filter(t => !isMonthly_(t));
  const s = towns.length ? townStart % towns.length : 0;
  return { list: monthly.concat(towns.slice(s), towns.slice(0, s)), monthly: monthly.length, towns: towns.length };
}

// 建築物かを判断するのは都道府県と特定行政庁だけなので、そこは毎回。町村は無料枠の残りで
function isMonthly_(t) {
  return ['都道府県', '政令市', '特別区'].includes(t.kind) || /特定行政庁/.test(t.madoguchi);
}

function lastRows_(values) {
  const m = {};
  values.forEach(r => { if (r[1] !== '') m[String(r[1]).padStart(6, '0')] = r; });
  return m;
}

function judgeChange_(prev, r) {
  if (!prev) return '新規';
  // 前回は見つかっていたのに今回見つからないのは、サイトの障害や検索の揺れが多いので変化扱いしない
  if (r.status === '未発見（要確認）' && isFound_(prev[5])) return '変化なし';
  // 判断の傾向は付け方が揺れるので比べない。AIが空欄で返した項目も比べない
  const differs = (a, b) => a !== '' && b !== '' && a !== b;
  return prev[5] !== r.status || differs(prev[13], r.rev2026) ? '変更' : '変化なし';
}

// マスタを書き換えないとき：取得できなかった／前は見つかっていたのに見つからない／「掲載あり」がAIの判定だけで外れる
function keepMaster_(current, status) {
  return /^取得/.test(status) || (status === '未発見（要確認）' && isFound_(current)) || (current === '掲載あり' && status !== '掲載あり');
}

function isFound_(status) {
  return /^掲載/.test(status);
}

// 根拠のページがその自治体のものか：県は県（都）のサイト、市区町村はページに自治体名がある
function isOwn_(t, page) {
  const host = (page.url.match(/^https?:\/\/([^/:]+)/i) || [])[1] || '';
  if (!place_(t)) return /(^|\.)(pref\.|metro\.tokyo)/.test(host);
  return page.pdf ? true : String(page.text).includes(t.name);
}

function place_(t) {
  return /^（/.test(t.name) ? '' : t.name;
}

function isOfficial_(url) {
  const host = (String(url).match(/^https?:\/\/([^/:]+)/i) || [])[1] || '';
  return /\.lg\.jp$/.test(host) || /^(www\.)?(pref|city|town|vill)\.[a-z0-9.-]+\.jp$/.test(host);
}

// 検索結果がその自治体についてのものか（他の自治体のページを除く）
function isAbout_(t, x) {
  if (!place_(t)) return /^https?:\/\/([^/]*\.)?(pref\.|metro\.tokyo)/i.test(x.url) && String(x.title + x.description).includes(t.pref);
  return String(x.title + x.description).includes(t.name);
}

function robotsAllows_(txt, path) {
  const groups = [];
  let g = null, lastWasAgent = false;
  String(txt).split(/\r?\n/).forEach(raw => {
    const m = raw.replace(/#.*/, '').trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent) groups.push(g = { agents: [], rules: [] });
      g.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (g && (k === 'allow' || k === 'disallow') && v) g.rules.push({ allow: k === 'allow', p: v });
    }
  });
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let best = null;
  groups.filter(x => x.agents.includes('*')).forEach(x => x.rules.forEach(r => {
    const re = new RegExp('^' + r.p.replace(/\$$/, '').split('*').map(esc).join('.*') + (r.p.endsWith('$') ? '$' : ''));
    if (re.test(path) && (!best || r.p.length > best.p.length || (r.p.length === best.p.length && r.allow))) best = r;
  }));
  return !best || best.allow;
}

function htmlToText_(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// ---- 外部とのやりとり ----

// 無料枠に収めるため、検索は1団体1回
function search_(t, key, budget, q = `${t.pref}${place_(t)} トレーラーハウス 建築物`) {
  if (budget.left <= 0) throw Object.assign(new Error('今回の検索の上限に達しました'), { budget: true });
  const res = UrlFetchApp.fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q), {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, muteHttpExceptions: true,
  });
  budget.left--;
  budget.used();
  const code = res.getResponseCode();
  // 402・429 は残高（無料枠）切れ。先払いで残高0なので、お金はかからず止まるだけ
  if (code === 402 || code === 429) throw Object.assign(new Error(`検索APIの無料枠を使い切りました（${code}）`), { budget: true });
  if (code !== 200) throw new Error(`検索API ${code}: ${res.getContentText().slice(0, 200)}`);
  return ((JSON.parse(res.getContentText()).web || {}).results || [])
    .filter(x => isOfficial_(x.url) && isAbout_(t, x)).map(x => x.url);
}

function fetchPage_(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)(\/[^#]*)?/i);
  if (!m) return { url, ok: false, error: 'URL不正' };
  const cache = CacheService.getScriptCache();
  let robots = cache.get('robots:' + m[1]);
  if (robots === null) {
    try {
      const r = UrlFetchApp.fetch(m[1] + '/robots.txt', { muteHttpExceptions: true });
      robots = r.getResponseCode() === 200 ? r.getContentText().slice(0, 90000) : '';
    } catch (e) { robots = ''; }
    cache.put('robots:' + m[1], robots, 21600);
  }
  if (!robotsAllows_(robots, m[2] || '/')) return { url, ok: false, error: 'robots' };

  let res;
  try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }); } catch (e) { return { url, ok: false, error: String(e).slice(0, 100) }; }
  if (res.getResponseCode() !== 200) return { url, ok: false, error: 'HTTP ' + res.getResponseCode() };
  const type = header_(res, 'Content-Type');
  if (/pdf/i.test(type) || /\.pdf$/i.test(url)) {
    const bytes = res.getContent();
    if (bytes.length > MAX_PDF_BYTES) return { url, ok: true, hash: md5_(bytes), text: `（PDF ${Math.round(bytes.length / 1024)}KB。大きいため本文は渡していない）` };
    return { url, ok: true, hash: md5_(bytes), pdf: Utilities.base64Encode(bytes) };
  }
  const text = htmlToText_(decode_(res, type));
  return { url, ok: true, hash: md5_(text), text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n（以下省略）' : text };
}

// 自治体サイトは Shift_JIS がまだ多いので、文字コードを見て読む
function decode_(res, type) {
  let cs = (type.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (res.getContentText('ISO-8859-1').slice(0, 3000).match(/charset=["']?([\w-]+)/i) || [])[1];
  try { return res.getContentText(cs || 'UTF-8'); } catch (e) { return res.getContentText('UTF-8'); }
}

function header_(res, name) {
  const h = res.getAllHeaders();
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? String(h[k]) : '';
}

function md5_(v) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, v).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

const SYSTEM = `あなたは日本の自治体の建築行政を調べる担当者です。指定された自治体が、トレーラーハウス（車両を利用した工作物）を建築基準法上どう扱っているかを、渡された公式ページだけから読み取ります。推測で埋めず、ページに書いていないことは空欄にします。

判定のルール:
- status
  - 「掲載あり」: 指定された自治体自身のページに、トレーラーハウスか「車両を利用した工作物」の扱いが書いてある。県や協議会の基準に従うと明記し、その基準が渡されている場合も含む。
  - 「掲載なし（確認済）」: 指定された自治体の建築指導・建築確認系のページが渡されていて、トレーラーハウス・車両の記載がない。コンテナや建築物の一般定義だけのページもこれにし、memoに「コンテナの扱いあり」などと書く。
  - 「未発見（要確認）」: 指定された自治体のページが1つも無い、または関係のないページしか無い。
- 他の自治体のページは判定に使わない（memoに書くのはよい）。
- url: 判定の根拠にしたページのURL（渡されたURLのどれか）。無ければ空欄。
- tendency: 「基準総則どおり」（随時かつ任意に移動できなければ建築物、という国の基準どおり）、「厳しい」（常設目的・住所が必要・車検必須など、国の基準より広く建築物とみなす）、「個別判断」（ケースごとに判断と書いている）、判断できなければ空欄。
- aobon: 「建築確認のための基準総則・集団規定の適用事例」（青本）への言及があれば「あり」。
- rev2026: 青本の2026年度版（改訂版）への言及があれば「あり」。
- summary: 判断基準の要旨を1〜2文で。
- oneline: 通知用のひとこと。25字以内で、結論だけ（例：「継続使用なら建築物」「車検ありなら車両扱い」「トレーラーハウスの記載なし」）。
- updated: ページに書かれた更新日・発出日。YYYY/MM/DD の形で。
- サイトの障害表示・メンテナンス表示しか無いときは「未発見（要確認）」にし、memoにそう書く。`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'url', 'kind', 'updated', 'title', 'summary', 'oneline', 'tendency', 'aobon', 'rev2026', 'dept', 'contact', 'memo'],
  properties: {
    status: { type: 'string', enum: ['掲載あり', '掲載なし（確認済）', '未発見（要確認）'] },
    url: { type: 'string' }, kind: { type: 'string', enum: ['HTML', 'PDF', ''] }, updated: { type: 'string' },
    title: { type: 'string' }, summary: { type: 'string' }, oneline: { type: 'string' },
    tendency: { type: 'string', enum: ['基準総則どおり', '厳しい', '個別判断', ''] },
    aobon: { type: 'string', enum: ['あり', 'なし', ''] }, rev2026: { type: 'string', enum: ['あり', 'なし', ''] },
    dept: { type: 'string' }, contact: { type: 'string' }, memo: { type: 'string' },
  },
};

function ask_(t, pages, key) {
  const content = [];
  pages.forEach((x, i) => {
    content.push({ type: 'text', text: `【ページ${i + 1}】${x.url}` + (x.text ? '\n' + x.text : '') });
    if (x.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: x.pdf } });
  });
  content.push({ type: 'text', text: `調べる自治体：${t.pref}${place_(t) || '（県）'}（団体コード ${t.code}）` });
  return claudeJson_(SYSTEM, SCHEMA, content, key, t.code);
}

function claudeJson_(system, schema, content, key, label) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    payload: JSON.stringify({
      model: MODEL, max_tokens: 8000, system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error(`Claude API ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason !== 'end_turn') throw new Error(`Claude API の応答が途中で止まりました（${msg.stop_reason}）：${label}`);
  return JSON.parse(msg.content.find(b => b.type === 'text').text);
}

function slack_(keys, text) {
  const url = keys.getProperty('SLACK_WEBHOOK_URL');
  if (!url) return console.log(text);
  UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text }), muteHttpExceptions: true });
}

// ---- ヒアリング（Slack の投稿を取り込み、管理表の 3_ヒアリング履歴 に記録） ----

function hearings_(p, keys, ss, master) {
  const sheet = ss.getSheetByName(SHEET_HEARING);
  const masterRows = master.getRange(2, 1, master.getLastRow() - 1, 4).getValues();
  try {
    if (keys.getProperty('SLACK_BOT_TOKEN') && keys.getProperty('HEARING_CHANNEL')) intakeSlack_(p, keys, sheet, masterRows, ss.getUrl() + '#gid=' + sheet.getSheetId());
    p.deleteProperty('LAST_ERROR_H');
  } catch (e) {
    if (p.getProperty('LAST_ERROR_H') !== String(e)) slack_(keys, `ヒアリングの取り込みが止まりました：${e}`);
    p.setProperty('LAST_ERROR_H', String(e));
  }
  // 管理表に直接書かれた行にも団体コードを付け、マスタの集計（K〜N列）を計算し直す
  const n = lastRow_(sheet) - 1;
  if (n < 1) return;
  const rows = sheet.getRange(2, 1, n, 22).getValues();
  const codes = rows.map(r => [r[20] !== '' ? r[20] : (r[2] || r[3] ? codeOf_(masterRows, r[2], r[3]) : '')]);
  sheet.getRange(2, 21, n, 1).setNumberFormat('@').setValues(codes);
  rows.forEach((r, i) => { r[20] = codes[i][0]; });
  master.getRange(2, 11, masterRows.length, 4).setValues(hearingSummary_(rows, masterRows.map(r => String(r[0]).padStart(6, '0'))));
}

function intakeSlack_(p, keys, sheet, masterRows, sheetUrl) {
  const ch = keys.getProperty('HEARING_CHANNEL');
  const pending = JSON.parse(p.getProperty('HEARING_PENDING') || '{}'); // 聞き返し中：投稿ts → 最後に見た返信ts
  const ask = (ts, missing) => {
    const msg = missing.length
      ? `おおきに！記録しときました。あと「${missing.join('」「')}」だけ教えてもらえます？このスレッドに返信してもろたら追記しときます。`
      : `おおきに！<${sheetUrl}|管理表>に記録しときました。`;
    return slackApi_(keys, 'chat.postMessage', { channel: ch, thread_ts: ts, text: msg }).ts;
  };

  // 聞き返したスレッドに返信が来ていたら、元の投稿と合わせて読み直す
  Object.keys(pending).forEach(ts => {
    const msgs = (slackApi_(keys, 'conversations.replies', { channel: ch, ts }).messages || []).filter(m => !m.bot_id);
    const fresh = msgs.filter(m => m.ts !== ts && Number(m.ts) > Number(pending[ts]));
    if (!fresh.length) return;
    const missing = recordHearing_(sheet, masterRows, keys, ch, msgs[0], msgs.map(m => m.text).join('\n'));
    ask(ts, missing);
    if (missing.length) pending[ts] = fresh[fresh.length - 1].ts; else delete pending[ts];
  });

  // 新しい投稿
  const msgs = (slackApi_(keys, 'conversations.history', { channel: ch, oldest: p.getProperty('HEARING_TS') || '0', limit: 100 }).messages || [])
    .filter(m => !m.bot_id && (!m.subtype || m.subtype === 'file_share') && (!m.thread_ts || m.thread_ts === m.ts))
    .filter(m => !isNotice_(m.text))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  msgs.forEach(m => {
    const missing = recordHearing_(sheet, masterRows, keys, ch, m, m.text);
    if (missing) {
      const asked = ask(m.ts, missing);
      if (missing.length) pending[m.ts] = asked;
    }
    p.setProperty('HEARING_TS', m.ts);
  });
  p.setProperty('HEARING_PENDING', JSON.stringify(pending));
}

// 1件を整理して記録（同じ投稿の行があれば上書き）。足りない項目を返す。ヒアリングでない投稿は null
function recordHearing_(sheet, masterRows, keys, ch, root, text) {
  const posted = Utilities.formatDate(new Date(Number(root.ts) * 1000), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  const h = claudeJson_(SYSTEM_H, SCHEMA_H, [{ type: 'text', text: `投稿日時：${posted}\n---\n${text}` }], keys.getProperty('ANTHROPIC_API_KEY'), 'ヒアリング');
  if (!isHearing_(h)) return null;
  const user = slackApi_(keys, 'users.info', { user: root.user }).user || {};
  const link = slackApi_(keys, 'chat.getPermalink', { channel: ch, message_ts: root.ts }).permalink || '';
  const missing = missingOf_(h);
  const id = 'slack-' + root.ts;
  const row = [id, h.date || posted, h.pref, h.city, '電話ヒアリング（参考意見）', h.dept, h.phone, h.contact, nameOf_(user), h.case, h.usage,
    h.q1_raw, h.conclusion + (h.conclusion_note ? `（${h.conclusion_note}）` : ''), h.q2, h.q3, h.q4, h.other, h.rev2026, '', link,
    codeOf_(masterRows, h.pref, h.city), missing.length ? '未記入：' + missing.join('、') : ''];
  const last = lastRow_(sheet);
  const at = sheet.getRange(2, 1, Math.max(last - 1, 1), 1).getValues().findIndex(r => r[0] === id);
  const range = sheet.getRange(at >= 0 ? at + 2 : last + 1, 1, 1, 22);
  range.offset(0, 20, 1, 1).setNumberFormat('@'); // 団体コードの先頭の0を残す
  range.setValues([row]);
  return missing;
}

// A列（記録ID）が入っている最後の行。getLastRow は空に見える行まで数えることがあり、追記が離れた行に飛ぶため
function lastRow_(sheet) {
  const a = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  let i = a.length;
  while (i > 1 && a[i - 1][0] === '') i--;
  return i;
}

// グループ宛て（@channel・@here・ユーザーグループ）や「【お知らせ】」の投稿は、ヒアリングのメモではない
function isNotice_(text) {
  return /<!(channel|here|everyone|subteam\^)/.test(text || '') || /^[\s*_]*【お知らせ】/.test(String(text || '').replace(/<[@!][^>]*>/g, ''));
}

// 通知と同じチャンネルなので、雑談（自治体名も役所の回答も無い投稿）は取り込まない
function isHearing_(h) {
  return !!((h.pref || h.city) || h.q1_raw);
}

function missingOf_(h) {
  return [['自治体', h.pref || h.city], ['相談先の課', h.dept], ['先方の担当者名', h.contact], ['対象案件', h.case],
    ['結論（車両扱いでよいか）', h.conclusion && h.conclusion !== '不明']].filter(x => !x[1]).map(x => x[0]);
}

// Slack の表示名から漢字の部分を取る（例「Michiko Endo / 遠藤美智子 / 月曜休み」→「遠藤美智子」）
function nameOf_(user) {
  const parts = String(user.real_name || user.name || '').split('/').map(x => x.trim());
  return parts.find(x => /[一-鿿]/.test(x)) || parts[0] || '';
}

// 都道府県＋市区町村名からマスタの団体コードを探す（郡名・県庁などの揺れを吸収。1つに決まらなければ空欄）
function codeOf_(masterRows, pref, city) {
  const c = String(city || '').replace(/\s/g, '').replace(/^.+?郡/, '');
  const isPref = !c || /^(県庁|都庁|府庁|道庁|県|都|府|道)$/.test(c);
  const hits = masterRows.filter(r => (!pref || r[1] === pref) && (isPref ? r[3] === '都道府県' : r[2] === c));
  return hits.length === 1 ? String(hits[0][0]).padStart(6, '0') : '';
}

// マスタの K〜N 列（ヒアリング件数／最新日／最新の結論／見解の変化）を団体コードごとに計算
function hearingSummary_(rows, codes) {
  const by = {};
  rows.forEach(r => {
    const code = String(r[20] || '').padStart(6, '0');
    if (!r[20]) return;
    const d = Object.prototype.toString.call(r[1]) === '[object Date]' ? Utilities.formatDate(r[1], 'Asia/Tokyo', 'yyyy/MM/dd') : String(r[1]); // シートの日付はDateで返る
    const m = d.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    (by[code] = by[code] || []).push({ date: m ? `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : '', concl: String(r[12] || '') });
  });
  const head = x => x.split('（')[0];
  return codes.map(code => {
    const list = by[code];
    if (!list) return ['', '', '', ''];
    const dated = list.filter(x => x.date).sort((a, b) => a.date < b.date ? -1 : 1);
    const last = dated[dated.length - 1] || list[list.length - 1];
    const before = dated[dated.length - 2];
    const change = before && head(before.concl) !== head(last.concl) ? `変化あり（前回 ${before.date}「${before.concl}」）` : '';
    return [list.length, last.date, last.concl, change];
  });
}

function slackApi_(keys, method, params) {
  const token = keys.getProperty('SLACK_BOT_TOKEN');
  const res = method === 'chat.postMessage'
    ? UrlFetchApp.fetch('https://slack.com/api/' + method, { method: 'post', contentType: 'application/json; charset=utf-8', payload: JSON.stringify(params), headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true })
    : UrlFetchApp.fetch('https://slack.com/api/' + method + '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&'), { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

const SYSTEM_H = `営業担当が役所に電話でヒアリングした内容のメモ（自由文）から、項目を抜き出します。メモに書いていないことは空欄にし、推測で埋めません。

- date: メモに相談日時があれば YYYY/MM/DD HH:mm（時刻が無ければ YYYY/MM/DD）。年が無ければ投稿日時の年から決める。メモに無ければ空欄。
- pref / city: 都道府県名と市区町村名（「県庁」など県に聞いた場合は city を空欄）。
- dept: 相談先の課。phone: 電話番号。contact: 先方の担当者名。case: 対象案件（案件名・お客様名など）。usage: 用途・設置条件（用途地域・市街化調整区域・自然公園など）。
- q1_raw: 「トレーラーハウスを車両扱い（建築物でない扱い）にしてよいか」への役所の回答を、メモの言葉に近い形で。
- conclusion: その結論を「可」「条件付き可」「不可」「個別判断」「不明」から。conclusion_note: 条件を20字以内で（例：一時設置のみ、車検必須）。無ければ空欄。
- q2: 建築物扱いになるケース。q3: 自治体独自のルール。q4: 浄化槽の扱い。other: その他・備考。
- rev2026: 青本（基準総則・集団規定の適用事例）の2026年度版・改訂の話が出ていれば「あり」、無ければ空欄。`;

const SCHEMA_H = {
  type: 'object', additionalProperties: false,
  required: ['date', 'pref', 'city', 'dept', 'phone', 'contact', 'case', 'usage', 'q1_raw', 'conclusion', 'conclusion_note', 'q2', 'q3', 'q4', 'other', 'rev2026'],
  properties: Object.assign(
    ...['date', 'pref', 'city', 'dept', 'phone', 'contact', 'case', 'usage', 'q1_raw', 'conclusion_note', 'q2', 'q3', 'q4', 'other'].map(k => ({ [k]: { type: 'string' } })),
    { conclusion: { type: 'string', enum: ['可', '条件付き可', '不可', '個別判断', '不明'] }, rev2026: { type: 'string', enum: ['あり', ''] } }),
};

// 回の区切りは毎月24日。24日〜翌月23日を、24日のある月の回として数える
function month_() {
  return Utilities.formatDate(new Date(Date.now() - 23 * 24 * 3600 * 1000), 'Asia/Tokyo', 'yyyy-MM');
}
