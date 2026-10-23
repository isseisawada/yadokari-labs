// 自治体ごとのトレーラーハウス公式情報を毎月自動で集める（管理表のスプレッドシートに付ける Apps Script）
// 使い方は同じフォルダの README.md

const SHEET_MASTER = '1_自治体マスタ';
const SHEET_LOG = '2_公式情報（クロール履歴）';
const MODEL = 'claude-haiku-5-5';
const BATCH_MS = 4.5 * 60 * 1000; // Apps Script は1回6分で止まるので、その手前で区切る
const MAX_PAGES = 3;
// shortcut: 本文は1ページ8,000字、PDFは800KBまでしかAIに渡さない。長い取扱基準集で見落とすなら上げる
const MAX_CHARS = 8000;
const MAX_PDF_BYTES = 800 * 1024;
const KANTO = ['08', '09', '10', '11', '12', '13', '14'];

// ---- メニュー ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('自動取得')
    .addItem('キーを登録', 'saveKeys')
    .addItem('関東で試運転', 'pilotKanto')
    .addItem('毎月の自動実行を開始', 'setup')
    .addToUi();
}

// キーは本人だけが見える「ユーザープロパティ」に入れる（スクリプトプロパティだと共有した編集者にも見える）
function saveKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();
  [['ANTHROPIC_API_KEY', 'Claude API キー'], ['BRAVE_API_KEY', 'Brave Search API キー'],
   ['SLACK_WEBHOOK_URL', 'Slack Webhook URL（まだ無ければ空のままOK）']].forEach(([k, label]) => {
    const r = ui.prompt(label, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) props.setProperty(k, r.getResponseText().trim());
  });
  ui.alert('登録しました');
}

// 30分ごとに tick を動かす。月が変わると自動で新しい回を始める
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(30).create();
  SpreadsheetApp.getActive().toast('30分ごとの自動実行を設定しました');
}

function pilotKanto() {
  const p = PropertiesService.getScriptProperties();
  p.setProperties({ RUN_MONTH: month_(), CURSOR: '0', PREFIXES: KANTO.join(',') });
  setup();
  tick();
}

