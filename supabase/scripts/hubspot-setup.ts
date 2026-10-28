// HubSpot の準備（何度流しても同じ結果になる）
//   HUBSPOT_TOKEN=... deno run --allow-net --allow-env supabase/scripts/hubspot-setup.ts
// 1. 取引の項目グループ「見積連携（テスト中）」と項目を作る（中身は空のまま。本番の取引には何も書かない）
// 2. テスト用パイプライン「【テスト】見積連携」を、本番と同じ段階で作る → 出てきた ID を HUBSPOT_TEST_PIPELINE_ID に入れる

const token = Deno.env.get("HUBSPOT_TOKEN");
if (!token) throw new Error("HUBSPOT_TOKEN を入れて実行してください");

async function hs(method: string, path: string, body?: unknown) {
  const res = await fetch("https://api.hubapi.com" + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const GROUP = "yk_quote_link";
const group = await hs("POST", "/crm/v3/properties/deals/groups", { name: GROUP, label: "見積連携（テスト中）", displayOrder: -1 });
console.log("項目グループ:", group.status === 201 ? "作成" : group.status === 409 ? "作成済み" : group.body);

const num = (name: string, label: string, description: string) => ({ name, label, description, groupName: GROUP, type: "number", fieldType: "number" });
const props = [
  { name: "yk_quote_id", label: "見積ID", description: "見積もりシミュレーターの見積ID", groupName: GROUP, type: "string", fieldType: "text" },
  {
    name: "yk_quote_status", label: "見積の状態", description: "概算・承認待ち・承認済み・差し戻し", groupName: GROUP, type: "enumeration", fieldType: "select",
    options: [
      { label: "概算", value: "estimate", displayOrder: 0 },
      { label: "承認待ち", value: "pending", displayOrder: 1 },
      { label: "承認済み", value: "approved", displayOrder: 2 },
      { label: "差し戻し", value: "rejected", displayOrder: 3 },
    ],
  },
  num("yk_plan_sales", "予定売上（税抜）", "見積の社内売上（車両本体の通過分を除く）"),
  num("yk_plan_cost", "予定原価", "見積確定時に固定した予定原価"),
  num("yk_plan_gross", "予定粗利", "予定売上 − 予定原価"),
  num("yk_plan_margin_pct", "予定粗利率（%）", "予定粗利 ÷ 予定売上"),
  {
    name: "yk_payment_terms", label: "支払条件", description: "一括 / 着手金＋残金", groupName: GROUP, type: "enumeration", fieldType: "select",
    options: [{ label: "一括", value: "lump", displayOrder: 0 }, { label: "着手金＋残金", value: "deposit", displayOrder: 1 }],
  },
  num("yk_deposit_pct", "着手金の割合（%）", "一括なら 0"),
];
for (const p of props) {
  const r = await hs("POST", "/crm/v3/properties/deals", p);
  console.log(p.name, r.status === 201 ? "作成" : r.status === 409 ? "作成済み" : r.body);
}

// 見込み粗利（確度加重）＝ 予定粗利 × 段階の確度。HubSpot の計算項目
const calc = await hs("POST", "/crm/v3/properties/deals", {
  name: "yk_weighted_gross", label: "見込み粗利（確度加重）", description: "予定粗利 × 段階の確度", groupName: GROUP,
  type: "number", fieldType: "calculation_equation", calculationFormula: "yk_plan_gross * hs_deal_stage_probability",
});
console.log("yk_weighted_gross", calc.status === 201 ? "作成" : calc.status === 409 ? "作成済み" : calc.body);

// テスト用パイプライン（本番「トレーラーハウス販売プロセス」と同じ段階と確度）
const LABEL = "【テスト】見積連携";
const pipes = await hs("GET", "/crm/v3/pipelines/deals");
let pipe = pipes.body.results.find((p: { label: string }) => p.label === LABEL);
if (!pipe) {
  const stages = [
    ["計画", "0.1"], ["D.提案（概算見積提示）", "0.3"], ["C.条件提示（詳細見積提示）", "0.5"], ["B.クロージング（正式見積提示）", "0.7"],
    ["A.契約締結", "0.9"], ["確定", "1.0"], ["失注", "0.0"],
  ].map(([label, probability], i) => ({ label, displayOrder: i, metadata: { probability } }));
  const r = await hs("POST", "/crm/v3/pipelines/deals", { label: LABEL, displayOrder: 99, stages });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  pipe = r.body;
}
console.log(`\nテスト用パイプラインの ID: ${pipe.id}\n→ Supabase の秘密情報 HUBSPOT_TEST_PIPELINE_ID に入れてください`);
