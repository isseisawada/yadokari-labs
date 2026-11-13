# CLAUDE.md — freee 経費精算 プロジェクトルール

> **澤田さんへの案内には、操作する画面・メール・資料のリンクを必ず付ける**（言われなくても。2026-11-13 指摘）

このファイルは Claude Code が経費精算の自動化を扱うときに参照するルール集。
新しいルールが決まったら都度追記する。

## freee API 設定

- **承認経路 ID (API 用)**: `1469199`（申請フォーム名: **経費精算_API用（さわだ指定）**）
- **会社ID**: `845775` (YADOKARI株式会社)
- **OAuth アプリ**: 「経理用（mcp）」（Client ID: `732296596197183`）
  - コールバック URL: `http://127.0.0.1:54321/callback`
  - 権限: [会計] 経費精算・経費科目・各種申請・ファイルボックス・部門・取引 の参照＋更新
  - 認可 URL には `scope` を付けない（`prompt=select_company` を付ける）
  - 認可は **澤田さんの freee アカウントでログインしているブラウザ** で行う（別アカウントだと「アプリが存在しない」）
- **明細テンプレート ID** (freee 側で確認済み):
  - 289807: 交通費（電車在来線・バス）
  - 300519: 交通費（特急・新幹線）
  - 300520: 交通費（タクシー）
  - 300524: ガソリン代
  - 300525: 駐車場代
  - 300528: 会議費（社内）
  - 300529: 会議費（社外）
  - **337299: 接待交際費（一人税込10,000円以下）**
  - **337300: 接待交際費（一人税込10,000円超）**
  - ※ 300530/300531 は「【使わない】接待交際費（5,000円）」に変わっている。使わないこと（2026年10月に判明・修正）
  - 雑費 = 304225（勘定科目は支払手数料）、通信費 = 343706、新聞図書費 = 300540
  - 300535: 備品消耗品（事務用品等）
- **勘定科目 ID**: 雑費 = `134321784`（テンプレートが無いので明細行の `account_item_id` で上書きする）
- **API の明細形式**: `purchase_lines[] > {transaction_date, receipt_id, sub_receipt_ids, expense_application_lines[] > {description, amount, expense_application_line_template_id, account_item_id}}`
  - `receipt_id` = 領収書、`sub_receipt_ids` = 補足資料（Suica 一覧など）
  - 交通経路検索（「交通経路を選択」）は公式 API に無い（UI 専用）。description に「打ち合わせ（駅 → 駅）」を書く運用

**経費精算の期限は翌月3日まで**（2026-11 澤田さん）。申請（freee の「申請」ボタン）を3日中に済ませる

## 申請の分け方（月次ルール）

**2026年8月分以降（`submit_expenses.py` が自動でこの分け方をする）:**
- **電車の交通費（Suica）は独立した申請にまとめる**
  - 申請1: Suica 交通費のみ（テンプレート 289807）
  - 申請2以降: 領収書系（会議費・接待交際費・雑費・タクシー等）
- タイトル形式: `経費精算申請X/N`（Suica 申請 → 領収書申請の順で通し番号）
- **Suica は件数に関係なく 1 申請**（`--suica-batch-size 0` 既定）。領収書系は 30 件ずつ分割
  - 例: 申請1 = Suica 全件、申請2 = 領収書 30 件まで、申請3 = 残り
- **Suica 一覧のスクショ/PDF は Suica 申請の申請行1に補足資料（sub_receipt_ids）として添付**
- 領収書申請の備考に「電車交通費は申請Xに…」は書かない（2026年9月分で削除された）

## 勘定科目（ベンダー・キーワード → テンプレートID）

デフォルトのマッピング（`submit_expenses.py` の `decide()`）:
- Suica → 289807 交通費（電車在来線・バス）
- GO タクシー → 300520 交通費（タクシー）
- 東日本旅客鉄道 / JR / 新幹線 → 300519 交通費（特急・新幹線）
- 石油・SS・ガソリン → 300524 ガソリン代
- ○○パーク / 駐車場 / パーキング → 300525 駐車場代
- STATION WORK → 300528 会議費（社内）、内容は `オフィスブース利用（STATION WORK 東京駅）`
- **テレキューブ（telecube.jp。STATION WORK の競合、2026-11-06 初利用）→ 300528 会議費（社内）**、内容は `打ち合わせ：名前　オフィスブース利用（テレキューブ）`
- Soil work / Staple → **雑費**
- **API 課金・クラウド（Google Cloud / Gemini / Anthropic / OpenAI / X Developer / AWS）・Dropbox → 通信費**
- **note / iTunes(NewsPicks) / その他サブスク → 雑費**（freee に「雑費」テンプレートがある。勘定科目は支払手数料）
- **ホテル・宿泊（スリーサウザンド 等） → 宿泊費**
- **レンタカー・カーシェア → レンタカー料金**（300522）
- **書店・書籍（くまざわ書店 等） → 新聞図書費**（テンプレートを名前で実行時解決。無ければ 300535 + 勘定科目上書き）
- **空港・駅の土産物店（ASORA / JAL PLAZA / PLUSTA 等） → 300532 取引先への贈答・手土産代（税込3,000円以内）**
  - ¥3,000 超はドライランで ⚠（登録はする）
- 航空券（TeaFlight / Qunar / 航空会社） → 300521 交通費（飛行機・船舶）
- 高速道路（NEXCO / ETC） → 300523 高速・有料道路料金
- ホテル・旅館 → 300527 宿泊費
- テンプレート一覧の API は既定 20 件で切れるので `limit=100` を付けて取得する

### 雑費の実装
freee には「雑費」テンプレートは存在しないが、`account_item_id=134321784` (雑費) を
明細行に指定するとテンプレート既定の勘定科目を上書きできる。
`submit_expenses.py` の `T_SUPPLY + A_MISC` 組み合わせがこれを実現。

### 会議費 / 接待交際費 の判定ルール

**金額ベースで一次判定（重要）:**
- **飲食代（食事・カフェ・懇親会等）が ¥5,000 以下** → 会議費
- **飲食代が ¥5,000 超** → **すべて接待交際費**（会議費にしない）

