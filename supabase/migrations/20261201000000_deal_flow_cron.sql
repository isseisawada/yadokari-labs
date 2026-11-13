-- 12/1 バクラクの鍵が入ってから適用する：10分おきに deal-flow の poll を呼び、承認された申請を先に進める
-- （バクラクには承認を知らせる仕組みが無いので、こちらから見に行く）
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('deal-flow-poll-test', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://bvwyyocqynbftjnkzsvw.supabase.co/functions/v1/deal-flow',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "poll", "ns": "test"}'::jsonb
  );
$$);
