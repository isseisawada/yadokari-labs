// Code.gs の判定まわりを Node で確かめる： node jichitai-crawler/test.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8') + '\nthis.f = { robotsAllows_, htmlToText_, isOfficial_, isMonthly_, targets_, judgeChange_, lastRows_, crawlOne_ };', ctx);
const f = ctx.f;

// robots.txt
const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /cgi-bin/\nDisallow: /*.pdf$\nAllow: /cgi-bin/ok\n';
assert.ok(f.robotsAllows_(robots, '/kenchiku/trailer.html'));
assert.ok(!f.robotsAllows_(robots, '/cgi-bin/x'));
assert.ok(f.robotsAllows_(robots, '/cgi-bin/ok'));
assert.ok(!f.robotsAllows_(robots, '/docs/a.pdf'));
assert.ok(f.robotsAllows_(robots, '/docs/a.pdf?x=1'));
assert.ok(!f.robotsAllows_('User-agent: *\nDisallow: /', '/a'));
assert.ok(f.robotsAllows_('User-agent: *\nDisallow:', '/a'));
assert.ok(f.robotsAllows_('', '/a'));

// HTML → 本文
assert.strictEqual(f.htmlToText_('<html><script>x()</script><p>建築物&amp;工作物</p><br>電話&#12288;1</html>'), '建築物&工作物\n電話 1');

// 公式サイトかどうか
['https://www.city.kawasaki.jp/a', 'https://www.pref.kanagawa.jp/x.pdf', 'https://www.toshiseibi.metro.tokyo.lg.jp/k',
  'https://www.city.nasushiobara.tochigi.jp/a'].forEach(u => assert.ok(f.isOfficial_(u), u));
['https://www.trailerhouse.or.jp/topics/1822/', 'https://example.com/city.chiba.jp'].forEach(u => assert.ok(!f.isOfficial_(u), u));

// 対象の選び方：毎月は県・政令市・特別区・特定行政庁、四半期の月は町村も
const rows = [['080004', '茨城県', '（県）', '都道府県', '県'], ['082015', '茨城県', '水戸市', '市', '市（特定行政庁）'],
  ['082058', '茨城県', '石岡市', '市', '県（各県民センター）'], ['112160', '埼玉県', '羽生市', '市', '市（限定特定行政庁。それ以外は県）'],
  ['131016', '東京都', '千代田区', '特別区', '区']];
assert.deepStrictEqual([...f.targets_(rows, '2026-11', [])].map(t => t.code), ['080004', '082015', '112160', '131016']);
assert.strictEqual(f.targets_(rows, '2027-01', []).length, 5);
assert.deepStrictEqual([...f.targets_(rows, '2026-11', ['11'])].map(t => t.row), [5]);

// 変化の判定
const prev = Array(19).fill('');
prev[5] = '掲載あり'; prev[11] = '厳しい'; prev[13] = 'なし';
assert.strictEqual(f.judgeChange_(null, { status: '掲載あり' }), '新規');
assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '厳しい', rev2026: 'なし' }), '変化なし');
assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '厳しい', rev2026: 'あり' }), '変更');

// 履歴は団体コードごとに最後の行を使う
assert.strictEqual(f.lastRows_([['d', 82015, 'a'], ['d', '082015', 'b'], ['', '', '']])['082015'][2], 'b');

// 1自治体ぶんの行が19列になる（外部呼び出しは差し替え）
Object.assign(ctx, {
  Utilities: { formatDate: () => '2026/11/01' },
  fetchPage_: url => ({ url, ok: false, error: 'HTTP 404' }),
  search_: () => [],
});
vm.runInContext('fetchPage_ = this.fetchPage_; search_ = this.search_;', ctx);
const t = { code: '132047', pref: '東京都', name: '三鷹市' };
const p2 = Array(19).fill(''); p2[6] = 'https://www.city.mitaka.lg.jp/x.html'; p2[5] = '掲載なし（確認済）';
const r1 = f.crawlOne_(t, p2, { getProperty: () => '' });
assert.strictEqual(r1.length, 19);
assert.strictEqual(r1[5], '取得エラー');
assert.strictEqual(r1[17], '変化なし');
const r2 = f.crawlOne_(t, null, { getProperty: () => '' });
assert.strictEqual(r2[5], '未発見（要確認）');
assert.strictEqual(r2.length, 19);

// 本文が前回と同じなら、検索もAIも呼ばずに前回の内容を引き継ぐ
ctx.fetchPage_ = url => ({ url, ok: true, hash: 'h1', text: '' });
ctx.search_ = () => { throw new Error('検索を呼んではいけない'); };
vm.runInContext('fetchPage_ = this.fetchPage_; search_ = this.search_;', ctx);
const p3 = p2.slice(); p3[16] = 'h1'; p3[10] = '要旨';
const r3 = f.crawlOne_(t, p3, { getProperty: () => '' });
assert.strictEqual(r3.length, 19);
assert.deepStrictEqual([r3[5], r3[10], r3[16], r3[17]], ['掲載なし（確認済）', '要旨', 'h1', '変化なし']);

console.log('ok');