**会議費（¥5,000以下）の内訳:**
- 社内メンバーのみ → 会議費（社内）
- 社外含む（entries.json で `"external": true`）→ 会議費（社外）

**接待交際費（¥5,000超）の内訳:**
- **一人あたり合計金額 = 合計金額 ÷ 参加人数（澤田含む）**
  - entries.json の `participants`（澤田を除く名前リスト）から人数 = len+1 を自動計算。`people` で上書き可
- **基本は 接待交際費（一人税込10,000円以下）**（澤田さん方針。実績も 141件 vs 19件）
- 一人税込 ¥10,000 超 → 接待交際費（一人税込10,000円超）。**実人数（`people`）か参加者を人が指定して 1万円を超えたときだけ**
- 推定の参加者・人数で 1万円超にはしない
- 参加者未記入だと一人あたり判定ができないので、ドライランで ⚠ が出る → entries.json を埋めてから本番実行

**参加者記載（重要）:**
- **会議費・接待交際費の両方とも 参加者フルネームを内容欄に必ず記載**
- 例: `打ち合わせ（店名）きたもと・えんどう・ごう`（ひらがなフルネームでOK）
- 社外者は所属も明記: `三井不動産なかむらしょうご`
- 株主同席時: 末尾に `株主XX親睦のため`（entries.json の `shareholder`）

### 内容欄フォーマット（ハウススタイル・重要）

**2026年8月分の申請で 84 行中 31 行の内容欄が手修正された。その結果わかった原則:**

- **店名・ベンダー名は内容欄に書かない**（領収書を見れば分かるので）。「何のためか」だけを書く
- 参加者がいる場合は 全角スペース + `、`区切りのフルネーム（ひらがな可）
- 品目の説明（「レギュラーガソリン給油 14.68L」など）も書かない

| 種別 | 内容欄 |
|---|---|
| Suica | `打ち合わせ（駅名 → 駅名）` ← これはそのままで OK（8月分は無修正） |
| 会議費 | `打ち合わせ　うえすぎせいた` |
| 接待交際費 | `親睦のため：たにじりまこと、うえすぎせいた`（2026年11月〜コロン区切り。名前は必ずひらがなフルネーム） |
| 贈答・手土産 | `親睦のため　やましたまさき、くどうたろう`（渡した相手の**人名**。「いしかわけんちょう」のような組織名は不可） |
| ガソリン代 | `打ち合わせ`（移動目的を書く。給油の話は書かない） |
| 駐車場代 | `打ち合わせ：駐車場利用`（2026年11月〜） |
| 高速・有料道路 | `出張：高速道路利用`（2026年11月〜） |
| タクシー | `打ち合わせ：タクシー利用`（乗降地は書かない。2026年11月〜） |
| 備品消耗品 | `消耗品` |
| 新聞図書費 | `知識獲得のため` |
| 宿泊費・レンタカー・航空券 | `熊本出張` `東京出張`（entries.json の `trip` に書く） |
| 通信費（AI・クラウド・開発系） | `AI関連：OpenAI API 2026年10月分利用料`（2026年11月〜。Dropbox は付けない） |
| 雑費（サブスク） | サービス名を残す。`Google Cloud 2026年8月分利用料` |
| note 月刊 谷尻誠 | `株主たにじりまこと親睦のため`（改行）`note 月刊谷尻誠 2026年10月分利用料` |
| STATION WORK | `打ち合わせ：うえすぎせいた　オフィスブース利用（STATION WORK）`（一緒に使った人を入れる） |
| テレキューブ | `打ち合わせ：うえすぎせいた　オフィスブース利用（テレキューブ）` |
| NewsPicks など情報サービス（雑費） | `知識獲得のため　NewsPicks 2026年9月分利用料` |
| 株主同席時 | 末尾に `株主XXX親睦のため` |

**実装**: `submit_expenses.py` の `build_description()`。
OCR が読んだ説明は `ocr_description` に退避し、内容欄には使わない（通信費・雑費だけ使う）。
`description` は overrides.json で人が指定したときだけ入る。

### entries.json（領収書エントリ）で使うフィールド
```json
{
  "date": "2026-08-15", "kind": "receipt", "vendor": "鮨処秋田家", "amount": 25839,
  "account": "接待交際費",
  "description": "打ち合わせ（鮨処秋田家）",
  "participants": ["きたもと", "えんどう", "ごう"],
  "people": 4,
  "external": false,
  "shareholder": "",
  "receipt_path": "inputs_202608/receipts/xxx.jpg"
}
```
- `participants` / `external` / `shareholder` / `people` は OCR では埋まらない。**merge 後に手で入れる**
- `merge_entries.py` を再実行しても、既存 entries.json の `participants` / `people` / `external` / `shareholder` は `receipt_path` キーで引き継がれる（date/account/description/amount は引き継がない → overrides.json に書く）
- **手修正は `inputs_2026MM/overrides.json` に書くのが確実**（merge が毎回適用する。git にも残る）:
  ```json
  [
    {"match": {"vendor": "焼肉レストラン", "date": "2026-08-12"},
     "set": {"account": "接待交際費", "participants": ["きたもと", "えんどう"], "description": "打ち合わせ（焼肉レストラン）"}},
    {"match": {"vendor": "対象外の店"}, "drop": true}
  ]
  ```
  - `match`: `vendor`（部分一致）/ `date` / `amount` / `receipt_path`（部分一致）。書いたキーは全部一致が必要
  - `set`: 上書きするフィールド。`drop: true` でその領収書を申請から除外
- **参加者名は実際に同席した人だけを書く**（架空の名前は入れない。分からなければ空のままにして freee UI で追記）

## 領収書アップロード

- `POST /api/1/receipts` は「経理用（mcp）」のトークン + ファイルボックス権限で動く
- entries.json の各エントリに `receipt_path` を入れておくと `submit_expenses.py` が自動アップロード＆添付
- 登録後に添付し直す場合は `attach_receipts_later.py`（申請IDとバッチ範囲を書き換えて使う）

## OCR

