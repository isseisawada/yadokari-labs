// バクラク（受注稟議・納品完了報告の申請）
// BAKURAKU_API_TOKEN が無いあいだは、にせもの（integration_mocks 表）で動く。テストページから承認・差し戻しを再現できる。
import { db } from "./env.ts";
import type { AppStatus } from "./flow-logic.ts";

export type AppKind = "order" | "delivery";
export const bakurakuMock = () => !Deno.env.get("BAKURAKU_API_TOKEN");

const BASE = "https://api.bakuraku.layerx.jp/rest/v1/workflow";

async function bk<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-bakuraku-api-key": Deno.env.get("BAKURAKU_API_TOKEN")!, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`バクラク ${method} ${path} → ${res.status}: ${await res.text()}`);
  return await res.json();
}

/** 受注稟議・納品完了報告を「下書き」で作る（担当者が契約書などを添付して出す） */
export async function createApplication(kind: AppKind, title: string, fields: Record<string, unknown>): Promise<{ id: string; url: string | null }> {
  if (!bakurakuMock()) {
    const formId = Deno.env.get(kind === "order" ? "BAKURAKU_FORM_ORDER" : "BAKURAKU_FORM_DELIVERY");
    if (!formId) throw new Error(`バクラクのフォームID（${kind === "order" ? "BAKURAKU_FORM_ORDER" : "BAKURAKU_FORM_DELIVERY"}）が入っていません`);
    const amount = Number(fields["見積金額_税抜"] ?? fields["請求内容の確認_請求額_税抜"]);
    // shortcut: フォーム独自の項目名がわからないので、中身は「内容」にまとめて入れる。フォームの項目名がわかったら formFieldValues に分ける
    const description = Object.entries(fields).map(([k, v]) => `${k}：${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
    const r = await bk<{ id: string }>("POST", "/requests", {
      title: title.slice(0, 255), status: "DRAFT", formId,
      defaultFieldValue: { description, ...(Number.isFinite(amount) ? { paymentAmount: Math.round(amount) } : {}) },
    });
    return { id: r.id, url: null };
  }
  const { data, error } = await db().from("integration_mocks")
    .insert({ kind: `bakuraku_${kind}`, status: "pending", payload: { title, fields } }).select("id").single();
  if (error) throw error;
  return { id: String(data.id), url: null };
}

/** バクラクの状態を、流れで使う3つ（承認待ち・承認・差し戻し）にまとめる */
export function toAppStatus(s: string): AppStatus {
  if (s === "APPROVED") return "approved";
  if (["REJECTED", "REMANDED", "CANCELED", "CANCELED_AFTER_APPROVED", "DELETED"].includes(s)) return "rejected";
  return "pending"; // DRAFT（まだ出していない）・IN_PROGRESS（承認待ち）
}

export async function applicationStatus(id: string): Promise<AppStatus> {
  if (!bakurakuMock()) return toAppStatus((await bk<{ status: string }>("GET", `/requests/${encodeURIComponent(id)}`)).status);
  const { data, error } = await db().from("integration_mocks").select("status").eq("id", Number(id)).single();
  if (error) throw error;
  return data.status as AppStatus;
}

/** テスト用：にせものの申請を承認・差し戻しにする */
export async function mockDecide(id: string, status: "approved" | "rejected") {
  if (!bakurakuMock()) throw new Error("にせものの申請は、バクラクの鍵が無いときだけ使えます");
  const { error } = await db().from("integration_mocks").update({ status }).eq("id", Number(id)).like("kind", "bakuraku_%");
  if (error) throw error;
}
