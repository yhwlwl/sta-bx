-- 登录与注册限流（对应 Issue #5）。
--
-- 目标：让「猜密码」和「批量注册」不能无限高速执行，同时不误伤正常用户。
-- 设计要点：
--   * 两把独立的钥匙。账号维度（login:user:<用户名>）阈值更严，挡住针对单个账号的猜密码；
--     IP 维度（login:ip:<地址>）阈值更松，避免同一个出口 IP 下的多名正常同学互相连坐——
--     这正是验收标准「不同账号和不同来源的限流策略不会互相误伤」。
--     注册没有账号维度可言（账号可能还不存在），所以只按 IP 维度记账（见 app_login_record_attempt 的 p_scope）。
--   * 只记录失败计数与锁定时间，不记录任何密码材料；失败原因也不写进审计细节。
--   * 计数自增用一条 insert ... on conflict do update，单语句原子完成。
--     「先 select 再 update」在并发爆破下会丢计数，等于限流形同虚设。
--   * 阈值内不锁定；超出阈值后按 30 秒起、逐次翻倍、封顶 15 分钟给出等待时间。
--   * 成功登录清零账号维度的计数；IP 维度不清零（否则别人猜错可以由我登录来洗掉），
--     只按窗口惰性过期。
--
-- 本文件与 20261006061523/20261006062912 同属新增迁移；散装 SQL（根目录那三份）不动。

