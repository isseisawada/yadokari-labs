// 受注〜納品〜請求の流れの入口（定期実行・テストページから呼ぶ）
import { cors, db, json } from "../_shared/env.ts";
import { bakurakuMock, mockDecide } from "../_shared/bakuraku.ts";
import { poll, startOrder } from "../_shared/flow.ts";
import { finishLogin, freeeMock, loginUrl } from "../_shared/freee.ts";

type Body = { action: "poll" | "start" | "mock-decide" | "status" | "setup"; quoteId?: string; ns?: string; dealId?: string; app?: "order" | "delivery"; decision?: "approved" | "rejected" };

async function handle(b: Body) {
  const ns = b.ns ?? "test";
  if (ns !== "test" && Deno.env.get("QUOTE_HUBSPOT_PROD") !== "on") throw new Error("本番の連携はまだ有効になっていません");
  switch (b.action) {
    case "poll":
      return { results: await poll(ns) };
    case "start": {
      // 承認済みの見積もりから、受注稟議の下書きを作り直す（最後の承認のあとに失敗したときのやり直し）
      const { data: link, error } = await db().from("quote_links").select("*").eq("quote_id", b.quoteId!).eq("ns", ns).single();
      if (error) throw error;
      if (link.status !== "approved") throw new Error("承認済みの見積もりだけ始められます");
      await startOrder(link);
      return { status: "order_pending" };
    }
    case "mock-decide": {
      // テストだけ：にせものの受注稟議・納品完了報告を承認・差し戻しにして、すぐ流れを進める
      if (ns !== "test" || !bakurakuMock()) throw new Error("テストのときだけ使えます");
      const { data: f, error } = await db().from("deal_flows").select("order_app_id, delivery_app_id").eq("hubspot_deal_id", b.dealId!).eq("ns", "test").single();
      if (error) throw error;
      const id = b.app === "delivery" ? f.delivery_app_id : f.order_app_id;
      if (!id) throw new Error("まだその申請がありません");
      await mockDecide(id, b.decision ?? "approved");
      return { results: await poll("test") };
    }
    case "status": {
      const { data, error } = await db().from("deal_flows").select("status, project_no, last_error, deposit_invoice_id, final_invoice_id").eq("hubspot_deal_id", b.dealId!).maybeSingle();
      if (error) throw error;
      return data ?? { status: null };
    }
    case "setup": {
      // 取引の項目「案件番号」「納品日」を足す（何度呼んでも同じ）
      const out: Record<string, number> = {};
      for (const p of [
        { name: "yk_project_no", label: "案件番号", type: "string", fieldType: "text" },
        { name: "yk_delivered_on", label: "納品日", type: "date", fieldType: "date" },
      ]) {
        const res = await fetch("https://api.hubapi.com/crm/v3/properties/deals", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("HUBSPOT_TOKEN")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...p, groupName: "yk_quote_link", description: "見積連携が書き込む" }),
        });
        out[p.name] = res.status; // 201 = 作成、409 = 作成済み
      }
      return out;
    }
  }
  throw new Error("不明な操作です");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method === "GET") return await freeeLogin(new URL(req.url));
  try {
    return json(await handle(await req.json()));
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** freee とつなぐ：?freee=login で許可画面へ、許可のあと freee が ?code= 付きで戻してくる */
async function freeeLogin(u: URL): Promise<Response> {
  // Supabase の標準の URL は HTML を出せない（text/plain にされる）ので、文字だけで返す
  const page = (msg: string, status = 200) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  try {
    if (freeeMock()) return page("先に Supabase の秘密情報に FREEE_CLIENT_ID と FREEE_CLIENT_SECRET を入れてください", 400);
    if (u.searchParams.get("freee") === "login") return Response.redirect(await loginUrl(), 302);
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (code && state) { await finishLogin(code, state); return page("freee とつながりました。この画面は閉じて大丈夫です"); }
    return page(u.searchParams.get("error_description") ?? "不明な呼び出しです", 400);
  } catch (e) {
    return page(e instanceof Error ? e.message : String(e), 400);
  }
}
