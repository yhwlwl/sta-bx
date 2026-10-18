-- 迁移后在事务中执行；不保留任何验证数据。
-- 账号一律用 private.app_insert_user 建，它会同时写入 app_users 与 profiles，
-- 直接插 app_users 会让 audit_logs.actor_id 的外键失败。
begin;
do $$
declare
  uid uuid; other uuid; row jsonb;
  kept text := 'verify-keep-' || replace(gen_random_uuid()::text, '-', '');
  gone text := 'verify-gone-' || replace(gen_random_uuid()::text, '-', '');
  foreign_hash text := 'verify-foreign-' || replace(gen_random_uuid()::text, '-', '');
  current_password text := 'Test-only-1369666';
  blocked boolean;
begin
  row := private.app_insert_user('verify_pw_' || substr(gen_random_uuid()::text, 1, 8), current_password, '验证改密用户', '验证');
  uid := (row->>'id')::uuid;
  row := private.app_insert_user('verify_other_' || substr(gen_random_uuid()::text, 1, 8), current_password, '验证其他用户', '验证');
  other := (row->>'id')::uuid;

  insert into public.app_sessions(token_hash, user_id, expires_at) values
    (kept, uid, now() + interval '1 day'),
    (gone, uid, now() + interval '1 day'),
    (foreign_hash, other, now() + interval '1 day');

  -- 正常改密码：保留当前会话，撤销本账号其他会话，不误伤其他账号。
  perform public.app_change_password(uid, current_password, 'Test-only-1369667', kept);
  if (select count(*) from public.app_sessions where user_id = uid) <> 1 then raise exception '未撤销其他会话'; end if;
  if not exists(select 1 from public.app_sessions where user_id = uid and token_hash = kept) then raise exception '当前会话被误删'; end if;
  if not exists(select 1 from public.app_sessions where token_hash = foreign_hash) then raise exception '误删其他账号的会话'; end if;

  -- 陌生摘要不能保住会话，必须退化为撤销全部。
  insert into public.app_sessions(token_hash, user_id, expires_at) values('verify-new-' || replace(gen_random_uuid()::text, '-', ''), uid, now() + interval '1 day');
  perform public.app_change_password(uid, 'Test-only-1369667', 'Test-only-1369668', 'verify-not-belongs-to-anyone');
  if exists(select 1 from public.app_sessions where user_id = uid) then raise exception '陌生摘要未退化为全部撤销'; end if;

  -- 传 null 表示管理员重置：撤销全部会话。
  insert into public.app_sessions(token_hash, user_id, expires_at) values('verify-reset-' || replace(gen_random_uuid()::text, '-', ''), uid, now() + interval '1 day');
  perform public.app_change_password(uid, 'Test-only-1369668', 'Test-only-1369669', null);
  if exists(select 1 from public.app_sessions where user_id = uid) then raise exception '重置密码未撤销全部会话'; end if;

  -- 旧密码已失效。
  blocked := false;
  begin perform public.app_change_password(uid, current_password, 'Test-only-1369670', null); exception when others then blocked := true; end;
  if not blocked then raise exception '旧密码仍然可用'; end if;

  -- 审计只记录撤销条数，不记录令牌。
  if not exists(select 1 from public.audit_logs where actor_id = uid and event = '修改登录密码' and detail like '撤销其他登录会话%') then
    raise exception '审计未记录会话撤销结果';
  end if;
end $$;
rollback;
