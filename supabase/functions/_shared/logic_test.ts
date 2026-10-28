import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { approvalSteps, corporateReasons, dealProperties, lineItems, parseTerms, stageIdByPrefix, type Quote } from "./logic.ts";

const rules = { marginThresholdPct: 30, standardDepositPcts: [0, 50] };
const q = (o: Partial<Quote> = {}): Quote => ({
  id: "q1",
  sections: [{ title: "本体", lines: [{ name: "ROADIE", val: 5_000_000, cost: 3_000_000 }, { name: "仲介", val: 100, internalOnly: true }] }],
  totalPre: 5_000_000,
  totalCost: 3_000_000,
  totalGross: 2_000_000,
  marginPct: 40,
  ...o,
});

Deno.test("標準の見積は上長だけ", () => {
  assertEquals(approvalSteps({ quote: q(), terms: { kind: "lump" }, newCustomer: false }, rules), ["manager"]);
  assertEquals(approvalSteps({ quote: q(), terms: { kind: "deposit", depositPct: 50 }, newCustomer: false }, rules), ["manager"]);
});

Deno.test("例外はコーポレートにも回る", () => {
  const r = corporateReasons({ quote: q({ discount: 1, marginPct: 20 }), terms: { kind: "deposit", depositPct: 30 }, newCustomer: true }, rules);
  assertEquals(r.length, 4);
  assertEquals(approvalSteps({ quote: q({ marginPct: 29.9 }), terms: { kind: "lump" }, newCustomer: false }, rules), ["manager", "corporate"]);
});

Deno.test("明細は社内向けの行を除き、値引きはマイナス", () => {
  assertEquals(lineItems(q({ discount: 200_000 })), [
    { name: "本体｜ROADIE", price: "5000000", quantity: "1" },
    { name: "値引き", price: "-200000", quantity: "1" },
  ]);
});

Deno.test("取引の項目", () => {
  const p = dealProperties(q(), { kind: "deposit", depositPct: 50 }, "estimate");
  assertEquals([p.amount, p.yk_plan_gross, p.yk_plan_margin_pct, p.yk_deposit_pct], ["5000000", "2000000", "40.0", "50"]);
});

Deno.test("段階と支払条件の読み取り", () => {
  assertEquals(stageIdByPrefix([{ id: "1", label: "計画" }, { id: "2", label: "D.提案（概算見積提示）" }], "D."), "2");
  assertEquals(parseTerms(undefined), { kind: "lump" });
  assertThrows(() => parseTerms({ kind: "deposit", depositPct: 0 }));
});
