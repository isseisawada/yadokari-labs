// 受注〜納品〜請求の流れ（承認済みの見積もりから先）
import { db } from "./env.ts";
import { applicationStatus, createApplication } from "./bakuraku.ts";
import { createInvoice, createProjectTag, findPartner } from "./freee.ts";
import { depositLines, finalLines, type FlowStatus, nextStep, projectNo, sumLines } from "./flow-logic.ts";
import { dealUrl, getDeal, pipelineStages, updateDeal } from "./hubspot.ts";
import type { PaymentTerms, Quote } from "./logic.ts";
import { slack } from "./slack.ts";

type Flow = {
  hubspot_deal_id: string; ns: string; quote_id: string; status: FlowStatus; project_no: string;
  order_app_id: string | null; delivery_app_id: string | null; freee_segment_tag_id: number | null;
  deposit_invoice_id: number | null; final_invoice_id: number | null; last_error: string | null;
};
type Link = { quote_id: string; hubspot_deal_id: string; quote: Quote; payment_terms: PaymentTerms; ns: string };

const yen = (n: number) => "¥" + Math.round(n).toLocaleString("ja-JP");
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

async function notify(text: string) {
  await slack("chat.postMessage", { channel: Deno.env.get("SLACK_APPROVAL_CHANNEL") || "C0CH6KBEX41", text });
}

async function moveStage(dealId: string, prefix: string, extra: Record<string, string> = {}) {
  const deal = await getDeal(dealId);
  const stage = (await pipelineStages(deal.properties.pipeline!)).find((s) => s.label.startsWith(prefix))?.id;
  await updateDeal(dealId, { ...extra, ...(stage ? { dealstage: stage } : {}) });
}

async function save(dealId: string, patch: Partial<Flow>) {
  const { error } = await db().from("deal_flows").update({ ...patch, updated_at: new Date().toISOString() }).eq("hubspot_deal_id", dealId);
  if (error) throw error;
}

/** 見積もりの最後の承認のあと：受注稟議の下書きを作り、取引を「A.契約締結」へ */
export async function startOrder(link: Link) {
  const q = link.quote;
  const no = projectNo(link.hubspot_deal_id);
  const app = await createApplication("order", `受注稟議：${q.customerName || "（顧客名なし）"}｜${no}`, {
    案件番号: no, 見積ID: q.id, 取引先: q.customerName ?? "", 担当: q.staffName ?? "",
    見積金額_税抜: Math.round(q.totalPre), 実行予算_予定原価: Math.round(q.totalCost), 予定粗利率: Math.round(q.marginPct * 10) / 10,
    支払条件: link.payment_terms, HubSpot: dealUrl(link.hubspot_deal_id),
  });
  const { error } = await db().from("deal_flows").upsert({
    hubspot_deal_id: link.hubspot_deal_id, ns: link.ns, quote_id: q.id, status: "order_pending", project_no: no,
    order_app_id: app.id, delivery_app_id: null, last_error: null, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  await moveStage(link.hubspot_deal_id, "A.", { yk_project_no: no });
  await notify(`受注稟議の下書きを作りました（${no}・${q.customerName || ""}）。契約書を添付して出してください`);
}

/** 承認済みの申請を見て、次に進める（定期実行・テストページから呼ぶ） */
export async function poll(ns: string) {
  const sb = db();
  const { data: flows, error } = await sb.from("deal_flows").select("*").eq("ns", ns).in("status", ["order_pending", "delivery_pending"]);
  if (error) throw error;
  const results: { deal: string; step: string; error?: string }[] = [];
  for (const f of flows as Flow[]) {
    try {
      const appId = f.status === "order_pending" ? f.order_app_id! : f.delivery_app_id!;
      const step = nextStep(f.status, await applicationStatus(appId));
      if (step !== "wait") await advance(f, step);
      results.push({ deal: f.hubspot_deal_id, step });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== f.last_error) {
        await save(f.hubspot_deal_id, { last_error: msg });
        await notify(`連携で止まっています（${f.project_no}）：${msg}`).catch(() => {});
      }
      results.push({ deal: f.hubspot_deal_id, step: "error", error: msg });
    }
  }
  return results;
}

async function advance(f: Flow, step: ReturnType<typeof nextStep>) {
  const { data: link, error } = await db().from("quote_links").select("*").eq("quote_id", f.quote_id).single<Link>();
  if (error) throw error;
  const q = link.quote, t = link.payment_terms;

  if (step === "on_ordered") {
    const partner = await findPartner(q.customerName ?? "");
    if (!partner) throw new Error(`freee に取引先「${q.customerName}」がありません。コーポレートで登録してください（登録されたら自動で続きます）`);
    const tag = f.freee_segment_tag_id ?? await createProjectTag(f.project_no, q.customerName ?? "");
    let depositId = f.deposit_invoice_id;
    const dl = depositLines(q, t);
    if (dl.length && !depositId) {
      depositId = (await createInvoice({ partnerId: partner, subject: `着手金のご請求｜${f.project_no}`, lines: dl, segmentTagId: tag, memo: `HubSpot ${dealUrl(f.hubspot_deal_id)}` })).id;
    }
    const fl = finalLines(q, t);
    const del = await createApplication("delivery", `納品完了報告：${q.customerName || ""}｜${f.project_no}`, {
      案件番号: f.project_no, 請求内容の確認_請求額_税抜: sumLines(fl), 宛先: q.customerName ?? "",
      値引き: Math.round(q.discount ?? 0), 着手金_税抜: sumLines(dl), 検収書: "（添付してください）",
    });
    await save(f.hubspot_deal_id, { status: "delivery_pending", freee_segment_tag_id: tag, deposit_invoice_id: depositId, delivery_app_id: del.id, last_error: null });
    await moveStage(f.hubspot_deal_id, "確定");
    await notify(`受注稟議が承認されました（${f.project_no}）。` +
      (dl.length ? `着手金 ${yen(sumLines(dl))}（税抜）の請求書を freee請求書に下書きしました。経理で確認して送ってください。` : "") +
      `納品完了報告の下書きも作りました`);
  } else if (step === "on_delivered") {
    const partner = await findPartner(q.customerName ?? "");
    if (!partner) throw new Error(`freee に取引先「${q.customerName}」がありません`);
    const fl = finalLines(q, t);
    const inv = f.final_invoice_id ?? (await createInvoice({
      partnerId: partner, subject: `${t.kind === "deposit" ? "残金" : "ご請求"}｜${f.project_no}`, lines: fl,
      segmentTagId: f.freee_segment_tag_id!, memo: `HubSpot ${dealUrl(f.hubspot_deal_id)}`,
    })).id;
    await save(f.hubspot_deal_id, { status: "done", final_invoice_id: inv, last_error: null });
    await updateDeal(f.hubspot_deal_id, { yk_delivered_on: today() });
    await notify(`納品完了報告が承認されました（${f.project_no}）。${t.kind === "deposit" ? "残金" : "請求"} ${yen(sumLines(fl))}（税抜）の請求書を freee請求書に下書きしました。経理で確認して送ってください`);
  } else if (step === "on_order_rejected" || step === "on_delivery_rejected") {
    const status = step === "on_order_rejected" ? "order_rejected" : "delivery_rejected";
    await save(f.hubspot_deal_id, { status });
    await notify(`${status === "order_rejected" ? "受注稟議" : "納品完了報告"}が差し戻されました（${f.project_no}）。直して出し直してください`);
  }
}
