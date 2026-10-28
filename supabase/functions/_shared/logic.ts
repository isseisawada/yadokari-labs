// 見積もり → HubSpot 取引・承認ルートの変換（外部に触らない純粋な関数だけ）

export type QuoteLine = {
  name: string;
  val: number;
  cost?: number;
  internalOnly?: boolean;
  passThrough?: boolean;
};
export type Quote = {
  id: string;
  customerName?: string;
  staffName?: string;
  area?: string;
  sections: { title: string; lines: QuoteLine[] }[];
  discount?: number;
  totalPre: number;
  totalCost: number;
  totalGross: number;
  internalRevenue?: number;
  marginPct: number;
};

export type PaymentTerms = { kind: "lump" } | { kind: "deposit"; depositPct: number };

export type ApprovalRules = {
  marginThresholdPct: number; // これ未満はコーポレートにも回す
  standardDepositPcts: number[]; // 標準の着手金の割合（0 = 一括）
};

export type ApprovalInput = { quote: Quote; terms: PaymentTerms; newCustomer: boolean };

/** コーポレートにも回す理由（空なら上長だけ） */
export function corporateReasons(i: ApprovalInput, r: ApprovalRules): string[] {
  const reasons: string[] = [];
  if ((i.quote.discount ?? 0) > 0) reasons.push("値引きあり");
  if (i.quote.marginPct < r.marginThresholdPct) {
    reasons.push(`粗利率 ${i.quote.marginPct.toFixed(1)}%（基準 ${r.marginThresholdPct}% 未満）`);
  }
  const pct = i.terms.kind === "lump" ? 0 : i.terms.depositPct;
  if (!r.standardDepositPcts.includes(pct)) reasons.push(`支払条件が標準外（着手金 ${pct}%）`);
  if (i.newCustomer) reasons.push("新規取引先");
  return reasons;
}

/** 承認の順番。上長は全件、理由があればそのあとコーポレート */
export function approvalSteps(i: ApprovalInput, r: ApprovalRules): ("manager" | "corporate")[] {
  return corporateReasons(i, r).length ? ["manager", "corporate"] : ["manager"];
}

const yen = (n: number) => Math.round(n || 0);

/** 取引に書き込む項目（金額は税抜） */
export function dealProperties(q: Quote, terms: PaymentTerms, status: string): Record<string, string> {
  return {
    amount: String(yen(q.totalPre)),
    yk_quote_id: q.id,
    yk_quote_status: status,
    yk_plan_sales: String(yen(q.internalRevenue ?? q.totalPre)),
    yk_plan_cost: String(yen(q.totalCost)),
    yk_plan_gross: String(yen(q.totalGross)),
    yk_plan_margin_pct: q.marginPct.toFixed(1),
    yk_payment_terms: terms.kind,
    yk_deposit_pct: String(terms.kind === "deposit" ? terms.depositPct : 0),
  };
}

/** 取引の明細。お客様向けの行だけ。値引きはマイナスの行で入れる */
export function lineItems(q: Quote): { name: string; price: string; quantity: string }[] {
  const items = q.sections.flatMap((s) =>
    s.lines
      .filter((l) => !l.internalOnly && yen(l.val) !== 0)
      .map((l) => ({ name: `${s.title}｜${l.name}`.slice(0, 250), price: String(yen(l.val)), quantity: "1" })),
  );
  if ((q.discount ?? 0) > 0) items.push({ name: "値引き", price: String(-yen(q.discount!)), quantity: "1" });
  return items;
}

/** パイプラインの段階を「D.」「B.」などの頭文字で探す */
export function stageIdByPrefix(stages: { id: string; label: string }[], prefix: string): string | undefined {
  return stages.find((s) => s.label.startsWith(prefix))?.id;
}

export function parseTerms(v: unknown): PaymentTerms {
  const o = (v ?? {}) as { kind?: string; depositPct?: number };
  if (o.kind === "deposit") {
    const p = Number(o.depositPct);
    if (!(p > 0 && p < 100)) throw new Error("着手金の割合は 1〜99% で入れてください");
    return { kind: "deposit", depositPct: p };
  }
  return { kind: "lump" };
}
