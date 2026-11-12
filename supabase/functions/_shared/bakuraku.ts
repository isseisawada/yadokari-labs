// バクラク（受注稟議・納品完了報告の申請）
// BAKURAKU_API_TOKEN が無いあいだは、にせもの（integration_mocks 表）で動く。テストページから承認・差し戻しを再現できる。
import { db } from "./env.ts";
import type { AppStatus } from "./flow-logic.ts";

export type AppKind = "order" | "delivery";
export const bakurakuMock = () => !Deno.env.get("BAKURAKU_API_TOKEN");

export async function createApplication(kind: AppKind, title: string, fields: Record<string, unknown>): Promise<{ id: string; url: string | null }> {
  if (!bakurakuMock()) {
    // shortcut: 本物の「申請の作成」は LayerX の回答（下書きで作れるか・フォームID・独自項目の入れ方）待ち。届いたらここだけ差し替える
    throw new Error("バクラクの本番接続はまだ作っていません（LayerX の回答待ち）");
  }
  const { data, error } = await db().from("integration_mocks")
    .insert({ kind: `bakuraku_${kind}`, status: "pending", payload: { title, fields } }).select("id").single();
  if (error) throw error;
  return { id: String(data.id), url: null };
}

export async function applicationStatus(id: string): Promise<AppStatus> {
  if (!bakurakuMock()) throw new Error("バクラクの本番接続はまだ作っていません（LayerX の回答待ち）");
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
