# CLAUDE.md — freee 経費精算 プロジェクトルール

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

## 申請の分け方（月次ルール）

**2026年8月分以降（`submit_expenses.py` が自動でこの分け方をする）:**
- **電車の交通費（Suica）は独立した申請にまとめる**
  - 申請1: Suica 交通費のみ（テンプレート 289807）
  - 申請2以降: 領収書系（会議費・接待交際費・雑費・タクシー等）
- タイトル形式: `経費精算申請X/N`（Suica 申請 → 領収書申請の順で通し番号）
- **Suica は件数に関係なく 1 申請**（`--suica-batch-size 0` 既定）。領収書系は 30 件ずつ分割
  - 例: 申請1 = Suica 全件、申請2 = 領収書 30 件まで、申請3 = 残り
- **Suica 一覧のスクショ/PDF は Suica 申請の申請行1に補足資料（sub_receipt_ids）として添付**
- 領収書申請の備考: `電車交通費は申請Xにまとめています。`

## 勘定科目（ベンダー・キーワード → テンプレートID）

デフォルトのマッピング（`submit_expenses.py` の `decide()`）:
- Suica → 289807 交通費（電車在来線・バス）
- GO タクシー → 300520 交通費（タクシー）
- 東日本旅客鉄道 / JR / 新幹線 → 300519 交通費（特急・新幹線）
- 石油・SS・ガソリン → 300524 ガソリン代
- ○○パーク / 駐車場 / パーキング → 300525 駐車場代
- STATION WORK → 300528 会議費（社内）、内容は `オフィスブース利用（STATION WORK 東京駅）`
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
| 接待交際費 | `親睦のため　たにじりまこと`（2026年10月〜この形。名前は必ずひらがな） |
| 贈答・手土産 | `親睦のため　やましたまさき、くどうたろう` |
| ガソリン代 | `打ち合わせ`（移動目的を書く。給油の話は書かない） |
| 駐車場代 | `駐車場利用` |
| 高速・有料道路 | `高速道路利用` |
| タクシー | `タクシー利用`（乗降地は書かない） |
| 備品消耗品 | `消耗品` |
| 新聞図書費 | `知識獲得のため` |
| 宿泊費・レンタカー・航空券 | `熊本出張` `東京出張`（entries.json の `trip` に書く） |
| 通信費・雑費（サブスク） | サービス名を残す。`Google Cloud 2026年8月分利用料` `NewsPicks月額プラン` |
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
