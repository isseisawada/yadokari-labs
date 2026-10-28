// HubSpot API（プライベートアプリの鍵 HUBSPOT_TOKEN を使う）

const BASE = "https://api.hubapi.com";

async function hs<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${Deno.env.get("HUBSPOT_TOKEN")}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : await res.json();
}

export type Deal = { id: string; properties: Record<string, string | null> };
const DEAL_PROPS = ["dealname", "dealstage", "pipeline", "amount", "yk_quote_id", "yk_quote_status"];

/** 取引名で探す。pipeline を渡すとそのパイプラインだけ */
export async function searchDeals(query: string, pipeline?: string): Promise<Deal[]> {
  const filters = pipeline ? [{ propertyName: "pipeline", operator: "EQ", value: pipeline }] : [];
  const r = await hs<{ results: Deal[] }>("POST", "/crm/v3/objects/deals/search", {
    query,
    filterGroups: filters.length ? [{ filters }] : [],
    properties: DEAL_PROPS,
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    limit: 20,
  });
  return r.results;
}

export const getDeal = (id: string) =>
  hs<Deal>("GET", `/crm/v3/objects/deals/${encodeURIComponent(id)}?properties=${DEAL_PROPS.join(",")}`);

export const createDeal = (properties: Record<string, string>) =>
  hs<Deal>("POST", "/crm/v3/objects/deals", { properties });

export const updateDeal = (id: string, properties: Record<string, string>) =>
  hs<Deal>("PATCH", `/crm/v3/objects/deals/${encodeURIComponent(id)}`, { properties });

export async function pipelineStages(pipelineId: string): Promise<{ id: string; label: string }[]> {
  const r = await hs<{ stages: { id: string; label: string }[] }>("GET", `/crm/v3/pipelines/deals/${pipelineId}`);
  return r.stages;
}

/** 取引の明細を入れ替える（前の明細は消す） */
export async function replaceLineItems(dealId: string, items: { name: string; price: string; quantity: string }[]) {
  const assoc = await hs<{ results: { toObjectId: number }[] }>(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/line_items?limit=500`,
  );
  if (assoc.results.length) {
    await hs("POST", "/crm/v3/objects/line_items/batch/archive", {
      inputs: assoc.results.map((a) => ({ id: String(a.toObjectId) })),
    });
  }
  if (!items.length) return;
  await hs("POST", "/crm/v3/objects/line_items/batch/create", {
    inputs: items.map((properties) => ({
      properties,
      // 20 = 明細→取引（HubSpot 標準の関連）
      associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }],
    })),
  });
}

export function dealUrl(id: string) {
  return `https://app-na2.hubspot.com/contacts/${Deno.env.get("HUBSPOT_PORTAL_ID") ?? "246571919"}/record/0-3/${id}`;
}
