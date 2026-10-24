// Code.gs の判定まわりを Node で確かめる： node jichitai-crawler/test.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8') + '\nthis.f = { robotsAllows_, htmlToText_, isOfficial_, isMonthly_, targets_, judgeChange_, lastRows_, crawlOne_, isOwn_, isAbout_, keepMaster_, changeLine_, codeOf_, missingOf_, nameOf_, hearingSummary_, isHearing_ };', ctx);
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
// 対象の並び：県・特定行政庁が先、町村はそのあとに townStart から一周
const rows2 = rows.concat([['082074', '茨城県', '結城市', '市', '県'], ['082082', '茨城県', '龍ケ崎市', '市', '県']]);
const all0 = f.targets_(rows2, [], 0);
assert.deepStrictEqual([...all0.list].map(t => t.code), ['080004', '082015', '112160', '131016', '082058', '082074', '082082']);
assert.deepStrictEqual([all0.monthly, all0.towns], [4, 3]);
assert.deepStrictEqual([...f.targets_(rows2, [], 2).list].slice(4).map(t => t.code), ['082082', '082058', '082074']);
assert.deepStrictEqual([...f.targets_(rows2, [], 5).list].slice(4).map(t => t.code), ['082082', '082058', '082074']); // 一周を超えても回る
const kanto08 = f.targets_(rows2, ['08'], 0); // 試運転は町村を含めない
assert.deepStrictEqual([kanto08.list.length, kanto08.towns], [2, 0]);
assert.deepStrictEqual([...f.targets_(rows2, ['11'], 0).list].map(t => t.row), [5]);

// 変化の判定
const prev = Array(19).fill('');
prev[5] = '掲載あり'; prev[11] = '厳しい'; prev[13] = 'なし';
assert.strictEqual(f.judgeChange_(null, { status: '掲載あり' }), '新規');
assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '厳しい', rev2026: 'なし' }), '変化なし');
assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '厳しい', rev2026: 'あり' }), '変更');

assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '', rev2026: '' }), '変化なし'); // 空欄は比べない
assert.strictEqual(f.judgeChange_(prev, { status: '未発見（要確認）', tendency: '', rev2026: '' }), '変化なし'); // 見つからなかっただけ
assert.strictEqual(f.judgeChange_(prev, { status: '掲載なし（確認済）', tendency: '', rev2026: '' }), '変更');

// その自治体のページかどうか
const takahagi = { code: '082147', pref: '茨城県', name: '高萩市' };
const ibaraki = { code: '080004', pref: '茨城県', name: '（県）' };
assert.ok(!f.isOwn_(takahagi, { url: 'https://www.city.sendai.jp/x.html', text: 'トレーラーハウス｜仙台市' }));
assert.ok(f.isOwn_(takahagi, { url: 'https://www.city.takahagi.ibaraki.jp/x.html', text: '建築確認申請｜高萩市' }));
assert.ok(f.isOwn_(ibaraki, { url: 'https://www.pref.ibaraki.jp/a.pdf', pdf: 'x' }));
assert.ok(!f.isOwn_(ibaraki, { url: 'https://www.city.mito.lg.jp/a.html', text: '茨城県水戸市' }));
assert.ok(!f.isAbout_(takahagi, { url: 'https://www.city.sendai.jp/x', title: 'トレーラーハウス｜仙台市', description: '' }));
assert.ok(f.isAbout_(takahagi, { url: 'https://www.city.takahagi.ibaraki.jp/x', title: '建築確認', description: '高萩市の建築' }));
assert.ok(f.isAbout_(ibaraki, { url: 'https://www.pref.ibaraki.jp/x', title: '建築指導課｜茨城県', description: '' }));

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