- Suica スクリーンショット・PDF → `extract_suica_screenshots.py --month M`（Claude Vision）
- 領収書写真・PDF → `extract_receipts.py --month M`（Claude Vision）
- 統合 → `merge_entries.py --month M`（GO日付補正、年誤読補正、勘定科目補正、手修正引き継ぎ）
- 登録 → `submit_expenses.py --month M`（Suica/領収書の申請分割、テンプレートID決定、領収書・補足資料アップロード、freee API 登録）
- `submit_july_2026.py` は7月分の履歴として残してあるだけ（今後は使わない）

## 月次ワークフロー（8月分以降、毎月使えるテンプレ）

### 事前に用意するもの

**画像・書類系（Mac に保存）**
- Suica 利用履歴のスクリーンショット or PDF（1〜31日全部映るように。前月分が混ざっても可、後で除外）
- 現金領収書の写真・PDF（レシート・スタバなど紙ベース）
- Web サービス領収書:
  - GO タクシー領収書（アプリ or メールから DL。ファイル名 `GO領収書_YYYYMMDD_HHMM.pdf` だと日付を自動補正）
  - STATION WORK 領収書（サイトからDL）
  - note 領収書（アカウント > 領収書からDL）
  - Newspicks (Apple サブスク) 領収書（メールに来る Apple 領収書）
  - Google Cloud 請求書 (メール or GCP コンソール)
  - Soil work / Staple の請求書
  - その他 定期購読・出張系（新幹線の領収書は乗車日を entries.json で直す）
- **会食・打ち合わせの参加者名メモ**（店名ごとに誰と何人か。これが無いと接待交際費の判定ができない）

**環境変数（`.env` に既に入っているはず、無ければ）**
```
FREEE_CLIENT_ID=732296596197183          # 経理用（mcp）
FREEE_CLIENT_SECRET=xxxxxxxx             # freee 開発者ページで確認
FREEE_ACCESS_TOKEN=xxxxxxxx              # 期限切れなら python3 -m freee_expense.auth
FREEE_REFRESH_TOKEN=xxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxx          # Vision OCR 用
FREEE_LOGIN_EMAIL=sawada@yadokari.net
```

### 実行手順（コピペ用・8月分の例）

**Step 0: 最新コードを取得**
```bash
cd /Users/issei/Applications/Claude/test-labs-git
git pull origin claude/freee-expense-submission-fYEOe
```

**Step 1: 画像配置**（ディレクトリは git に入っている）
```
inputs_202608/suica/         ← Suica 履歴のスクショ/PDF
inputs_202608/receipts/      ← 手元で写真を撮った紙の領収書
inputs_202608/web_receipts/  ← オンラインで取得した領収書（GO / STATION WORK / note / Apple / Google Cloud / Staple 等の PDF）
```
- `extract_receipts.py` は receipts/ と web_receipts/ の両方を読む（分け方は整理用で、処理は同じ）

**Step 2: OCR で抽出**
```bash
python3 extract_suica_screenshots.py --month 8   # → inputs_202608/entries_suica.json
python3 extract_receipts.py --month 8            # → inputs_202608/entries_receipts.json
```

**Step 3: マージして entries.json 生成**
```bash
python3 merge_entries.py --month 8               # → inputs_202608/entries.json
```
- 件数・合計を確認。対象月外の行、誤読（年・金額・店名）があれば `inputs_202608/entries.json` を直接修正
- **会議費・接待交際費の行に `participants`（と必要なら `external` / `shareholder`）を入れる**
- 新幹線・JR の領収書は `date` を実際の乗車日に直す

**Step 4: ドライラン（送信前確認）**
```bash
python3 submit_expenses.py --month 8 --dry-run
```
- 申請の分かれ方（Suica 申請 → 領収書申請）と各行のラベルを確認
  - `[電車・バス]` `[タクシー]` `[会議費(社内)]` `[接待交際費(一人¥x・10000以下)]` `[雑費]` など
- 末尾の「⚠ 要確認」が 0 件になるまで entries.json / overrides.json を直して再ドライラン
- **「対象月外の日付」の ⚠ は必ず潰す**（Web 領収書の発行日・DL日を拾っていることが多い。8月分なのに 9/2 など）

**Step 5: 本番実行（freee に下書き登録）**
```bash
python3 submit_expenses.py --month 8
```
- 領収書と Suica 一覧をアップロード → 申請作成 → 最後に各申請の URL が出る

**Step 6: freee UI で内容確認 → 申請ボタン**
- `https://secure.freee.co.jp/expense_applications_v2/{申請ID}`
- 確認ポイント: 経費科目 / 参加者名 / 領収書の 📎 / Suica 申請の補足資料 / 備考
- OK なら各申請で「申請」を押して承認フローに送出

### トラブル時の対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 「ページが見つかりません」「アプリが存在しない」（認可時） | Client ID 誤り or 別アカウントでログイン中 | `.env` の FREEE_CLIENT_ID を `732296596197183` に。URL を澤田アカウントでログイン済みのブラウザ（or シークレット）に貼る |
| 401 / トークン期限切れ | アクセストークンは6時間。リフレッシュ失敗時 | `python3 -m freee_expense.auth` で再認可 |
| 403 Forbidden (receipts) | トークンが古いスコープ | 再認可（上記） |
| 400 明細行を入力してください | 明細形式が旧式 | client.py が line_template_id のネスト形式か確認 |
| 400 sub_receipt_ids 関連 | 補足資料の項目名が変わった | `--no-suica-attach` で登録し、Suica 一覧は UI から手動添付 |
| 500 エラー（申請作成時） | 同じ証憑を複数の明細に補足資料として付けた | 補足資料は行ごとに別アップロード（実装済み）。途中で止まったら `--skip-suica` で残りだけ作る。アップロード済み証憑は `upload_cache.json` で再利用 |
| git push 403 | リポジトリ名変更（test-labs → yadokari-labs） | 時間を置いて再試行、または `git remote set-url origin https://github.com/isseisawada/yadokari-labs.git` |

### 事後（申請確定後）

- Client Secret 保管確認（1Password 等）。チャットに貼った Secret は再生成して無効化する
- 新しいルール/勘定科目マッピング変更があれば CLAUDE.md に追記
- 次月分: 翌月頭に本ワークフロー実施（`--month 9`）。`inputs_2026MM/` と空の overrides.json は事前に用意しておく

