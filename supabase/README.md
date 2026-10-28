# 見積もり → HubSpot 連携（テスト中）の準備

見積もりシミュレーターのテストページ（`mitsumori/test.html`）から、HubSpot のテスト用パイプラインの取引に書き込み、Slack で承認を回す仕組みです。本番ページ（`quote_app.html`）と本番のパイプラインには触りません。

## さわださんにお願いする作業（最初の1回だけ）

### 1. Supabase を Claude から触れるようにする（おすすめ）
見積もりシミュレーターの Supabase プロジェクト（`bvwyyocqynbftjnkzsvw`）は、今つないでいる Supabase のコネクタからは見えません（見えるのは別の組織の yadokari-valuecard だけ）。
claude.ai の設定 → コネクタ → Supabase で、このプロジェクトがある組織へのアクセスも許可してください。これができれば、2 以降の「表を作る・処理を載せる・秘密情報を入れる」は Claude が行います。

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
- Bot User OAuth Token → `SLACK_BOT_TOKEN`
- Basic Information の Signing Secret → `SLACK_SIGNING_SECRET`

テスト用のチャンネル（例：#test_見積承認）を作り、このアプリを招待してください。

## 秘密情報の一覧（Supabase → Edge Functions → Secrets）

| 名前 | 中身 | テスト中の値 |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | 2 の鍵 | |
| `HUBSPOT_TEST_PIPELINE_ID` | テスト用パイプラインの ID | hubspot-setup.ts が表示する ID |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | 3 の値 | |
| `SLACK_APPROVAL_CHANNEL` | 承認依頼を出すチャンネルの ID | テスト用チャンネル |
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
