// freee（会計の取引先・セグメント1＝案件番号、freee請求書の請求書の下書き）
// FREEE_CLIENT_ID が無いあいだは、にせもの（integration_mocks 表）に記録するだけ。
import { db } from "./env.ts";
import type { InvoiceLine } from "./flow-logic.ts";

export const freeeMock = () => !Deno.env.get("FREEE_CLIENT_ID");
const COMPANY_ID = Number(Deno.env.get("FREEE_COMPANY_ID") ?? "845775"); // YADOKARI株式会社

/** アクセストークン。freee のリフレッシュトークンは使うたびに替わるので、新しいものを oauth_tokens 表に控える */
async function token(): Promise<string> {
  const sb = db();
  const { data } = await sb.from("oauth_tokens").select("*").eq("provider", "freee").maybeSingle();
  if (data?.access_token && new Date(data.expires_at).getTime() > Date.now() + 60_000) return data.access_token;
  const refresh = data?.refresh_token ?? Deno.env.get("FREEE_REFRESH_TOKEN");
  if (!refresh) throw new Error("freee とまだつながっていません。deal-flow の ?freee=login を開いて許可してください");
  const res = await fetch("https://accounts.secure.freee.co.jp/public_api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: Deno.env.get("FREEE_CLIENT_ID")!,
      client_secret: Deno.env.get("FREEE_CLIENT_SECRET")!,
      refresh_token: refresh,
    }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(`freee の認証に失敗しました：${JSON.stringify(t)}`);
  const { error } = await sb.from("oauth_tokens").upsert({
    provider: "freee", access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  });
  if (error) throw error;
  return t.access_token;
}

const REDIRECT = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/deal-flow`;

/** freee の連携の許可画面へのリンク。開いた人の freee の権限で動くようになる（なりすまし防止の合言葉 state を控える） */
export async function loginUrl(): Promise<string> {
  const state = crypto.randomUUID();
  const { error } = await db().from("oauth_tokens").upsert({ provider: "freee_state", access_token: state, expires_at: new Date(Date.now() + 600_000).toISOString() });
  if (error) throw error;
  return "https://accounts.secure.freee.co.jp/public_api/authorize?" + new URLSearchParams({
    client_id: Deno.env.get("FREEE_CLIENT_ID")!, redirect_uri: REDIRECT(), response_type: "code", state, prompt: "select_company",
  });
}

/** 許可のあと freee から戻ってきたとき：鍵を受け取って oauth_tokens 表に控える */
export async function finishLogin(code: string, state: string): Promise<void> {
  const sb = db();
  const { data: s } = await sb.from("oauth_tokens").select("*").eq("provider", "freee_state").maybeSingle();
  if (!s || s.access_token !== state || new Date(s.expires_at).getTime() < Date.now()) throw new Error("リンクの期限が切れています。もう一度ログイン用のリンクから開いてください");
  const res = await fetch("https://accounts.secure.freee.co.jp/public_api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT(),
      client_id: Deno.env.get("FREEE_CLIENT_ID")!, client_secret: Deno.env.get("FREEE_CLIENT_SECRET")!,
    }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(`freee の認証に失敗しました：${t.error_description ?? t.error ?? res.status}`);
  const { error } = await sb.from("oauth_tokens").upsert({
    provider: "freee", access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  });
  if (error) throw error;
  await sb.from("oauth_tokens").delete().eq("provider", "freee_state");
}

async function fr<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`freee ${method} ${url} → ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function mock(kind: string, payload: unknown): Promise<number> {
  const { data, error } = await db().from("integration_mocks").insert({ kind, status: "created", payload }).select("id").single();
  if (error) throw error;
  return data.id;
}

/** 取引先を名前で探す（見つからなければ null。登録はコーポレートだけが行う） */
export async function findPartner(name: string): Promise<number | null> {
  if (freeeMock()) return name ? 1 : null; // にせもの：名前があれば登録済みとみなす
  const r = await fr<{ partners: { id: number; name: string }[] }>(
    "GET", `https://api.freee.co.jp/api/1/partners?company_id=${COMPANY_ID}&keyword=${encodeURIComponent(name)}&limit=10`);
  return r.partners.find((p) => p.name === name)?.id ?? null;
}

/** セグメント1（製作番号＝案件番号）を作る */
export async function createProjectTag(projectNo: string, dealName: string): Promise<number> {
  if (freeeMock()) return mock("freee_segment_tag", { name: projectNo, shortcut1: dealName.slice(0, 20) });
  const r = await fr<{ segment_tag: { id: number } }>("POST", "https://api.freee.co.jp/api/1/segments/1/tags", {
    company_id: COMPANY_ID, name: projectNo, description: "HubSpot連携", shortcut1: dealName.slice(0, 20),
  });
  return r.segment_tag.id;
}

/** freee請求書に請求書を作る（送付はしない。経理が freee の画面で確かめて送る） */
export async function createInvoice(o: { partnerId: number; subject: string; lines: InvoiceLine[]; segmentTagId: number; memo: string }) {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const body = {
    // 書式は今使っている「【2024年4月発行から】請求書フォーマット」（登録番号・振込先入り）
    company_id: COMPANY_ID, template_id: Number(Deno.env.get("FREEE_INVOICE_TEMPLATE_ID") ?? "1380024"), payment_type: "transfer",
    billing_date: today, subject: o.subject, partner_id: o.partnerId, partner_title: "御中", line_amount_fraction: "omit",
    tax_entry_method: "out", tax_fraction: "omit", withholding_tax_entry_method: "out", memo: o.memo,
    lines: o.lines.map((l) => ({ type: "item", ...l, segment_1_tag_id: o.segmentTagId })),
  };
  if (freeeMock()) {
    const id = await mock("freee_invoice", body);
    return { id, url: null as string | null };
  }
  const r = await fr<{ invoice: { id: number } }>("POST", "https://api.freee.co.jp/iv/invoices", body);
  return { id: r.invoice.id, url: `https://invoice.secure.freee.co.jp/reports/invoices/${r.invoice.id}` };
}