### 効率化のコツ

- Suica は月末に一気にスクショ or CSV DL しておく
- 現金領収書は撮り溜め（会食後すぐ）→ 月末フォルダに集約。**会食は誰と何人かをその場でメモ**
- Web サービスの領収書メールは Gmail ラベル「経費」等でフィルタリング
- 月末までに inputs_2026MM を揃えておく → 翌月1日に一気実行
- Vision OCR は API 費用が少しかかる（数百円/月）ので、精度悪ければ entries.json を手動修正した方が早い

## 申請履歴（申請ID）

| 対象月 | 申請 | freee 申請ID | 備考 |
|---|---|---|---|
| 2026年7月 | 1/3, 2/3, 3/3 | 18406204, 18406206, 18406208 | 混在方式（旧ルール） |
| 2026年8月 | 1/3 Suica 31件 ¥11,125 | 18784480 | 補足資料に Suica 一覧 |
| 2026年8月 | 2/3 領収書 30件 ¥84,204 | 18784482 | |
| 2026年8月 | 3/3 領収書 23件 ¥233,319 | 18784484 | |
| 2026年9月 | 1/3 Suica 35件 ¥11,177 | 19224117 | 補足資料に Suica 一覧 |
| 2026年9月 | 2/3 領収書 30件 ¥205,256 | 19224173 | ドル払いはカード明細の円額＋明細画像 |
| 2026年9月 | 3/3 領収書 12件 ¥28,416 | 19224175 | 2/3・3/3 は `--skip-suica` で再実行して作成 |
| 2026年10月 | 1/3 Suica 24件 ¥11,084 | 19633868 | Suica は Web の利用明細PDF |
| 2026年10月 | 2/3 領収書 30件 ¥146,152 | 19633869 | |
| 2026年10月 | 3/3 領収書 20件 ¥82,190 | 19633870 | |

## 2026年8月分の振り返り（review_submission.py の結果から）

申請後に `python3 review_submission.py --month 8 --apps 18784480 18784482 18784484` を実行して、
送信内容と freee 上の最終状態を突き合わせた結果と、その対策。

**数字**: 84 行中 → 日付変更 2 / 科目変更 10 / 内容変更 31 / freee で追加 6 / 削除 5
（Suica 申請 31 行は 1 件も修正なし。修正はすべて領収書系）

| 問題 | 原因 | 対策（実装済み） |
|---|---|---|
| 内容欄 31 行を書き換え | 店名入りの説明を生成していた。OCR の説明文をそのまま使っていた | ハウススタイルで生成。OCR 文は `ocr_description` に退避 |
| Google Cloud → 通信費 (3件) | 雑費に寄せていた | `COMM_KEYWORDS` で通信費に判定 |
| Anthropic → 通信費 | 同上 | 同上 |
| note / NewsPicks → 雑費テンプレ | 消耗品テンプレ + 勘定科目上書きにしていた | freee の「雑費」テンプレートを名前で解決 |
| スリーサウザンド → 宿泊費 | ベンダー名からホテルと分からず雑費 | 宿泊系は `account`/`trip` を overrides で指定 |
| 会議費 社内→社外 (2件) | `external` 未指定を社内扱い | 参加者ありで `external` 未指定なら ⚠ を出す |
| TTC LIFESTYLE 9/2 のまま申請 | Web 領収書の発行日/DL日を利用日にしていた | OCR で利用日優先。対象月外は ⚠ に列挙 |
| 足立タクシー 9/2 のまま | overrides.json を直したが merge を回さず submit した | overrides.json が entries.json より新しければ submit を停止 |
| Anthropic の金額違い | USD 請求の円換算額が領収書と一致しない | **カード明細の円額に合わせる**（下記「ドル払い」） |
| ココカラファイン 1件 → 2件に分割 | 1レシートに複数用途 | 分割が必要なものは freee UI で対応（自動化しない） |

**次月の運用で効く順**
1. ドライランで「⚠ 要確認」を 0 にしてから本番実行（対象月外の日付・参加者未記入・社内/社外）
2. 会食は参加者と社内/社外を overrides.json に書く（内容欄と接待交際費の一人あたり判定に効く）
3. 出張がある月は `trip`（例: `熊本出張`）を overrides.json に書く（宿泊費・レンタカー・航空券の内容欄になる）
4. 申請後に `review_submission.py` を回して、その月の差分を CLAUDE.md に追記する

## 会議費・接待交際費の参加者/社内外の推定（2026年10月〜）

**決め方の順番（2026年11月〜 澤田さん指定）**
1. **Google カレンダーで領収書の日時の予定を探す**（レシートの時刻があればその前後、なければその日の昼・夜の予定）。
   予定名・出席者に人の名前があれば、その人を参加者にする（社外の人がいれば社外）
   - 名前はひらがなフルネームにする。社内は meal_history の名簿、社外は Gmail の署名・過去の実績で読みを確認
   - 名字やあだ名しか分からない人は、推定で埋めずに澤田さんに確認する
2. カレンダーに予定がなければ、下の推定（meal_history）で入れる
3. 決めた名前は `inputs_2026MM/overrides.json` に `participants` / `external` と `_source`（根拠）を書く

参加者が空のまま申請しない（澤田さん指示：合っていなくてよいので必ず入れる。名前はひらがな必須）。
**ただし実在しない名前（架空の人）は入れない**。推定は過去に実際に同席した人の中から選ぶ（2026-10 に架空名の依頼があったが、虚偽記載になるため不可と回答）。`merge_entries.py` が **過去の申請実績から推定して埋める**（`guessed: true`）。
ドライランでは 🔮推定 と根拠つきで一覧表示されるので、**違うものだけ overrides.json で直す**。

- データ: `history/meal_history.json`（freee の承認済み申請 2024/02〜2026/08 の会議費・接待交際費 467 件。レシートの店名と紐付け）
- ロジック: `predict_meal.py`
  1. 同じ店に行ったことがある → その店で直近に同席した人、社内/社外は多数派
  2. 初めての店で ¥5,000 以下 → 会議費（社内）、直近60日でいちばん多く打ち合わせた社内メンバー
  3. 初めての店で ¥5,000 超 → 接待交際費、直近60日の接待でよく同席した人を金額相当の人数ぶん
