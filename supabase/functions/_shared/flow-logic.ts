// 受注〜納品〜請求の流れの決まり（外部に触らない純粋な関数だけ）
import type { PaymentTerms, Quote } from "./logic.ts";

export type FlowStatus =
  | "order_pending" // 受注稟議を出した（承認待ち）
  | "order_rejected"
  | "delivery_pending" // 受注が承認され、納品完了報告の下書きを作った（承認待ち）
  | "delivery_rejected"
  | "done"; // 納品が承認され、残金の請求書の下書きまで作った

export type AppStatus = "pending" | "approved" | "rejected";

/** 案件番号：HubSpot の取引ID を元にする（西浦さん 10/28）。形は仮で「H-取引ID」 */
export const projectNo = (dealId: string) => `H-${dealId}`;

/** 申請の状態から、次にやることを決める */
export function nextStep(status: FlowStatus, app: AppStatus):
  | "wait" | "on_ordered" | "on_order_rejected" | "on_delivered" | "on_delivery_rejected" {
  if (app === "pending") return "wait";
  if (status === "order_pending") return app === "approved" ? "on_ordered" : "on_order_rejected";
  if (status === "delivery_pending") return app === "approved" ? "on_delivered" : "on_delivery_rejected";
  return "wait";
}

export type InvoiceLine = { description: string; quantity: number; unit_price: string; tax_rate: number };

const yen = (n: number) => Math.round(n || 0);

/** 着手金（税抜）。一括なら 0 */
export const depositAmount = (q: Quote, t: PaymentTerms) => (t.kind === "deposit" ? yen((q.totalPre * t.depositPct) / 100) : 0);

/** 着手金の請求書の明細（受注稟議の承認時） */
export function depositLines(q: Quote, t: PaymentTerms): InvoiceLine[] {
  if (t.kind !== "deposit") return [];
  return [{ description: `着手金（ご契約金額の ${t.depositPct}%）`, quantity: 1, unit_price: String(depositAmount(q, t)), tax_rate: 10 }];
}

/** 残金（一括なら全額）の請求書の明細（納品の承認時）。お客様向けの行だけ、値引きと受領済みの着手金はマイナス行 */
export function finalLines(q: Quote, t: PaymentTerms): InvoiceLine[] {
  const lines: InvoiceLine[] = q.sections.flatMap((s) =>
    s.lines
      .filter((l) => !l.internalOnly && yen(l.val) !== 0)
      .map((l) => ({ description: `${s.title}｜${l.name}`.slice(0, 250), quantity: 1, unit_price: String(yen(l.val)), tax_rate: 10 })),
  );
  if ((q.discount ?? 0) > 0) lines.push({ description: "お値引き", quantity: 1, unit_price: String(-yen(q.discount!)), tax_rate: 10 });
  const dep = depositAmount(q, t);
  if (dep > 0) lines.push({ description: "着手金（ご請求済み）", quantity: 1, unit_price: String(-dep), tax_rate: 10 });
  return lines;
}

export const sumLines = (ls: InvoiceLine[]) => ls.reduce((a, l) => a + Number(l.unit_price) * l.quantity, 0);
