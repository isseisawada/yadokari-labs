# 見積もり → HubSpot 連携（テスト中）の準備

見積もりシミュレーターのテストページ（`mitsumori/test.html`）から、HubSpot のテスト用パイプラインの取引に書き込み、Slack で承認を回す仕組みです。本番ページ（`quote_app.html`）と本番のパイプラインには触りません。

## さわださんにお願いする作業（最初の1回だけ）

### 1. Supabase を Claude から触れるようにする（おすすめ）
見積もりシミュレーターの Supabase プロジェクトは **YADOKARI_works**（`bvwyyocqynbftjnkzsvw`）です。2026-11-13 に YADOKARI_lab（`iredvrxhkilbbfrdnmdm`、バリューカード・AI工場・ゾーニングシミュレーター）と同じ組織に移し、名前を変えました。ID・URL・鍵は変わっていません。
Supabase のコネクタから両方のプロジェクトが見えるようになりました。表を作る・処理を載せるなどの書き込みには、claude.ai の設定 → コネクタ → Supabase で、この組織への書き込みを許可してください。これができれば、2 以降の「表を作る・処理を載せる・秘密情報を入れる」は Claude が行います。

自分で載せる場合は、Supabase CLI で次を実行します。
```
supabase link --project-ref bvwyyocqynbftjnkzsvw
supabase db push                      # supabase/migrations の表を作る
supabase functions deploy quote-hubspot
supabase functions deploy slack-approval
```

### 2. HubSpot に連携用の鍵を作る
HubSpot の 設定 → 連携 → プライベートアプリ（画面によっては「レガシーアプリ」）→ 作成。名前は「見積もり連携」。スコープ（権限）は次の通りです。
- `crm.objects.deals.read` / `crm.objects.deals.write`
- `crm.objects.line_items.read` / `crm.objects.line_items.write`
- `crm.schemas.deals.read` / `crm.schemas.deals.write`（取引の項目とパイプラインを作るため）
- `crm.objects.companies.read`

できた鍵（アクセストークン）は、チャットには貼らずに、次の2か所に入れてください。
- Supabase の Edge Function の秘密情報 `HUBSPOT_TOKEN`
- この Claude のクラウド環境の設定（セッションのタイトルバーの環境メニュー → 編集）の環境変数 `HUBSPOT_TOKEN`。Claude が `supabase/scripts/hubspot-setup.ts` を流して、取引の項目とテスト用パイプラインを作るのに使います

### 3. Slack アプリを作る
https://api.slack.com/apps → Create New App → From an app manifest → ワークスペースを選び、次を貼り付けます。
```yaml
display_information:
  name: 見積もり承認（テスト）
features:
  bot_user:
    display_name: 見積もり承認
oauth_config:
  scopes:
    bot:
      - chat:write
settings:
  interactivity:
    is_enabled: true
    request_url: https://bvwyyocqynbftjnkzsvw.supabase.co/functions/v1/slack-approval
```
インストール後、次の2つを Supabase の秘密情報に入れます。
- Bot User OAuth Token → `QUOTE_SLACK_BOT_TOKEN`
- Basic Information の Signing Secret → `QUOTE_SLACK_SIGNING_SECRET`

※ `SLACK_BOT_TOKEN`・`SLACK_SIGNING_SECRET` は、同じプロジェクトの価格変更の承認（notify-approval・slack-interact、Slack アプリ「見積もりシミュレーター」）が使っているので上書きしない（2026-11-12）。

テスト用のチャンネル（例：#test_見積承認）を作り、このアプリを招待してください。

## 秘密情報の一覧（Supabase → Edge Functions → Secrets）

