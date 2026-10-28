-- 見積もり ↔ HubSpot 取引のつながりと、承認の記録
-- 連携処理（Edge Function）だけが service role で読み書きする。画面からは直接触らない。

create table if not exists public.quote_links (
  quote_id        text primary key,
  ns              text not null check (ns in ('test', 'prod')),
  hubspot_deal_id text not null,
  status          text not null check (status in ('estimate', 'pending', 'approved', 'rejected')),
  payment_terms   jsonb not null default '{"kind":"lump"}',
  new_customer    boolean not null default false,
  steps           text[] not null default '{manager}',   -- 承認の順番
  reasons         text[] not null default '{}',          -- コーポレートに回る理由
  quote           jsonb not null,                        -- 承認時点の見積もり（あとから変わらないように控える）
  slack_channel   text,
  slack_ts        text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists quote_links_deal on public.quote_links (hubspot_deal_id);

create table if not exists public.quote_approvals (
  id          bigserial primary key,
  quote_id    text not null references public.quote_links (quote_id) on delete cascade,
  step        text not null check (step in ('manager', 'corporate')),
  decision    text not null check (decision in ('approved', 'rejected')),
  slack_user  text not null,
  decided_at  timestamptz not null default now()
);

alter table public.quote_links enable row level security;
alter table public.quote_approvals enable row level security;
-- ポリシーは作らない（anon からは見えない・書けない）