// AIが他の自治体のページを根拠にしたら「未発見」に差し替える
ctx.fetchPage_ = url => ({ url, ok: true, hash: 'h9', text: 'トレーラーハウス｜仙台市' });
ctx.search_ = () => ['https://www.city.sendai.jp/x.html'];
ctx.ask_ = () => ({ status: '掲載あり', url: 'https://www.city.sendai.jp/x.html', kind: 'HTML', updated: '', title: '', summary: '仙台の要旨',
  tendency: '個別判断', aobon: '', rev2026: '', dept: '', contact: '', memo: '仙台市。' });
vm.runInContext('fetchPage_ = this.fetchPage_; search_ = this.search_; ask_ = this.ask_;', ctx);
const r4 = f.crawlOne_(takahagi, null, { getProperty: () => '' });
assert.strictEqual(r4.length, 19);
assert.deepStrictEqual([r4[5], r4[6], r4[10], r4[16]], ['未発見（要確認）', '', '', '']);
assert.ok(r4[18].startsWith('他の自治体のページを根拠にしていたため不採用'));

// コンテナだけのページで「掲載あり」と返ってきたら「掲載なし（確認済）」に直す
const koga = { code: '082040', pref: '茨城県', name: '古河市' };
ctx.fetchPage_ = url => ({ url, ok: true, hash: 'k1', text: 'コンテナを利用した倉庫について｜古河市' });
ctx.ask_ = () => ({ status: '掲載あり', url: 'https://www.city.ibaraki-koga.lg.jp/a.html', kind: 'HTML', updated: '', title: '', summary: 'コンテナは建築物',
  tendency: '基準総則どおり', aobon: 'なし', rev2026: 'なし', dept: '', contact: '', memo: 'コンテナの扱いあり' });
ctx.search_ = () => ['https://www.city.ibaraki-koga.lg.jp/a.html'];
vm.runInContext('fetchPage_ = this.fetchPage_; search_ = this.search_; ask_ = this.ask_;', ctx);
const p5 = Array(19).fill(''); p5[5] = '掲載なし（確認済）'; p5[13] = 'なし';
const r5 = f.crawlOne_(koga, p5, { getProperty: () => '' });
assert.deepStrictEqual([r5[5], r5[17]], ['掲載なし（確認済）', '変化なし']);

// 「掲載あり」はAIの判定だけでは外さない
assert.ok(f.keepMaster_('掲載あり', '掲載なし（確認済）'));
assert.ok(f.keepMaster_('掲載なし（確認済）', '未発見（要確認）'));
assert.ok(f.keepMaster_('', '取得エラー'));
assert.ok(!f.keepMaster_('掲載なし（確認済）', '掲載あり'));
assert.ok(!f.keepMaster_('未発見（要確認）', '掲載なし（確認済）'));
// 「公用車両」のような別の意味の「車両」では掲載ありにしない
ctx.fetchPage_ = url => ({ url, ok: true, hash: 'k2', text: 'コンテナ倉庫｜古河市 公用車両の売却' });
vm.runInContext('fetchPage_ = this.fetchPage_;', ctx);
assert.strictEqual(f.crawlOne_(koga, p5, { getProperty: () => '' })[5], '掲載なし（確認済）');
const r6 = f.crawlOne_(Object.assign({ current: '掲載あり' }, koga), null, { getProperty: () => '' });
assert.ok(r6[18].startsWith('要確認'));

// 検索の上限に達していたら、検索せずに止まる
const realSearch = vm.runInContext('(function(){ ' + fs.readFileSync(__dirname + '/Code.gs', 'utf8').match(/function search_[\s\S]*?\n}\n/)[0] + ' return search_; })()', ctx);
assert.throws(() => realSearch({ pref: '茨城県', name: '水戸市' }, 'k', { left: 0, used: () => {} }), e => e.budget === true);

// 判断の傾向だけの違いは「変更」にしない
assert.strictEqual(f.judgeChange_(prev, { status: '掲載あり', tendency: '基準総則どおり', rev2026: 'なし' }), '変化なし');