- **精度（6〜8月の実績で検証）**: 社内/社外は約7割正解。**参加者名は約1割しか当たらない**（打ち合わせ相手が毎回違うため）
  → 参加者は「たたき台」。ドライランの 🔮 一覧を必ず見て直す
- **補助: Google カレンダー**。Claude セッションから当日の予定（相手の名前入りの会食・MTG）を見て、推定を上書きした overrides.json を作れる。
  夜の会食は予定名に相手が入っていることが多い
- 名前はひらがなに正規化（カタカナ→ひらがな、所属の前置きは落とす、苗字だけは社内名簿のフルネームに寄せる）
- ¥20,000 以上の推定行はドライランで ⚠（推定人数で一人1万円以下/超が決まるため。実人数は overrides.json の `people`）
- 実績データの更新: 申請が承認されたら、Claude に「meal_history を更新して」と頼む（freee から再取得）

## ドル払い（API 課金など）の金額（2026年9月分〜）

- 金額は **カード明細の円の引き落とし額** に合わせる（領収書の円換算額や OCR の値は使わない）
- 澤田さんがカード明細の「ドル円為替」画像を用意 → `inputs_2026MM/supplements/` に置く
- overrides.json で `amount`（円額）と `sub_receipt_paths`（明細画像）を指定 → 各行に補足資料として添付される
  ```json
  {"match": {"vendor": "OpenAI", "amount": 3465}, "set": {"amount": 3615, "account": "通信費",
   "sub_receipt_paths": ["inputs_202609/supplements/card_fx_202609.png"]}}
  ```
- OCR は USD 金額を円と読むことがある（9月: Dropbox 131.87 USD → ¥131 と誤読、実際は ¥21,910）

## 2026年9月分の振り返り（申請時に澤田さんが直したところ）

金額・日付・領収書・科目の修正はほぼなし（科目は天下一品 関内 ¥1,850 が 会議費 社内→**社外** の1件だけ）。直されたのは主に参加者名。

| 直されたところ | 次回からの扱い |
|---|---|
| 備考の「電車交通費は申請1にまとめています。」を削除 | 書かないようにした |
| 手土産の「いしかわけんちょう」→ 人名（みつぼしあずみ / いねやまこうき） | 手土産も人名を推定して入れる。組織名は入れない |
| NewsPicks → `知識獲得のため　NewsPicks 2026年9月分利用料` | NewsPicks/iTunes は先頭に「知識獲得のため」 |
| 参加者名の差し替え 11件（カレンダー・推定どちらも外れが多い） | 確定した名前を `history/meal_history.json` に追加（479件）。次回の推定はこの実績を使う |
| 天下一品 関内 → 会議費（社外）かじかわまさのり | 実績に反映。同じ店なら次回は社外で推定 |

カレンダーから入れた名前も多くが差し替えられた（金沢玉寿司・プレジデント・悟空 等）。
カレンダーは「その日に誰と会っていたか」の手がかりにはなるが、どの領収書が誰の分かまでは決められない。

## 会社カード払いに切り替えたサービス（2026年11月分〜・経費精算の対象外）

**OpenAI・Anthropic・X Developer・Render・Neon・Railway・GitHub・Google Cloud は会社のカードで決済することになった**（2026-11 澤田さん）。
**Catchy（株式会社デジタルレシピ、info@ 宛の Stripe 領収書、カード末尾 2001）も会社カード払い**なので対象外。
→ Catchy は 2024年3月にメディア編集部向けに契約、2024年8月以降は利用の形跡なし。**2026-11-13 に澤田さんが管理画面でサブスク解約**。12/7 に請求が止まったか確認する（send_later trig_01XW8uRTqyQ2KFMB6LbnvHkA）。同時期契約の SAKUBUN（NOVEL株式会社）は 2024年8月に解約済み
→ 領収書を集めない・申請に入れない。立替（Visa 5426）で残る AI 系は **ChatGPT Plus（Apple）** だけ。
→ ドル払いの立替は Dropbox の年払い（更新月）くらいなので、カード明細のスクショはその月だけ。
（10月分までの記述にある Anthropic / OpenAI 等の立替ルールは過去分の記録）

## Aルート：メールで届く領収書の自動取り込み（2026年11月〜）

月初に Claude（クラウド）が Gmail コネクタで前月分の領収書メールを探し、添付PDFを `inputs_2026MM/web_receipts/` に保存する。

- 添付を直接ダウンロードする機能はないので、`get_message(messageFormat=RAW)` でメール全体を取得 → 結果のJSONファイルを
  `python3 save_mail_receipts.py --month M <JSON...>` に渡すと添付PDFを取り出して保存する
  - 同じ内容のファイル・取り込み済みのメールは保存しない（`inputs_2026MM/mail_receipts.json` に記録）
  - Stripe 系（Anthropic 等）は Invoice と Receipt が両方付くので Receipt だけ残す
- 検索の目安: `after:YYYY/MM/01 before:YYYY/MM+1/03 from:(invoice@mail.anthropic.com OR sride.co.jp OR stationwork.jp OR telecube.jp OR payments-noreply@google.com OR apple.com OR note.jp OR dropbox.com OR booking.com OR goinc.jp)` と、件名 `領収書 OR receipt OR 請求書 OR invoice`
- 注意（2026年10月分で確認）:
  - **STATION WORK の領収書メールは、管理画面で「領収書発行」を押したときにだけ届く**（自動では来ない。2026-11 澤田さん訂正）。10/3 着の 9/9 利用分は、その日に発行したから。
    発行日と利用日がずれるので、利用日で月を判定し、前月申請済みのものは除外
  - Google Cloud の月次請求書は ¥0 のことがある → 除外
  - Anthropic はカードが2枚。**Visa 5426 が立替（経費精算の対象）**、Visa 2240 は会社カードなので対象外（領収書PDFの Payment method で判定）
  - ドル払いの金額はカード明細の円額に合わせる（「ドル払い」の節）