// ---- 本体 ----

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const start = Date.now();
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('RUN_MONTH') !== month_()) p.setProperties({ RUN_MONTH: month_(), CURSOR: '0', PREFIXES: '' });
  let cursor = Number(p.getProperty('CURSOR'));
  if (cursor < 0) return lock.releaseLock();

  const keys = PropertiesService.getUserProperties();
  const ss = SpreadsheetApp.getActive();
  const master = ss.getSheetByName(SHEET_MASTER);
  const log = ss.getSheetByName(SHEET_LOG);
  const prefixes = (p.getProperty('PREFIXES') || '').split(',').filter(Boolean);
  const targets = targets_(master.getRange(2, 1, master.getLastRow() - 1, 5).getValues(), month_(), prefixes);
  const prev = lastRows_(log.getRange(2, 1, Math.max(log.getLastRow() - 1, 1), 19).getValues());

  try {
    while (cursor < targets.length && Date.now() - start < BATCH_MS) {
      const t = targets[cursor];
      const before = prev[t.code];
      const row = crawlOne_(t, before, keys);
      log.appendRow(row);
      prev[t.code] = row;
      if (!/^取得/.test(row[5])) master.getRange(t.row, 6, 1, 5).setValues([[row[5], row[10], row[11], row[13], row[0]]]);
      if (row[17] === '変更') slack_(keys, `【公式情報の変化】${t.pref}${place_(t)}：${before ? before[5] : 'なし'} → ${row[5]}\n${row[10]}\n${row[6]}`);
      cursor++;
      p.setProperty('CURSOR', String(cursor));
    }
    if (cursor >= targets.length) {
      p.setProperty('CURSOR', '-1');
      slack_(keys, `今月の公式情報の自動取得が終わりました（${targets.length}件）`);
    }
    p.deleteProperty('LAST_ERROR');
  } catch (e) {
    // 同じエラーは1回だけ通知。カーソルは進めないので、次の回に同じ自治体からやり直す
    if (p.getProperty('LAST_ERROR') !== String(e)) slack_(keys, `自動取得が止まりました：${e}`);
    p.setProperty('LAST_ERROR', String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function crawlOne_(t, prev, keys) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  const base = [today, "'" + t.code, t.pref, t.name, '公式ページ'];

  // 前回のページの本文が同じなら、検索もAIも使わずに「変化なし」
  const prevPage = prev && prev[6] ? fetchPage_(prev[6]) : null;
  if (prevPage && prevPage.ok && prev[16] && prevPage.hash === prev[16]) {
    return base.concat(prev.slice(5, 16), [prevPage.hash, '変化なし', '本文変化なし（自動）']);
  }

  const found = search_(t, keys.getProperty('BRAVE_API_KEY')).filter(u => !prevPage || u !== prevPage.url);
  const pages = (prevPage ? [prevPage] : []).concat(found.slice(0, MAX_PAGES - (prevPage ? 1 : 0)).map(fetchPage_));
  const ok = pages.filter(x => x.ok);
  if (!ok.length) {
    const status = !pages.length ? '未発見（要確認）' : pages.some(x => x.error === 'robots') ? '取得拒否（robots）' : '取得エラー';
    const memo = pages.map(x => `${x.url} ${x.error}`).join(' ／ ') || '検索で公式サイトのページが見つからず';
    // 取れなかっただけで見解が変わったわけではないので「変更」にはしない（マスタも書き換えない）
    return base.concat([status, '', '', '', '', '', '', '', '', '', '', '', prev ? '変化なし' : '新規', memo + '（自動）']);
  }

  const r = ask_(t, ok, keys.getProperty('ANTHROPIC_API_KEY'));
  const chosen = ok.find(x => x.url === r.url);
  return base.concat([r.status, r.url, r.kind, r.updated, r.title, r.summary, r.tendency, r.aobon, r.rev2026, r.dept,
    r.contact, chosen ? chosen.hash : '', judgeChange_(prev, r), (r.memo ? r.memo + '。' : '') + '自動取得']);
}

// ---- 判定（テストあり） ----

function targets_(rows, month, prefixes) {
  const quarterly = ['01', '04', '07', '10'].includes(month.slice(5));
  return rows.map((r, i) => ({ row: i + 2, code: String(r[0]).padStart(6, '0'), pref: r[1], name: r[2], kind: r[3], madoguchi: String(r[4]) }))
    .filter(t => !prefixes.length || prefixes.includes(t.code.slice(0, 2)))
    .filter(t => quarterly || isMonthly_(t));
}

// 建築物かを判断するのは都道府県と特定行政庁だけなので、そこは毎月。町村は四半期ごと
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
  return prev[5] !== r.status || (r.tendency !== undefined && prev[11] !== r.tendency) || (r.rev2026 !== undefined && prev[13] !== r.rev2026) ? '変更' : '変化なし';
}

function place_(t) {
  return /^（/.test(t.name) ? '' : t.name;
}

function isOfficial_(url) {
  const host = (String(url).match(/^https?:\/\/([^/:]+)/i) || [])[1] || '';
  return /\.lg\.jp$/.test(host) || /^(www\.)?(pref|city|town|vill)\.[a-z0-9.-]+\.jp$/.test(host);
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

function search_(t, key) {
  const where = t.pref + place_(t);
  const urls = [];
  [`${where} トレーラーハウス 建築物`, `${where} 車両を利用した工作物 コンテナ 建築確認`].forEach(q => {
    const res = UrlFetchApp.fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q), {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error(`検索API ${res.getResponseCode()}: ${res.getContentText().slice(0, 200)}`);
    ((JSON.parse(res.getContentText()).web || {}).results || []).forEach(x => {
      if (isOfficial_(x.url) && !urls.includes(x.url)) urls.push(x.url);
    });
  });
  return urls;
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
- updated: ページに書かれた更新日・発出日。`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'url', 'kind', 'updated', 'title', 'summary', 'tendency', 'aobon', 'rev2026', 'dept', 'contact', 'memo'],
  properties: {
    status: { type: 'string', enum: ['掲載あり', '掲載なし（確認済）', '未発見（要確認）'] },
    url: { type: 'string' }, kind: { type: 'string', enum: ['HTML', 'PDF', ''] }, updated: { type: 'string' },
    title: { type: 'string' }, summary: { type: 'string' },
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
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    payload: JSON.stringify({
      model: MODEL, max_tokens: 8000, system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error(`Claude API ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason !== 'end_turn') throw new Error(`Claude API の応答が途中で止まりました（${msg.stop_reason}）：${t.code}`);
  return JSON.parse(msg.content.find(b => b.type === 'text').text);
}

function slack_(keys, text) {
  const url = keys.getProperty('SLACK_WEBHOOK_URL');
  if (!url) return console.log(text);
  UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text }), muteHttpExceptions: true });
}

function month_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
}
