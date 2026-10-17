-- 群里的手动指令：/check 待办汇总，/check resend 补发提醒。
--
-- 两个函数都只给 service_role 用，入口是 Edge Function qq-bot（先验 Ed25519 签名）。
-- 之所以把统计和补发写在 SQL 里：判重索引、状态映射、负责人规则都在这儿，
-- 放到 TypeScript 里必然要和既有逻辑对第二遍，迟早跑偏。
--
-- 状态键以 private.app_notify_event_for_status 的映射表为准：
-- finance_pending / chair_pending / payment_pending / payment_info_required / changes_requested。

-- 待办汇总：只看"还需要有人动手"的五个状态，按状态分组，每组最多列 3 条。
create or replace function public.app_qq_check_report()
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  sts constant text[] := array['finance_pending','chair_pending','payment_pending','payment_info_required','changes_requested'];
  v_group text;
  v_total integer := 0;
  v_out text;
  v_st text;
  v_label text;
  v_n integer;
  v_items text;
  v_names text;
begin
  select coalesce(s.qq_group_openid,'') into v_group from public.settings s where s.id=1;
  select count(*) into v_total from public.applications a where a.status = any(sts);

  v_out := '【待办检查】' || to_char(now() at time zone 'Asia/Shanghai','MM-DD HH24:MI');
  if v_total = 0 then
    return v_out || E'\n当前没有待处理事项。';
  end if;
  v_out := v_out || E'\n共 ' || v_total || ' 条待处理';

  foreach v_st in array sts loop
    select count(*) into v_n from public.applications a where a.status = v_st;
    if v_n = 0 then continue; end if;
    v_label := coalesce(nullif(private.app_status_label(v_st),''), v_st);

    select string_agg(x.line, E'\n' order by x.updated_at) into v_items from (
      select '· ' || left(a.title,20)
             || ' ¥' || to_char(a.amount,'FM9999999999990.00')
             || ' · ' || coalesce(nullif(trim(u.full_name),''),u.username)
             || ' · 已等 ' || greatest(0, floor(extract(epoch from now()-a.updated_at)/86400))::int || ' 天' as line,
             a.updated_at
      from public.applications a join public.app_users u on u.id = a.owner_id
      where a.status = v_st
      order by a.updated_at
      limit 3
    ) x;

    select string_agg(distinct t.display_name,'、') into v_names
      from public.applications a, lateral private.qq_notify_targets(a.id, v_label, v_group) t
      where a.status = v_st;

    v_out := v_out || E'\n\n' || v_label || ' ' || v_n || ' 条'
      || case when coalesce(v_names,'')<>'' then '（' || v_names || '）' else '' end
      || E'\n' || coalesce(v_items,'· 无')
      || case when v_n > 3 then E'\n…还有 ' || (v_n-3) || ' 条' else '' end;
  end loop;

  if length(v_out) > 1500 then v_out := left(v_out,1500) || E'\n…内容过长已截断'; end if;
  return v_out;
end $$;
revoke all on function public.app_qq_check_report() from public, anon, authenticated;
grant execute on function public.app_qq_check_report() to service_role;

-- 补发：把投递失败的重新排队，并把"状态该提醒、却从来没进过队列"的补进去。
-- 判重索引 (application_id, version, event, group_openid) where status<>'cancelled'
-- 保证重复执行不会灌出重复消息；已经发过的行仍在，属于 on conflict do nothing。
create or replace function public.app_qq_resend()
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_enabled boolean;
  v_group text;
  v_events text[];
  v_failed integer := 0;
  v_enqueued integer := 0;
  v_pending integer := 0;
begin
  select qq_notify_enabled, coalesce(qq_group_openid,''), coalesce(qq_notify_events,array[]::text[])
    into v_enabled, v_group, v_events
    from public.settings where id=1;
  if not coalesce(v_enabled,false) or v_group='' then
    return jsonb_build_object('ok',false,'reason','未开启QQ群提醒');
  end if;

  with reset as (
    update public.qq_notifications
      set status='pending', attempts=0, next_attempt_at=now(), claim_id=null,
          lease_expires_at=null, last_error='手动补发'
      where status='failed' and group_openid=v_group
      returning 1
  ) select count(*) into v_failed from reset;

  with ins as (
    insert into public.qq_notifications(application_id,application_version,event,group_openid)
    select a.id, a.version, e.ev, v_group
    from public.applications a
    cross join lateral (select private.app_notify_event_for_status(a.status) as ev) e
    where a.status in ('finance_pending','chair_pending','payment_pending','payment_info_required','changes_requested')
      and a.updated_at > now() - interval '7 days'
      and e.ev = any(v_events)
    on conflict (application_id,application_version,event,group_openid) where status<>'cancelled' do nothing
    returning 1
  ) select count(*) into v_enqueued from ins;

  select count(*) into v_pending from public.qq_notifications where status='pending' and group_openid=v_group;
  return jsonb_build_object('ok',true,'failed',v_failed,'enqueued',v_enqueued,'pending',v_pending);
end $$;
revoke all on function public.app_qq_resend() from public, anon, authenticated;
grant execute on function public.app_qq_resend() to service_role;