- **B→A の流れ**：STATION WORK・GO・S.RIDE・note・NewsPicks・Dropbox・Booking・JR系（えきねっと/EX/モバイルSuica）は、
  サイトで「領収書を発行」すると領収書メールが届く。なので Bルート（Mac の Chrome）で発行依頼 → 届いたメールを Aルートで取り込む
- サイトで直接PDFを保存するもの（OpenAI・Amazon の適格請求書・Google Cloud の前払い 等）は Bルートで保存まで行う
- 対象アカウント: JR系（モバイルSuica・えきねっと・EX）と Amazon は everlybrothers@（JRE ID）。Amazon は書籍なら経費、それ以外で迷うものは澤田さんに確認
- **有料で立替になっているサービス（2026年10月のカード明細で確認）**: Anthropic・OpenAI（API チャージ、月に数回）・X Developer Platform・Render・Neon・Apple（**ChatGPT Plus**。iPhone のアプリ内課金なので明細は「APPLE COM BILL」¥3,000）。
  Apple の請求は NewsPicks とは限らない → Apple の領収書メール/購入履歴で品目を確認する。ChatGPT Plus は OpenAI と同じく通信費
  どれも領収書メールは来ない（OpenAI は「account has been funded」通知だけ）→ Bルートで各管理画面から領収書PDFを保存する
  - カード明細のスクショの黒塗りは「ドル払いの確認に関係ない行」の意味のことがある（10月: 黒塗りの GO 10/3・10/6 も領収書は届いた）。黒塗り＝経費外とは決めつけない
  - **澤田さんが発行・送付した領収書は全部経費**。「これは経費ですか？」と聞き直さない（2026-11 指摘）。聞くのは Amazon の書籍以外など、ルールで決まっていないものだけ
  - カード明細画像は `inputs_2026MM/supplements/card_<サービス>_<MMDD>.jpg` で保存し、overrides.json の `sub_receipt_paths` に指定

## スマホだけで完結する運用（2026年11月〜・Mac は使わない）

**入口は「Gmail」と「Claude のチャット（スマホアプリ）」の2つだけ。** クラウドの Claude がそこから集めて freee に下書き登録する。

| 種類 | スマホでやること | Claude が受け取る場所 |
|---|---|---|
| 自動でメールが来るもの（Anthropic など） | 何もしない | Gmail（Aルート） |
| 請求メールを設定できるもの（Render / Neon / X / Railway / GitHub / OpenAI） | 最初の1回だけ、各サービスの Billing 設定で請求書・領収書のメール送信先を sawada@yadokari.net にする（できるかはサービスごとに要確認） | Gmail |
| サイトやアプリで「領収書を発行」するとメールが来るもの（GO / S.RIDE / note / STATION WORK / Booking / Dropbox / えきねっと・EX） | スマホのアプリかブラウザで発行ボタンを押す | Gmail |
| メールが来ないもの（OpenAI の領収書 / Amazon の適格請求書 / Google Cloud 前払い / Apple の購入履歴） | スマホで PDF 保存かスクショ → **このチャットに添付**（または件名「経費」で自分宛メール） | チャット / Gmail |
| Suica 利用履歴 | **Claude が Mac の Chrome でモバイルSuica の Web（JRE ID: everlybrothers@）から利用履歴を取得**。Mac が使えないときだけアプリのスクショ | Dropbox / チャット |
| 紙の領収書 | 写真を Dropbox の `経費関連/YYYYMM/photo/` に入れる（またはチャットに添付） | Dropbox / チャット |
| ドル払いの円額 | カード明細アプリの該当行をスクショ → チャットに添付（経費でない行は黒塗りで OK） | チャット |

- チャットに添付されたファイルは Claude が `inputs_2026MM/` の該当フォルダ（web_receipts / receipts / suica / supplements）に保存して git に残す
- 自分宛メールは `from:sawada@yadokari.net subject:経費` で Aルートが拾う
- GO / S.RIDE は Web の利用者ページが無く、発行はアプリから（2026-11 確認）。ただし月1回まとめて出せる:
  - S.RIDE: 期間を指定すると1通にまとめて届く（例: 件名「S.RIDE 領収書/RECEIPT (2026/08/03 - 2026/09/02)」、乗車ごとのPDFが添付）
  - GO: 利用履歴から複数の乗車を選んで一括発行できる（2025年12月〜の一括発行機能）。送信先は sawada@ に登録済み（2026-07）
    - 一括発行のPDFは **1ページに複数の領収書が並ぶ**（10月分: 5件で1ページ）。freee は1つの証憑を複数明細に付けられないので
      `/usr/bin/python3 split_go_receipts.py <PDF>` で1件ずつの画像（`GO領収書_YYYYMMDD_金額.png`）に切り分ける。元のPDFは `inputs_2026MM/originals/` へ
- `save_mail_receipts.py` はメール本文のロゴ等の埋め込み画像は保存しない（2026-11 修正）
  - 法人契約の GO BUSINESS なら立替自体が不要（会社に請求書。利用料5%）
- カード明細のスクショは「立替の一覧」として使う：明細にあって領収書が無いものを Claude が「足りないものリスト」にして返す
- 最後に freee（スマホのブラウザ/アプリ）で内容を確認して「申請」を押す

## 領収書の保存先は Dropbox（2026年11月〜。Google ドライブは遅いのでやめた）

- **`/Private/さわだいっせい/プライベート/経費関連/YYYYMM/`**（例: `経費関連/202610`）
  - 直下: Web で取得した領収書・明細の PDF（Mac の Claude が Chrome で取得して保存）
  - `photo/`: 紙の領収書の写真（澤田さんがスマホで撮って入れる）
- **クラウドの Claude は Dropbox の中身を読めない**（2026-11 確認）:
  - `download_link` の URL（dl.dropboxusercontent.com）はこの環境のネットワーク制限で 403
  - `fetch` は画像に非対応。`list_folder` でファイル一覧は見られる
  - → **Mac 上の Claude セッションが、Dropbox のファイルをリポジトリの `inputs_2026MM/`（PDF は web_receipts/、写真は receipts/）にコピーして push** する。
    写真は `sips -Z 1600` で縮小してから入れる（1枚 3〜4MB あるため）
