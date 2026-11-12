import { assertEquals } from "jsr:@std/assert@1";
import { depositLines, finalLines, nextStep, projectNo, sumLines } from "./flow-logic.ts";
import type { Quote } from "./logic.ts";

const q: Quote = {
  id: "q1",
  sections: [{ title: "本体", lines: [{ name: "ROADIE", val: 10_000_000 }, { name: "仲介", val: 500, internalOnly: true }] }],
  discount: 200_000,
  totalPre: 9_800_000,
  totalCost: 6_000_000,
  totalGross: 3_800_000,
  marginPct: 38.8,
};

Deno.test("着手金と残金を足すと税抜の合計になる", () => {
  const t = { kind: "deposit" as const, depositPct: 50 };
  assertEquals(sumLines(depositLines(q, t)), 4_900_000);
  assertEquals(sumLines(depositLines(q, t)) + sumLines(finalLines(q, t)), q.totalPre);
});

Deno.test("一括なら着手金なし、残金の請求書が全額", () => {
  const t = { kind: "lump" as const };
  assertEquals(depositLines(q, t), []);
  assertEquals(sumLines(finalLines(q, t)), q.totalPre);
  assertEquals(finalLines(q, t).some((l) => l.description.includes("仲介")), false);
});

Deno.test("申請の状態から次の一手", () => {
  assertEquals(nextStep("order_pending", "pending"), "wait");
  assertEquals(nextStep("order_pending", "approved"), "on_ordered");
  assertEquals(nextStep("order_pending", "rejected"), "on_order_rejected");
  assertEquals(nextStep("delivery_pending", "approved"), "on_delivered");
  assertEquals(nextStep("done", "approved"), "wait");
  assertEquals(projectNo("123"), "H-123");
});
