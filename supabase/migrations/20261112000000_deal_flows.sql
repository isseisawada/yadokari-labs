-- 受注〜納品〜請求の流れの記録、バクラク・freee のにせもの（鍵が来るまで）、freee の鍵の控え
-- 連携処理（Edge Function）だけが service role で読み書きする。画面からは触らない。

create table if not exists public.deal_flows (
  hubspot_deal_id      text primary key,
  ns                   text not null check (ns in ('test', 'prod')),
  quote_id             text not null,
  status               text not null check (status in ('order_pending', 'order_rejected', 'delivery_pending', 'delivery_rejected', 'done')),
  project_no           text not null,
  order_app_id         text,
  delivery_app_id      text,
  freee_segment_tag_id bigint,
  deposit_invoice_id   bigint,
  final_invoice_id     bigint,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.integration_mocks (
  id         bigserial primary key,
  kind       text not null,   -- bakuraku_order / bakuraku_delivery / freee_segment_tag / freee_invoice
  status     text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.oauth_tokens (
  provider      text primary key,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz
);

alter table public.deal_flows enable row level security;
alter table public.integration_mocks enable row level security;
alter table public.oauth_tokens enable row level security;
-- ポリシーは作らない（anon からは見えない・書けない）
