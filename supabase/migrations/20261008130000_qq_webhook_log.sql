-- 回调可观测性：每个进到 qq-bot 的请求留一行。
--
-- 起因：群里发 /check 没反应，但既没有审计记录也没有函数日志可查，
-- 分不清是"QQ 根本没推过来"还是"推过来了但被签名/群号挡住"。
-- 这张表只为诊断存在，不参与业务；保留 7 天，写入失败不影响主流程。

create table if not exists public.qq_webhook_log (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  op integer,
  event_type text not null default '',
  group_openid text not null default '',
  signature_ok boolean not null default false,
  outcome text not null default '',
  detail text not null default ''
);

alter table public.qq_webhook_log enable row level security;
revoke all on public.qq_webhook_log from public, anon, authenticated;
grant all on public.qq_webhook_log to service_role;
grant usage, select on sequence public.qq_webhook_log_id_seq to service_role;

create index if not exists qq_webhook_log_recent_idx on public.qq_webhook_log(received_at desc);

-- 顺手清掉过期行，避免这张表无限长大。
create or replace function private.qq_webhook_log_trim() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.qq_webhook_log where received_at < now() - interval '7 days';
$$;
revoke all on function private.qq_webhook_log_trim() from public, anon, authenticated;
grant execute on function private.qq_webhook_log_trim() to service_role;
