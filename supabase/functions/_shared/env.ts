// 設定値とテスト・本番の切り替え
import { createClient } from "npm:@supabase/supabase-js@2";
import type { ApprovalRules } from "./logic.ts";

const list = (k: string) => (Deno.env.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/**
 * テスト（ns=test）はテスト用パイプラインの取引にしか書き込まない。
 * 本番（ns=prod）は QUOTE_HUBSPOT_PROD=on にするまで動かない。
 */
export function allowedPipeline(ns: string): string {
  if (ns === "test") {
    const p = Deno.env.get("HUBSPOT_TEST_PIPELINE_ID");
    if (!p) throw new Error("HUBSPOT_TEST_PIPELINE_ID が未設定です");
    return p;
  }
  if (ns === "prod" && Deno.env.get("QUOTE_HUBSPOT_PROD") === "on") return Deno.env.get("HUBSPOT_PROD_PIPELINE_ID") ?? "default";
  throw new Error("本番の連携はまだ有効になっていません");
}

export const rules = (): ApprovalRules => ({
  marginThresholdPct: Number(Deno.env.get("APPROVAL_MARGIN_THRESHOLD_PCT") ?? "30"),
  standardDepositPcts: (list("APPROVAL_STANDARD_DEPOSIT_PCTS").length ? list("APPROVAL_STANDARD_DEPOSIT_PCTS") : ["0", "50"]).map(Number),
});

/** 承認できる人（Slack のユーザーID）。テスト中はさわださんだけを入れる */
export const approvers = (step: "manager" | "corporate") =>
  list(step === "manager" ? "SLACK_MANAGER_USER_IDS" : "SLACK_CORPORATE_USER_IDS");

export const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "https://isseisawada.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