- Google ドライブの `経費精算/202610〜202907` フォルダと定期タスク（trig_01CFQXYXMejfsKPeSdMX81tF、停止中）は使わない

## 2026年10月分の振り返り（申請時に澤田さんが freee で直したところ）

Suica 24行・金額・日付・科目はほぼ無修正。直されたのは**内容欄の書き方**と**参加者名**。全部、次回から自動で入るようにした（submit_expenses.py / overrides.json）。

| 直されたところ | 次回からの扱い |
|---|---|
| タクシー `タクシー利用` → `打ち合わせ：タクシー利用`、駐車場 → `打ち合わせ：駐車場利用` | 自動 |
| 高速 `高速道路利用` → `出張：高速道路利用` | 自動 |
| 通信費（Neon/Render/Anthropic/OpenAI/X/ChatGPT Plus）の先頭に `AI関連：` | 自動（Dropbox 以外の通信費） |
| note 月刊谷尻誠 → `株主たにじりまこと親睦のため` + 改行 + サービス名 | 自動（「谷尻」を含む行） |
| STATION WORK に一緒に使った人：`打ち合わせ：うえすぎせいた　オフィスブース利用（STATION WORK）` | 参加者を推定して入れる（社外の人なら会議費社外） |
| パレスラウンジ（林さん定例）は `打ち合わせ：はやしみつひろ、きたもとなおひろ`（科目は接待交際費のまま、うえすぎさんは外す） | 定例の打ち合わせ＋飲食は「打ち合わせ：」で書くことがある |
| 肉政は かもだふなのり＋**よこたみちる** の3人 → 一人1万円以下 | 人数が変わると判定も変わるので、名前はなるべく全員 |
| フリューリング（8%と10%が混在）を **税率ごとに2行**（¥4,200＋¥30）に分割、会議費（社外）せきとおる・なかたこうだい | overrides.json に `"amount_split": [4200, 30]` で分割できるようにした |
| 推定の名前はほぼ差し替え（八煌苑・すし好・たき航・道とん堀・ドトール3件・雁川・道の駅こすげ） | 確定した名前を `history/meal_history.json` に追加（494件） |
| カレンダーからの名前も一部違った：雁川は さいとうゆうひ・すずきせ・えんどうみちこ（菅原様は入れない）、北山さんは **きたやまゆきとも** | 取引先（取材相手など）本人は入れず、同行した人を入れることがある。同名字の候補が複数いるときは確認 |

## テレキューブ（2026年11月〜）

- STATION WORK の競合のワークブース。2026-11-06 に初利用（新丸ビル 02-10、13:45〜16:00、¥2,970 税込）。アカウントは sawada@yadokari.net（個人会員）
- **領収書の取り方（B→A）**: マイページの「領収書発行」画面 https://telecube.jp/member/receipts/ で発行 → 登録メール（sawada@）に PDF が届く → Aルートで取り込み
  - 「請求月一覧」→「領収書を発行（月単位発行）」= 1か月分まとめて1枚
  - 「月内明細」→ 利用ごとに発行 = **こちらを使う**（freee は1明細1証憑なので、利用日ごとに参加者を書けるように1回ずつ）
  - 発行時に宛名を指定できる → `YADOKARI株式会社`
- メール: 予約時「ご予約ありがとうございます」（料金入り）、利用後「ご利用完了と領収書発行方法について」（no-reply@telecube.jp）。どちらも領収書ではないので取り込まない
- 科目: 会議費（オフィスブース）。`submit_expenses.py` がベンダー名「テレキューブ / telecube」で自動判定
- 2026-11-06 時点、クラウドからは Mac に接続できず発行ボタンは未実行（初回の発行は Mac の Claude か澤田さんがスマホで）

## 自動実行のスケジュール（2026年11月〜。期限は翌月3日）

すべて このセッション（session_01NSeWqGWMGw6XoxL9Zug1AN）で動く定期タスク（Gmail・Slack・カレンダー・freee の接続を使うため）。freee の「申請」は押さない。

| いつ（JST） | 定期タスク | やること |
|---|---|---|
| 25日 6:23 | trig_0176aYqYAPrHWkmfH731DVA5 | 今月分を途中取り込み。**freee に下書きベースを3つ作る**（下記）。月末までにやることを Slack へ |
| 28日 6:23 | trig_01DZWNMLBdBYBVr4GBsxZrXj | 追加取り込み、Dropbox photo/ の枚数確認、月末リマインド |
| 1日 6:17 | trig_01F8ydcouKNh7uL2sn8KyGBX | 前月分を取り込み → 読み取り → カレンダーで参加者 → ドライラン。足りないもの・確認事項を Slack へ |
| 2日 6:23 | trig_01WM8pzChMkD47o9ZJL9f55z | Mac で取った分・遅れたメールを足してドライランやり直し。「今日中に依頼文C → 申請」を Slack へ |
| 3日 6:23 | trig_019e2JHXMMFHs8R2Bhx1YEC9 | 期限日。freee で申請済みか確認し、未申請なら強めに Slack へ |

- 取り込み先はリポジトリの `inputs_YYYYMM/web_receipts/`（クラウドから Dropbox には PDF を書けない）
- ログインが要るもの（Suica・Apple・テレキューブ/STATION WORK の発行・Amazon）と紙の写真は Mac の依頼文 A

### freee の下書きベース（25日に作る）

- freee は明細ゼロの申請を作れない（400「Purchase linesを入力してください」）ので、**¥0 の仮行1つ**（説明「下書きベース（この行は登録時に置き換わる）」、テンプレート 289807）で3つ作る。タイトル「経費精算申請1/3」「2/3」「3/3」、draft
- IDは `inputs_YYYYMM/freee_apps.json` に `{"base_ids":[…]}`
- `submit_expenses.py` は freee_apps.json があれば、新規作成せず **PUT で順に中身を置き換える**（2026-11-13 に作成→PUT→削除で動作確認済み）。申請が4つ以上なら残りは新規作成、2つで済めば余ったベースを「削除してください」と表示