create table if not exists public.login_attempts (
  key text primary key,
  failures integer not null default 0 check (failures >= 0),
  window_started_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.login_attempts is
  '登录/注册失败计数与临时锁定。key 形如 login:user:<用户名>、login:ip:<地址>。不存任何密码材料。';

-- 窗口 15 分钟；账号维度连续 5 次失败开始限流；IP 维度更松（20 次）只挡真正的批量爆破。
create or replace function private.app_login_throttle_window_seconds() returns integer
language sql immutable as $$ select 900 $$;

create or replace function private.app_login_throttle_threshold(p_key text) returns integer
language sql immutable as $$
  select case when p_key like 'login:user:%' then 5 else 20 end
$$;

-- 递增等待：阈值内返回 0（不锁定）；超过阈值的第 k 次等待 min(900, 30 * 2^(k-1)) 秒。
-- 注意括号：PostgreSQL 里 `^` 的结合力比 `*` 更紧，写成 `least(900, 30 * 2 ^ k::integer)` 会算错
-- （实测首次锁定会变成 60 秒而不是 30 秒），所以这里显式给 2 加 numeric 类型并把整个幂运算括起来。
create or replace function private.app_login_throttle_wait_seconds(p_failures integer, p_threshold integer) returns integer
language sql immutable as $$
  select case
    when p_failures <= p_threshold then 0
    else least(900, (30 * (2::numeric ^ (p_failures - p_threshold - 1)))::integer)
  end
$$;

-- 剩余等待秒数：未锁定返回 0（至少 1 秒，避免客户端拿 0 反复立刻重试）。
create or replace function private.app_login_retry_after_seconds(p_locked_until timestamptz) returns integer
language sql stable as $$
  select case
    when p_locked_until is null or p_locked_until <= now() then 0
    else greatest(1, ceil(extract(epoch from (p_locked_until - now())))::integer)
  end
$$;

-- 给出锁定详情；未锁定返回 null。retry_after_seconds 统一 cast 成 int，避免 JSON 里出现数字字符串。
create or replace function private.app_login_lock_json(p_key text, p_locked_until timestamptz)
returns jsonb language sql stable as $$
  select case
    when p_locked_until is null or p_locked_until <= now() then null
    else jsonb_build_object(
      'key', p_key,
      'retry_after_seconds', private.app_login_retry_after_seconds(p_locked_until),
      'locked_until', p_locked_until
    )
  end
$$;

-- 记账：判定窗口是否过期 → 原子自增 → 超出阈值就续上锁定。
-- 通过输出参数回传「本次写入有没有刚好触发锁定」：调用方需要在这次响应里就告知用户被限流，
-- 而不是等下一次请求才发现——否则第 6 次会返回「密码不正确」、第 7 次才 429，
-- 等于让攻击者从响应差异里看出账号是否已经进入锁定状态。
create or replace function private.app_login_track_failure(p_key text, p_now timestamptz, out o_locked_until timestamptz, out o_lock_applied boolean)
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  window_seconds integer := private.app_login_throttle_window_seconds();
  threshold_value integer := private.app_login_throttle_threshold(p_key);
  current_failures integer;
  previous_locked_until timestamptz;
begin
  insert into public.login_attempts(key, failures, window_started_at, last_attempt_at, locked_until, updated_at)
  values (p_key, 1, p_now, p_now, null, p_now)
  on conflict (key) do update
  set failures = case
        when public.login_attempts.last_attempt_at < p_now - make_interval(secs => window_seconds)
          then 1
        else public.login_attempts.failures + 1
      end,
      window_started_at = case
        when public.login_attempts.last_attempt_at < p_now - make_interval(secs => window_seconds)
          then p_now
        else public.login_attempts.window_started_at
      end,
      last_attempt_at = p_now,
      updated_at = p_now
  returning failures, locked_until into current_failures, previous_locked_until;

  if current_failures > threshold_value then
    o_locked_until := p_now + make_interval(secs => private.app_login_throttle_wait_seconds(current_failures, threshold_value));
    update public.login_attempts
    set locked_until = o_locked_until, updated_at = p_now
    where key = p_key;
    o_lock_applied := true;
  else
    o_locked_until := previous_locked_until;
    o_lock_applied := false;
  end if;
end $$;

-- 只读检查：返回 { blocked: false } 或 { blocked: true, retry_after_seconds, key }。
-- 顺带惰性清理早已过期的行，避免表无限增长（这个项目没有额外的清理定时任务）。
create or replace function public.app_login_gate(p_username text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  now_value timestamptz := now();
  key_value text;
  locked_value timestamptz;
  account_lock jsonb;
  ip_lock jsonb;
  window_seconds integer := private.app_login_throttle_window_seconds();
begin
  delete from public.login_attempts
  where last_attempt_at < now_value - make_interval(secs => 2 * window_seconds);

  if coalesce(trim(p_username), '') <> '' then
    key_value := 'login:user:' || lower(trim(p_username));
    select locked_until into locked_value from public.login_attempts where key = key_value;
    account_lock := private.app_login_lock_json(key_value, locked_value);
  end if;

  if coalesce(trim(p_ip), '') <> '' then
    key_value := 'login:ip:' || trim(p_ip);
    select locked_until into locked_value from public.login_attempts where key = key_value;
    ip_lock := private.app_login_lock_json(key_value, locked_value);
  end if;

  -- 两把钥匙都超阈值时，选等待时间更长的那把（返回 ->> 'retry_after_seconds' 已 cast 成 int，
  -- 这里显式再转一次，避免 JSON 数字在不同驱动下变成字符串）。
  if account_lock is not null and ip_lock is not null then
    if (account_lock ->> 'retry_after_seconds')::int >= (ip_lock ->> 'retry_after_seconds')::int then
      return jsonb_build_object('blocked', true) || account_lock;
    end if;
    return jsonb_build_object('blocked', true) || ip_lock;
  end if;
  if account_lock is not null then return jsonb_build_object('blocked', true) || account_lock; end if;
  if ip_lock is not null then return jsonb_build_object('blocked', true) || ip_lock; end if;
  return jsonb_build_object('blocked', false);
end $$;

-- 记一次结果。
--   p_scope = 'both'（登录）：成功 → 清零账号维度；失败 → 账号与 IP 两个维度各自自增。
--   p_scope = 'ip'（注册）：只动 IP 维度。注册失败时账号可能还不存在（甚至用户名非法），
--     拿它当「账号维度」记账没有意义；成功也不清零 IP 计数，否则脚本换个自己刚注册的账号
--     成功登录一次就能把 IP 计数洗掉。
create or replace function public.app_login_record_attempt(
  p_username text,
  p_password_correct boolean,
  p_ip text default '',
  p_scope text default 'both'
)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  now_value timestamptz := now();
  username_value text := lower(trim(coalesce(p_username, '')));
  ip_value text := trim(coalesce(p_ip, ''));
  scope_value text := coalesce(nullif(trim(p_scope), ''), 'both');
  account_key text;
  ip_key text;
  account_lock jsonb;
  lock_applied boolean;
  ignore_lock timestamptz;
  ignore_applied boolean;
begin
  if p_password_correct then
    if scope_value = 'both' and username_value <> '' then
      delete from public.login_attempts where key = 'login:user:' || username_value;
    end if;
    return jsonb_build_object('throttled', false);
  end if;

  if scope_value = 'both' and username_value <> '' then
    account_key := 'login:user:' || username_value;
    select o_locked_until, o_lock_applied into ignore_lock, lock_applied
    from private.app_login_track_failure(account_key, now_value);
  end if;
  if ip_value <> '' then
    ip_key := 'login:ip:' || ip_value;
    select o_locked_until, o_lock_applied into ignore_lock, ignore_applied
    from private.app_login_track_failure(ip_key, now_value);
    lock_applied := coalesce(lock_applied, false) or ignore_applied;
  end if;

  if account_key is not null then
    account_lock := private.app_login_lock_json(
      account_key,
      (select locked_until from public.login_attempts where key = account_key)
    );
  end if;

  -- 本次响应就要带上限流结论：account_lock 覆盖「上一次已经锁住、这次又失败」的情况，
  -- lock_applied 覆盖「这一次刚好跨过阈值」的情况——两者都要让调用方返回 429。
  if account_lock is not null then
    return jsonb_build_object(
      'throttled', true,
      'retry_after_seconds', (account_lock ->> 'retry_after_seconds')::int
    );
  end if;
  if coalesce(lock_applied, false) then
    return jsonb_build_object(
      'throttled', true,
      'retry_after_seconds', private.app_login_retry_after_seconds(
        (select locked_until from public.login_attempts
          where key = coalesce(account_key, ip_key))
      )
    );
  end if;
  return jsonb_build_object('throttled', false);
end $$;

-- 超级管理员解锁/恢复路径（验收标准要求）。普通管理员没有权限。
-- 同时清掉账号维度与（可选）来源 IP 维度：只清账号会在同一台机器继续爆破时被 IP 维度挡住。
create or replace function public.app_admin_reset_login_throttle(p_actor_id uuid, p_username text, p_ip text default '')
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  username_value text := lower(trim(coalesce(p_username, '')));
  ip_value text := trim(coalesce(p_ip, ''));
  account_removed integer := 0;
  ip_removed integer := 0;
begin
  if not private.app_user_is_superadmin(p_actor_id) then
    raise exception '只有内置超级管理员可以解除登录限制';
  end if;
  if username_value <> '' then
    delete from public.login_attempts where key = 'login:user:' || username_value;
    get diagnostics account_removed = row_count;
  end if;
  if ip_value <> '' then
    delete from public.login_attempts where key = 'login:ip:' || ip_value;
    get diagnostics ip_removed = row_count;
  end if;
  return jsonb_build_object('removed', account_removed + ip_removed);
end $$;

-- 与仓库既有函数一致：只允许 service_role 通过 app-api 调用，anon/authenticated 一律收权。
revoke all on function public.app_login_gate(text, text) from public, anon, authenticated;
revoke all on function public.app_login_record_attempt(text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.app_admin_reset_login_throttle(uuid, text, text) from public, anon, authenticated;
grant execute on function public.app_login_gate(text, text) to service_role;
grant execute on function public.app_login_record_attempt(text, boolean, text, text) to service_role;
grant execute on function public.app_admin_reset_login_throttle(uuid, text, text) to service_role;

alter table public.login_attempts enable row level security;
revoke all on table public.login_attempts from public, anon, authenticated;
