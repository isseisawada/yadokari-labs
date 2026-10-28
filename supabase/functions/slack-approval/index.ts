// Slack の「承認」「差し戻し」ボタンを受け取る（Slack アプリの Interactivity の送り先）
import { approvers, db } from "../_shared/env.ts";
import { dealUrl, pipelineStages, getDeal, updateDeal } from "../_shared/hubspot.ts";
import { dealProperties, stageIdByPrefix, type PaymentTerms, type Quote } from "../_shared/logic.ts";
import { approvalBlocks, slack, verifySlack } from "../_shared/slack.ts";

type Link = {
  quote_id: string; hubspot_deal_id: string; status: string; steps: string[]; reasons: string[];
  quote: Quote; payment_terms: PaymentTerms; slack_channel: string; slack_ts: string;
};

const termsLabel = (t: PaymentTerms) => (t.kind === "lump" ? "一括" : `着手金 ${t.depositPct}%＋残金`);

type Result = { done: boolean; text: string };

async function decide(user: string, action: string, value: { q: string; s: "manager" | "corporate" }): Promise<Result> {
  const sb = db();
  const { data: link, error } = await sb.from("quote_links").select("*").eq("quote_id", value.q).maybeSingle<Link>();
  if (error || !link) throw new Error("見積もりが見つかりません");
  if (link.status !== "pending") return { done: true, text: `この見積もりはもう「${link.status}」です` };
  if (!approvers(value.s).includes(user)) return { done: false, text: "この承認の担当ではありません" };

  const decision = action === "approve" ? "approved" : "rejected";
  await sb.from("quote_approvals").insert({ quote_id: link.quote_id, step: value.s, decision, slack_user: user });

  if (decision === "rejected") {
    await sb.from("quote_links").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("quote_id", link.quote_id);
    await updateDeal(link.hubspot_deal_id, { yk_quote_status: "rejected" });
    return { done: true, text: `<@${user}> が差し戻しました。見積もりシミュレーターで直して、もう一度「確定」してください` };
  }

  const next = link.steps[link.steps.indexOf(value.s) + 1] as "corporate" | undefined;
  if (next) {
    const q = link.quote;
    await slack("chat.postMessage", {
      channel: link.slack_channel,
      thread_ts: link.slack_ts,
      text: "見積もりの承認依頼（コーポレート）",
      blocks: approvalBlocks({
        step: next, quoteId: q.id, customer: q.customerName ?? "", staff: q.staffName ?? "", totalPre: q.totalPre,
        marginPct: q.marginPct, discount: q.discount ?? 0, terms: termsLabel(link.payment_terms), reasons: link.reasons,
        dealUrl: dealUrl(link.hubspot_deal_id), approverIds: approvers(next),
      }),
    });
    return { done: true, text: `<@${user}> が承認しました。コーポレートの承認に回しました` };
  }

  // 最後の承認：取引を「B.クロージング（正式見積提示）」へ
  const deal = await getDeal(link.hubspot_deal_id);
  const stage = stageIdByPrefix(await pipelineStages(deal.properties.pipeline!), "B.");
  await updateDeal(link.hubspot_deal_id, {
    ...dealProperties(link.quote, link.payment_terms, "approved"),
    ...(stage ? { dealstage: stage } : {}),
  });
  await sb.from("quote_links").update({ status: "approved", updated_at: new Date().toISOString() }).eq("quote_id", link.quote_id);
  return { done: true, text: `<@${user}> が承認しました。取引を「B.クロージング」にしました` };
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifySlack(req, raw))) return new Response("bad signature", { status: 401 });
  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  const act = payload.actions?.[0];
  if (!act) return new Response("");
  let r: Result;
  try {
    r = await decide(payload.user.id, act.action_id, JSON.parse(act.value));
  } catch (e) {
    console.error(e);
    r = { done: false, text: `エラー：${e instanceof Error ? e.message : String(e)}` };
  }
  // 決まったらボタンを消して結果に置き換える。担当外・エラーは押した人にだけ知らせ、ボタンは残す
  const body = r.done
    ? { replace_original: true, text: r.text, blocks: [payload.message.blocks[0], { type: "context", elements: [{ type: "mrkdwn", text: r.text }] }] }
    : { replace_original: false, response_type: "ephemeral", text: r.text };
  await fetch(payload.response_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return new Response("");
});
