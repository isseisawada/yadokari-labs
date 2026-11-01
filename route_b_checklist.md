# Bルート：各サイトで領収書を出すチェックリスト

Mac の Claude アプリ（Claude in Chrome が使える状態）で、次のように頼む:

> test-labs-git の route_b_checklist.md を見て、2026年10月分の領収書を集めて

- ログインは澤田さんの Chrome にログイン済みのセッションを使う。パスワードは Claude に渡さない・保存しない
- ログインが切れていたら Claude は止まって澤田さんにログインを頼む
- 保存先: Dropbox `/Private/さわだいっせい/プライベート/経費関連/YYYYMM/` と `inputs_2026MM/web_receipts/`（PDF）。対象月の利用分だけ
- 紙の領収書の写真（Dropbox の `経費関連/YYYYMM/photo/`）は `sips -Z 1600` で縮小して `inputs_2026MM/receipts/` にコピー
- 立替は **Visa 5426** のみ。会社カード（Visa 2240 など）の支払いは保存しない
- 保存が終わったら `git add inputs_2026MM && git commit && git push` → クラウドの Claude が merge → ドライラン

## 直接 PDF を保存するもの

| サービス | 入口 | やること | 2026年10月のカード明細 |
|---|---|---|---|
| OpenAI | https://platform.openai.com/settings/organization/billing/history | Billing history から対象月の Invoice/Receipt PDF をダウンロード | 10/10 ¥957, 10/14 ¥958, 10/16 ¥906, 10/29 ¥935 |
| Anthropic | https://platform.claude.com/settings/billing | Invoice history（メールでも届く。Aルートで取り込み済みなら不要） | 取り込み済み（4件） |
| X Developer | https://console.x.com/ | Billing → Invoices/Receipts の PDF | 10/20 ¥1,643 |
| Render | https://dashboard.render.com/billing | Invoices の PDF | 10/2 ¥1,145 |
| Neon | https://console.neon.tech/ → Billing | Invoices の PDF | 10/1 ¥114 |
| Railway | https://railway.com/account/billing | 請求があれば PDF（無料なら不要） | 明細になし |
| GitHub | https://github.com/settings/billing | Payment history の Receipt（無料なら不要） | 明細になし |
| Google Cloud | https://bit.ly/4eaWi2i | お支払い → ドキュメント（前払いの領収書）。¥0 の月次請求書は不要 | |
| モバイルSuica | https://bit.ly/4i1725K （JRE ID: everlybrothers@） | 会員メニュー → SF（電子マネー）利用履歴 → 対象月を表示して PDF 保存 → Dropbox `経費関連/YYYYMM/` と `inputs_2026MM/suica/` | |
| Apple（ChatGPT Plus・NewsPicks） | https://apple.co/4hDHtWW （reportaproblem.apple.com） | 購入履歴から対象月の領収書を表示 → PDF 保存。品目を確認（10/8 ¥3,000 は ChatGPT Plus） | 10/8 ¥3,000 |
| Amazon（適格請求書） | https://amzn.to/4jDdnpb （everlybrothers@） | 注文履歴 → 領収書/購入明細書（適格請求書）を PDF 保存。**書籍のみ**。書籍以外は澤田さんに確認 | |

## サイトで「領収書を発行」→ メールで届く（→ Aルートで取り込み）

| サービス | 入口 | やること |
|---|---|---|
| note | https://bit.ly/4i0FZYk | アカウント → 購入履歴/領収書 → 対象月を発行 |
| STATION WORK | https://bit.ly/4AKbfCf | 利用履歴 → 領収書発行（翌月に届くことがある） |
| 新幹線（EX / えきねっと） | https://bit.ly/47z7sKC （JRE ID: everlybrothers@） | 対象月の乗車分の領収書を発行 |
| 成田エクスプレス（えきねっと） | えきねっと | 同上 |
| GO / S.RIDE | アプリ（スマホ） | アプリ → 乗車履歴 → 領収書をメール送信（ブラウザでは不可。澤田さんがスマホで） |
| Dropbox | https://www.dropbox.com/account/plan | 請求履歴 → 領収書 |
| Booking.com | https://secure.booking.com/mytrips.html | 予約 → 領収書/請求書を発行 |

## 都度（出張時）

レンタカー・航空券・ホテル・バス・特急は予約サイトがその都度違うので、予約確認メール（Aルート）か、
紙の領収書（`inputs_2026MM/receipts/` に写真）で集める。出張名は overrides.json の `trip` に書く。
