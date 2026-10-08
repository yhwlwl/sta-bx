-- 迁移后在事务中执行；不保留任何验证数据。
-- 这里验证的是「限流本身的规则」和「接线是否正确」；真实 HTTP 行为由
-- tests/login-throttle.test.mjs 通过 app-api 的 handler 端到端验证。
begin;
do $$
declare
  super_id uuid;
  ops_admin_id uuid;
  fresh_key text := 'login:user:verify_throttle_' || substr(gen_random_uuid()::text, 1, 8);
  user_key text := 'verify_throttle_' || substr(gen_random_uuid()::text, 1, 8);
  ip_address text := '203.0.113.' || (1 + floor(random() * 200))::int;
  state jsonb;
  failures_before integer;
  failures_after integer;
  locked_before timestamptz;
  locked_after timestamptz;
  threshold_value integer;
  wait_value integer;
begin
  select id into super_id from public.app_users where lower(username) = 'admin' and active;
  if super_id is null then raise exception 'built-in admin is required'; end if;

  -- 1) 未注册过的账号不存在任何计数：gate 必须返回 blocked=false，而不是报错或误锁。
  state := public.app_login_gate(user_key, ip_address);
  if (state ->> 'blocked')::boolean is not false then raise exception '新账号不应被限流：%', state; end if;

  -- 2) 阈值边界：账号维度连续失败 5 次仍不锁定（不误伤输错几次的正常用户），第 6 次才锁。
  threshold_value := private.app_login_throttle_threshold(fresh_key);
  if threshold_value <> 5 then raise exception '账号维度阈值应为 5，实际 %', threshold_value; end if;
  if private.app_login_throttle_threshold('login:ip:' || ip_address) <> 20 then raise exception 'IP 维度阈值应为 20'; end if;

  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '第 1 次失败不应限流：%', state; end if;
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '第 2 次失败不应限流：%', state; end if;
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '第 3 次失败不应限流：%', state; end if;
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '第 4 次失败不应限流：%', state; end if;
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '第 5 次失败（阈值内）不应限流：%', state; end if;

  -- 3) 第 6 次失败开始限流，等待时间 30 秒起。
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'throttled')::boolean is not true then raise exception '第 6 次失败应被限流：%', state; end if;
  if (state ->> 'retry_after_seconds')::int <> 30 then raise exception '首次限流应为 30 秒，实际 %', state; end if;

  -- 4) 递增等待：第 7 次失败翻倍到 60 秒。
  state := public.app_login_record_attempt(user_key, false, ip_address);
  if (state ->> 'retry_after_seconds')::int <> 60 then raise exception '递增等待应为 60 秒，实际 %', state; end if;

  -- 5) 锁定后 gate 必须拦住（这是 app-api 在密码校验之前调用它的依据）。
  state := public.app_login_gate(user_key, ip_address);
  if (state ->> 'blocked')::boolean is not true then raise exception '锁定后 gate 应拦住：%', state; end if;
  if (state ->> 'key') <> 'login:user:' || user_key then raise exception '限流应归属账号维度：%', state; end if;
  if (state ->> 'retry_after_seconds')::int <= 0 then raise exception '剩余等待时间应为正数：%', state; end if;

  -- 6) 自增必须是单语句原子操作：「先 select 再 update」在并发下会丢计数，测试 sql-migrations 只断言补丁整齐，
  --    所以这里直接用 SQL 文本证明实现方式是 insert ... on conflict do update。
  if not exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'app_login_track_failure'
      and position('on conflict' in lower(p.prosrc)) > 0
  ) then
    raise exception '失败计数必须以 insert ... on conflict do update 原子自增';
  end if;

  -- 7) 第三个维度：别的账号登录失败不影响我（不同账号不互相误伤）。
  state := public.app_login_gate(fresh_key, '198.51.100.7');
  if (state ->> 'blocked')::boolean is not false then raise exception '他人失败不应连坐其他账号：%', state; end if;

  -- 8) 成功后清零账号维度：可以立刻重新登录。
  state := public.app_login_record_attempt(user_key, true, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '成功清零不应返回限流：%', state; end if;
  state := public.app_login_gate(user_key, ip_address);
  if (state ->> 'blocked')::boolean is not false then raise exception '成功登录后不应仍被限流：%', state; end if;

  -- 9) IP 维度不会被「别人成功登录」洗掉：这是刻意的，否则爆破者换个自己的账号成功登录就能重置 IP 计数。
  update public.login_attempts set failures = 25, locked_until = now() + interval '10 minutes'
  where key = 'login:ip:' || ip_address;
  state := public.app_login_record_attempt('verify_other_' || substr(gen_random_uuid()::text, 1, 8), true, ip_address);
  if (state ->> 'throttled')::boolean is not false then raise exception '记录成功结果不应报限流：%', state; end if;
  if not exists(select 1 from public.login_attempts where key = 'login:ip:' || ip_address and locked_until is not null and failures = 25) then
    raise exception 'IP 维度计数不应被其他账号的成功登录清零';
  end if;

  -- 10) gate 只看失败计数，不校验密码：不存在账号也走同一条路径（不泄露账号是否存在）。
  state := public.app_login_gate('verify_missing_' || substr(gen_random_uuid()::text, 1, 8), '');
  if (state ->> 'blocked')::boolean is not false then raise exception '不存在的账号在无失败记录时不应被限流：%', state; end if;

  -- 11) 阈值边界与等待时间的纯函数行为（这条曾经抓到 `^` 优先级导致首次锁 60 秒的真实 bug）。
  if private.app_login_throttle_wait_seconds(5, 5) <> 0 then raise exception '阈值内不应有等待时间'; end if;
  if private.app_login_throttle_wait_seconds(6, 5) <> 30 then raise exception '第 6 次失败应等 30 秒，实际 %', private.app_login_throttle_wait_seconds(6, 5); end if;
  if private.app_login_throttle_wait_seconds(7, 5) <> 60 then raise exception '第 7 次失败应等 60 秒，实际 %', private.app_login_throttle_wait_seconds(7, 5); end if;
  if private.app_login_throttle_wait_seconds(10, 5) <> 480 then raise exception '第 10 次失败应等 480 秒（30×2^4），实际 %', private.app_login_throttle_wait_seconds(10, 5); end if;
  if private.app_login_throttle_wait_seconds(20, 5) <> 900 then raise exception '等待时间必须封顶 900 秒，实际 %', private.app_login_throttle_wait_seconds(20, 5); end if;

  -- 12) 超级管理员解锁路径存在且普通管理员不可用。
  state := public.app_admin_reset_login_throttle(super_id, user_key, ip_address);
  if (state ->> 'removed')::int < 1 then raise exception '超管解锁应删除限流记录：%', state; end if;
  if exists(select 1 from public.login_attempts where key = 'login:user:' || user_key) then raise exception '解锁后账号维度记录应被清除'; end if;
  if exists(select 1 from public.login_attempts where key = 'login:ip:' || ip_address) then raise exception '解锁后 IP 维度记录应被清除'; end if;

  state := public.app_login_gate(user_key, ip_address);
  if (state ->> 'blocked')::boolean is not false then raise exception '解锁后应恢复登录：%', state; end if;

  select id into ops_admin_id from public.app_users where lower(username) = 'admin' and active;
  if private.app_user_is_superadmin(super_id) is not true then raise exception '内置 admin 必须是超级管理员'; end if;

  begin
    perform public.app_admin_reset_login_throttle(gen_random_uuid(), user_key);
    raise exception '非超管不得解除登录限制';
  exception when others then
    if position('只有内置超级管理员' in sqlerrm) = 0 then raise; end if;
  end;

  -- 13) 收权：anon/authenticated 不得直接调用，也不得读表。
  if has_function_privilege('anon', 'public.app_login_gate(text,text)', 'execute') then raise exception 'anon 不应能调用 app_login_gate'; end if;
  if has_function_privilege('authenticated', 'public.app_login_record_attempt(text,boolean,text,text)', 'execute') then raise exception 'authenticated 不应能调用 app_login_record_attempt'; end if;
  if has_function_privilege('authenticated', 'public.app_admin_reset_login_throttle(uuid,text,text)', 'execute') then raise exception 'authenticated 不应能调用 app_admin_reset_login_throttle'; end if;
  if has_table_privilege('authenticated', 'public.login_attempts', 'select') then raise exception 'authenticated 不应能读 login_attempts'; end if;
  if not has_function_privilege('service_role', 'public.app_login_gate(text,text)', 'execute') then raise exception 'service_role 必须能调用 app_login_gate'; end if;

  -- 14) 自增确实是原子的：连续两次失败必须严格 +1（不是被窗口重置成 1）。
  state := public.app_login_record_attempt(fresh_key, false, '');
  state := public.app_login_record_attempt(fresh_key, false, '');
  select failures into failures_after from public.login_attempts where key = fresh_key;
  if failures_after <> 2 then raise exception '同一窗口内连续失败应累计为 2，实际 %', failures_after; end if;

  -- 15) 窗口过期后重新计数，而不是继续累加（惰性过期，不需要额外的清理任务）。
  update public.login_attempts
  set last_attempt_at = now() - interval '1 hour', window_started_at = now() - interval '1 hour', locked_until = now() - interval '1 minute'
  where key = fresh_key;
  select failures into failures_before from public.login_attempts where key = fresh_key;
  state := public.app_login_record_attempt(fresh_key, false, '');
  select failures into failures_after from public.login_attempts where key = fresh_key;
  if failures_after <> 1 then raise exception '窗口过期后应从 1 重新计数，实际 %（之前 %）', failures_after, failures_before; end if;
  select locked_until into locked_after from public.login_attempts where key = fresh_key;
  if locked_after is not null then raise exception '窗口重置后不应保留旧锁定'; end if;

  -- 16) gate 的惰性清理：两倍窗口之前的记录会被删掉。
  insert into public.login_attempts(key, failures, window_started_at, last_attempt_at, locked_until, updated_at)
  values ('login:ip:192.0.2.250', 3, now() - interval '3 hours', now() - interval '3 hours', null, now() - interval '3 hours')
  on conflict (key) do update set last_attempt_at = excluded.last_attempt_at;
  perform public.app_login_gate('verify_cleanup_' || substr(gen_random_uuid()::text, 1, 8), '192.0.2.250');
  if exists(select 1 from public.login_attempts where key = 'login:ip:192.0.2.250') then
    raise exception '过期记录应被 gate 惰性清理';
  end if;
end $$;
rollback;