| 名前 | 中身 | テスト中の値 |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | 2 の鍵 | |
| `HUBSPOT_TEST_PIPELINE_ID` | テスト用パイプラインの ID | hubspot-setup.ts が表示する ID |
| `QUOTE_SLACK_BOT_TOKEN` / `QUOTE_SLACK_SIGNING_SECRET` | 3 の値（Slack アプリ「見積もり承認（テスト）」A0CGPB0LJ3Z） | |
| `SLACK_APPROVAL_CHANNEL` | 承認依頼を出すチャンネルの ID | C0CH6KBEX41（#test_見積承認） |
| `SLACK_MANAGER_USER_IDS` | 上長の承認者（Slack のユーザーID、カンマ区切り） | さわださん（USNRVSSMR）だけ |
| `SLACK_CORPORATE_USER_IDS` | コーポレートの承認者 | さわださん（USNRVSSMR）だけ |
| `APPROVAL_MARGIN_THRESHOLD_PCT` | これ未満の粗利率はコーポレートにも回す | 30（仮。決裁権限表が決まったら直す） |
| `APPROVAL_STANDARD_DEPOSIT_PCTS` | 標準の着手金の割合（0 = 一括） | 0,50（仮） |
| `ALLOWED_ORIGIN` | 呼び出してよいページ | https://isseisawada.github.io |
| `QUOTE_HUBSPOT_PROD` | 本番を有効にするか | 入れない（本番は動かない） |

## 確かめ方
1. `mitsumori/test.html` を開き、顧客情報の下の「HubSpot 連携（テスト中）」で取引を検索・作成する
2. モデルを選んで「概算で保存」→ テスト用パイプラインの取引に金額・予定原価・明細が入り、「D.提案」になる
3. 「見積もりを確定」→ テスト用チャンネルに承認依頼 → 「承認」で取引が「B.クロージング」になる（値引き・低粗利などはコーポレートの承認も回る）

## 手元での確認
```
deno test supabase/functions/_shared/logic_test.ts
deno check supabase/functions/quote-hubspot/index.ts supabase/functions/slack-approval/index.ts
```

## 受注〜納品〜請求（deal-flow、11/12 追加・テスト中）

見積もりの最後の承認のあと、`slack-approval` が受注稟議の下書きを作り、取引を「A.契約締結」にします。その先は `deal-flow` が進めます。

1. 受注稟議が承認される → 案件番号（仮の形「H-取引ID」）を freee のセグメント1に登録、着手金の請求書を freee請求書に下書き、取引を「確定」に、納品完了報告の下書きを作る
2. 納品完了報告が承認される → 残金（一括なら全額）の請求書を freee請求書に下書き、取引に納品日を入れる
3. 節目ごとに承認用のチャンネルにお知らせ。freee に取引先が無いときは止まって知らせ、登録されたら続く

鍵が無いあいだは、バクラクと freee は「にせもの」（`integration_mocks` 表に記録するだけ）で動きます。テストページの確定画面の「受注〜請求（テスト）」から、にせものの申請を承認できます。

| 秘密情報 | 入れると | 待ち |
| --- | --- | --- |
| `BAKURAKU_API_TOKEN` | バクラクに本物の申請を「下書き」で作り、承認されたかを見に行く（仕様書 https://api.bakuraku.layerx.jp/rest/docs/ に沿って作成済み） | バクラクの管理者が API キーを発行 |
| `BAKURAKU_FORM_ORDER` / `BAKURAKU_FORM_DELIVERY` | 受注稟議・納品完了報告のフォームID（フォーム一覧 https://workflow.layerx.jp/master/forms の「編集」を開いた URL の末尾） | 両方とも「汎用フォーム」であること |
| `FREEE_CLIENT_ID` / `FREEE_CLIENT_SECRET` | freee に本物の案件番号・請求書の下書きを作る。入れたあと https://bvwyyocqynbftjnkzsvw.supabase.co/functions/v1/deal-flow?freee=login を開いて許可すると、鍵は `oauth_tokens` 表に控えられ、以後は自動で更新される | freee の書き込み権限と連携用アプリ |

承認の結果を定期的に見に行く仕組み（pg_cron で `deal-flow` の `poll` を10分おき）は、本物のバクラクにつなぐときに入れます。