// 通知の1行
const atsugi = { pref: '神奈川県', name: '厚木市', current: '掲載あり' };
const crow = Array(19).fill(''); crow[5] = '掲載なし（確認済）'; crow[6] = 'https://www.city.atsugi.kanagawa.jp/a.html'; crow.oneline = '継続使用なら建築物';
assert.strictEqual(f.changeLine_(atsugi, ['', '', '', '', '', '掲載あり'], crow),
  '・【要確認】神奈川県厚木市　掲載あり → 掲載なし｜継続使用なら建築物 <https://www.city.atsugi.kanagawa.jp/a.html|ページ>');
const crow2 = Array(19).fill(''); crow2[5] = '掲載なし（確認済）';
assert.strictEqual(f.changeLine_({ pref: '宮城県', name: '（県）', current: '' }, null, crow2), '・宮城県　なし → 掲載なし｜掲載なし');

// ---- ヒアリング ----
const mrows = [['200000', '長野県', '（県）', '都道府県'], ['203246', '長野県', '立科町', '町'], ['203238', '長野県', '御代田町', '町'],
  ['430005', '熊本県', '（県）', '都道府県'], ['132012', '東京都', '八王子市', '市'], ['072044', '福島県', '府中町', '町'], ['342092', '広島県', '府中市', '市'], ['132063', '東京都', '府中市', '市']];
assert.strictEqual(f.codeOf_(mrows, '長野県', '北佐久郡\n立科町'), '203246'); // 郡名と改行を無視
assert.strictEqual(f.codeOf_(mrows, '熊本県', '県庁'), '430005');
assert.strictEqual(f.codeOf_(mrows, '', '八王子市'), '132012'); // 県が無くても1つに決まれば
assert.strictEqual(f.codeOf_(mrows, '', '府中市'), ''); // 2つあるなら決めない
assert.strictEqual(f.codeOf_(mrows, '大阪府', '大阪市'), '');

const full = { pref: '東京都', city: '八王子市', dept: '建築指導課', contact: 'キシ様', case: 'A社', conclusion: '個別判断' };
assert.deepStrictEqual([...f.missingOf_(full)], []);
assert.deepStrictEqual([...f.missingOf_(Object.assign({}, full, { contact: '', conclusion: '不明' }))], ['先方の担当者名', '結論（車両扱いでよいか）']);

assert.ok(!f.isHearing_({ pref: '', city: '', q1_raw: '' })); // 「了解です」など
assert.ok(f.isHearing_({ pref: '', city: '八王子市', q1_raw: '' }));
assert.strictEqual(f.nameOf_({ real_name: 'Michiko Endo / 遠藤美智子 / 月曜休み' }), '遠藤美智子');
assert.strictEqual(f.nameOf_({ real_name: 'Issei Sawada/さわだいっせい' }), 'Issei Sawada');

// 集計：件数・最新日・最新の結論・見解の変化（年の無い日付は最新の判定に使わない）
const hrows = [
  ['移行-039', '2025/10/28 11:54', '', '', '', '', '', '', '', '', '', '', '可'],
  ['移行-040', '2026/10/13 00:00', '', '', '', '', '', '', '', '', '', '', '条件付き可（営業所用途は建築物）'],
  ['移行-026', '12/19 13/30', '', '', '', '', '', '', '', '', '', '', '可（基準総則どおり）'],
].map(r => r.concat(Array(9).fill('')));
hrows[0][20] = '203238'; hrows[1][20] = 203238; hrows[2][20] = '222194';
assert.deepStrictEqual(f.hearingSummary_(hrows, ['203238', '222194', '999999']).map(x => [...x]), [
  [2, '2026/10/13', '条件付き可（営業所用途は建築物）', '変化あり（前回 2025/10/28「可」）'],
  [1, '', '可（基準総則どおり）', ''],
  ['', '', '', ''],
]);
// シートから読むと日付は Date で来る
const drow = ['slack-1', new Date(2026, 10, 1), ''].concat(Array(19).fill('')); drow[12] = '可'; drow[20] = '132012';
assert.deepStrictEqual([...f.hearingSummary_([drow], ['132012'])[0]], [1, '2026/11/01', '可', '']);

console.log('ok');
