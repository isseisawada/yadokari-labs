// 見積もりシミュレーター → HubSpot（取引の検索・作成、概算で保存、確定＝承認依頼、承認の状態）
import { allowedPipeline, approvers, cors, db, json, rules } from "../_shared/env.ts";
import { createDeal, dealUrl, getDeal, pipelineStages, replaceLineItems, searchDeals, updateDeal } from "../_shared/hubspot.ts";
import { approvalSteps, corporateReasons, dealProperties, lineItems, parseTerms, type Quote, stageIdByPrefix } from "../_shared/logic.ts";
import { approvalBlocks, slack } from "../_shared/slack.ts";

type Body = {
  action: "search" | "create" | "estimate" | "confirm" | "status";
  ns: string;
  q?: string;
  dealname?: string;
  dealId?: string;
  quote?: Quote;
  terms?: unknown;
  newCustomer?: boolean;
  quoteId?: string;
};

/** 書き込んでよい取引か（テスト中はテスト用パイプラインの取引だけ） */
async function guardedDeal(ns: string, dealId: string) {
  const pipeline = allowedPipeline(ns);
  const deal = await getDeal(dealId);
  if (deal.properties.pipeline !== pipeline) throw new Error("この取引は連携の対象外のパイプラインです");
  return { deal, pipeline };
}

function checkQuote(q: Quote | undefined): Quote {
  if (!q?.id || !Array.isArray(q.sections) || typeof q.totalPre !== "number") throw new Error("見積もりのデータが正しくありません");
  return q;
}

const termsLabel = (t: ReturnType<typeof parseTerms>) => (t.kind === "lump" ? "一括" : `着手金 ${t.depositPct}%＋残金`);

async function handle(b: Body) {
  switch (b.action) {
    case "search": {
      const deals = await searchDeals(b.q ?? "", allowedPipeline(b.ns));
      return { deals: deals.map((d) => ({ id: d.id, name: d.properties.dealname, amount: d.properties.amount, url: dealUrl(d.id) })) };
    }
    case "create": {
      const pipeline = allowedPipeline(b.ns);
      if (!b.dealname?.trim()) throw new Error("取引名を入れてください");
      const first = (await pipelineStages(pipeline))[0];
      const d = await createDeal({ dealname: b.dealname.trim(), pipeline, dealstage: first.id });
      return { deal: { id: d.id, name: b.dealname.trim(), url: dealUrl(d.id) } };
    }
    case "estimate": {
      const q = checkQuote(b.quote);
      const terms = parseTerms(b.terms);
      const { pipeline } = await guardedDeal(b.ns, b.dealId!);
      const stage = stageIdByPrefix(await pipelineStages(pipeline), "D.");
      await updateDeal(b.dealId!, { ...dealProperties(q, terms, "estimate"), ...(stage ? { dealstage: stage } : {}) });
      await replaceLineItems(b.dealId!, lineItems(q));
      const { error } = await db().from("quote_links").upsert({
        quote_id: q.id, ns: b.ns, hubspot_deal_id: b.dealId, status: "estimate", payment_terms: terms, quote: q, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return { status: "estimate", url: dealUrl(b.dealId!) };
    }
    case "confirm": {
      const q = checkQuote(b.quote);
      const terms = parseTerms(b.terms);
      await guardedDeal(b.ns, b.dealId!);
      const input = { quote: q, terms, newCustomer: !!b.newCustomer };
      const steps = approvalSteps(input, rules());
      const reasons = corporateReasons(input, rules());
      await updateDeal(b.dealId!, dealProperties(q, terms, "pending"));
      await replaceLineItems(b.dealId!, lineItems(q));
      const channel = Deno.env.get("SLACK_APPROVAL_CHANNEL")!;
      const msg = await slack("chat.postMessage", {
        channel,
        text: "見積もりの承認依頼",
        blocks: approvalBlocks({
          step: "manager", quoteId: q.id, customer: q.customerName ?? "", staff: q.staffName ?? "", totalPre: q.totalPre,
          marginPct: q.marginPct, discount: q.discount ?? 0, terms: termsLabel(terms), reasons, dealUrl: dealUrl(b.dealId!),
          approverIds: approvers("manager"),
        }),
      });
      const { error } = await db().from("quote_links").upsert({
        quote_id: q.id, ns: b.ns, hubspot_deal_id: b.dealId, status: "pending", payment_terms: terms, new_customer: !!b.newCustomer,
        steps, reasons, quote: q, slack_channel: msg.channel, slack_ts: msg.ts, last_error: null, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return { status: "pending", steps, reasons };
    }
    case "status": {
      const { data, error } = await db().from("quote_links").select("status, hubspot_deal_id, steps, reasons, last_error").eq("quote_id", b.quoteId!).maybeSingle();
      if (error) throw error;
      return data ? { ...data, url: dealUrl(data.hubspot_deal_id) } : { status: null };
    }
  }
  throw new Error("不明な操作です");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    return json(await handle(await req.json()));
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
