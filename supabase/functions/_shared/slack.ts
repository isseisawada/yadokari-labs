// Slack（承認依頼の投稿とボタンの受け取り）

export async function slack(method: string, body: unknown) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SLACK_BOT_TOKEN")}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(`Slack ${method}: ${r.error}`);
  return r;
}

/** Slack からの呼び出しが本物かを確かめる（署名の検証） */
export async function verifySlack(req: Request, raw: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("SLACK_SIGNING_SECRET") ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`));
  const hex = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

const fmt = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");

/** 承認依頼のメッセージ */
export function approvalBlocks(o: {
  step: "manager" | "corporate";
  quoteId: string;
  customer: string;
  staff: string;
  totalPre: number;
  marginPct: number;
  discount: number;
  terms: string;
  reasons: string[];
  dealUrl: string;
  approverIds: string[];
}) {
  const who = o.approverIds.map((u) => `<@${u}>`).join(" ");
  const title = o.step === "manager" ? "見積もりの承認依頼（上長）" : "見積もりの承認依頼（コーポレート）";
  const lines = [
    `*${title}* ${who}`,
    `顧客：${o.customer || "（未入力）"} ／ 担当：${o.staff || "（未入力）"}`,
    `合計（税抜）：${fmt(o.totalPre)} ／ 粗利率：${o.marginPct.toFixed(1)}% ／ 値引き：${fmt(o.discount)}`,
    `支払条件：${o.terms}`,
    o.reasons.length ? `コーポレートに回る理由：${o.reasons.join("、")}` : "",
    `<${o.dealUrl}|HubSpot の取引を開く>`,
  ].filter(Boolean);
  const value = JSON.stringify({ q: o.quoteId, s: o.step });
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "承認" }, action_id: "approve", value },
        { type: "button", style: "danger", text: { type: "plain_text", text: "差し戻し" }, action_id: "reject", value },
      ],
    },
  ];
}