## 自動実行でできること・できないこと（2026-11-13 の試運転の結果）

25日の自動実行と同じ手順を 11/13 に手動で回した結果。

### できること（クラウドの Claude だけで完結）
| 作業 | どうやるか | 試運転の結果 |
|---|---|---|
| Gmail から領収書メールを探す | 差出人で絞った検索（`after:YYYY/MM/01 has:attachment from:(goinc.jp OR sride.co.jp OR stationwork.jp OR telecube.jp OR apple.com OR note.jp OR dropbox.com OR booking.com OR eki-net.com …)`） | ✅ 4件ヒット（下記の理由で11月分は0件） |
| 添付PDFの保存 | `get_message(RAW)` → `save_mail_receipts.py`。**今後は `download_gmail_attachment`（2026-11 から使える）で直接取るほうが軽い** | ✅（10月分で実績あり） |
| GO 一括PDFの分割 | `split_go_receipts.py` | ✅ |
| 写真・PDF の読み取り | リポジトリにある画像を Claude が直接読む（OCR スクリプトは API キーが無いので使わない） | ✅ |
| 参加者 | Google カレンダー | ✅ |
| freee の下書きを作る・中身を置き換える・消す・状態を見る | freee MCP（POST / PUT / DELETE / GET `/api/1/expense_applications`） | ✅ 11月分のベース 19840067 / 19840068 / 19840069 を作成 |
| Dropbox のファイル一覧 | `list_folder` | ✅（202611 フォルダはまだ無かった） |
| Dropbox の月フォルダを作る | `create_folder`（**澤田さんの許可済み**。25日に翌月の `経費関連/YYYYMM/photo` を作る） | ✅ 202611/photo を作成 |
| Slack 投稿・git push | Slack MCP・git | ✅ |

### できないこと（今の環境では無理）と、どうしているか
| できないこと | 理由 | 今のやり方 |
|---|---|---|
| サイトにログインして取得・発行（Suica・Apple・テレキューブ/STATION WORK の発行・Amazon・note） | ブラウザが無い。Mac の Remote Control フォルダが「クラウドから使えない」状態 | 澤田さんが Mac の Claude に依頼文 A |
| Dropbox の写真の中身を読む | ダウンロードURLがネットワーク制限で 403、`fetch` は画像非対応 | Mac の Claude がリポジトリにコピー（依頼文 A） |
| Dropbox に PDF を書く | MCP はテキストしか作れない | 保存先はリポジトリ |
| freee に領収書ファイルを添付して登録 | freee のトークン（`.env`）が Mac にしか無い。MCP では画像の添付ができない | Mac の Claude に依頼文 C（`submit_expenses.py`） |
| アプリでしか出せない領収書（GO・S.RIDE） | アプリ専用 | 澤田さんが月末にスマホで発行 |

### 試運転で分かったこと
- 11月に届いた GO・STATION WORK の領収書メール（11/1）は **10月利用分**（10月分で申請済み）→ 受信日ではなく**利用日で月を判定**し、申請済みは取り込まない
- Anthropic の領収書（11/11、info@ 経由）→ 会社カード払いなので取り込まない
- 株式会社デジタルレシピの領収書（毎月6日、info@ 経由、Stripe）→ **Catchy（AIライティングツール）の「100クレジットのサブスク」¥3,300/月、カード末尾 2001**。会社カード払いなので**取り込まない**（2026-11-13 澤田さん）
- 「領収書 OR receipt」のような広い検索は 400件近く引っかかって使えない → 差出人で絞る
- freee の申請番号は、消した下書きの番号が再利用される（テストで消した 1066 が 1/3 に付いた）。実害なし

### 2026-11-13 追加検証
- ✅ `download_gmail_attachment` はクラウドで動く（GO の PDF 294KB を直接ファイルに保存できた）。25・28・1・2日の定期タスクはこれに切り替え済み
- ❌ freee MCP にはファイル（領収書画像・PDF）をアップロードする機能が無い（JSON の POST/PUT/DELETE/GET のみ）
- ✅ **freee ファイルボックスへのメール取り込み（2026-11-13 に動作確認済み）**
  - 宛先: `1751051196+256d@mail-receiver.freee.co.jp`（freee の[ファイルボックス](https://secure.freee.co.jp/receipts) →「ファイル設定」→「メールでfreeeにファイルを送る」）
  - 送信元は sawada@（freee メンバー）。届いてから **約2分** で `GET /api/1/receipts`（origin=`mail`、description=`メールからの登録`）に出る
  - 出てきた receipt_id を freee MCP で申請の明細（`receipt_id` / `sub_receipt_ids`）に付けられる（テスト申請 19840335 で確認 → 削除済み）
  - **注意: 元メールを「転送」すると本文のロゴ画像（PNG）まで別ファイルとして取り込まれる**（GO の転送で PDF 1 + ロゴ 3）。
    → 転送ではなく、PDF/写真だけを添付した新規メール（`send_message`）で送る。ゴミが入ったら `DELETE /api/1/receipts/{id}`
  - これで **依頼文 C（Mac の submit_expenses.py）が不要になる**：領収書をメールで freee に送る → receipt_id を取得 → MCP で下書きに PUT
- 💡 紙の写真を **件名「経費」で自分宛にメール**してもらえば、クラウドで読める（Dropbox は読めない）

### 改善の候補（優先順）
1. **Gmail 添付は `download_gmail_attachment` に切り替え**（RAW の巨大JSONを経由しない）
2. ~~freee への登録をクラウドで完結させる~~ → ファイルボックスのメール取り込み + freee MCP で可能になった（2026-11-13）。定期タスク（1日・2日）をこの方式に切り替える
3. **紙の写真をクラウドから読めるようにする**：Google ドライブなら読める（11/1 に確認）。Dropbox のままなら Mac 経由が続く
4. **Mac の Remote Control が使えるようになれば**、依頼文 A・C も定期実行の中で動かせる（今は Mac 側がフォルダを提供していない。Claude アプリの更新や再登録で直るか要確認）
5. ~~Dropbox の月フォルダは澤田さんが作る~~ → 25日の自動実行で翌月分を作る（2026-11-13 から）
