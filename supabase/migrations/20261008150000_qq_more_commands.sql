-- 群指令扩充：/stat 概况、/search 查单、/status 运行状态。
--
-- 设计原则：群指令一律只读。群里任何人（包括被拉进来的外部成员）都能触发，
-- 所以除了 /check resend（幂等补发）之外不提供任何会改数据或发消息的操作。
-- 数字都对得上后台页面：待处理口径与 app_qq_check_report 一致，
-- 已付款以 public.payments.created_at 为准（那才是打款时间，不是申请更新时间）。

-- 本月概况
create or replace function public.app_qq_stat()
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_now_local timestamptz := now() at time zone 'Asia/Shanghai';
  v_month timestamptz := date_trunc('month', v_now_local) at time zone 'Asia/Shanghai';
  v_week  timestamptz := date_trunc('week',  v_now_local) at time zone 'Asia/Shanghai';
  v_todo integer; v_todo_amt numeric(14,2);
  v_paid integer; v_paid_amt numeric(14,2);
  v_week_paid integer; v_week_amt numeric(14,2);
  v_new integer;
begin
  select count(*), coalesce(sum(amount),0) into v_todo, v_todo_amt
    from public.applications
   where status in ('finance_pending','chair_pending','payment_pending','payment_info_required','changes_requested');

  select count(*), coalesce(sum(amount),0) into v_paid, v_paid_amt
    from public.payments where created_at >= v_month;

  select count(*), coalesce(sum(amount),0) into v_week_paid, v_week_amt
    from public.payments where created_at >= v_week;

  select count(*) into v_new
    from public.applications
   where created_at >= v_month and status not in ('draft','cancelled');

  return '【本月概况】' || to_char(v_now_local,'YYYY-MM')
    || E'\n待处理 ' || v_todo || ' 笔 · ¥' || to_char(v_todo_amt,'FM9999999999990.00')
    || E'\n本月已付款 ' || v_paid || ' 笔 · ¥' || to_char(v_paid_amt,'FM9999999999990.00')
    || E'\n本周已付款 ' || v_week_paid || ' 笔 · ¥' || to_char(v_week_amt,'FM9999999999990.00')
    || E'\n本月新提交 ' || v_new || ' 笔';
end $$;
revoke all on function public.app_qq_stat() from public, anon, authenticated;
grant execute on function public.app_qq_stat() to service_role;

-- 查单：按标题 / 申请人 / 用户名模糊匹配
create or replace function public.app_qq_search(p_keyword text)
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_kw text := left(trim(coalesce(p_keyword,'')), 40);
  v_kw_esc text;
  v_total integer;
  v_lines text;
begin
  -- 关键字里的通配符要当普通字符，否则一个 % 就能把全库翻出来
  v_kw_esc := replace(replace(replace(v_kw,'\','\\'),'%','\%'),'_','\_');
  if v_kw = '' then
    return '【搜索】请在后面加关键字，例如：/search 物资';
  end if;

  select count(*) into v_total
    from public.applications a join public.app_users u on u.id = a.owner_id
   where a.status <> 'draft'
     and (a.title ilike '%'||v_kw_esc||'%'
       or coalesce(u.full_name,'') ilike '%'||v_kw_esc||'%'
       or u.username ilike '%'||v_kw_esc||'%');

  if v_total = 0 then
    return '【搜索】没有找到「' || v_kw || '」相关的申请。';
  end if;

  select string_agg(t.line, E'\n' order by t.rank desc, t.updated_at desc) into v_lines from (
    select '· ' || left(a.title,18)
           || ' ¥' || to_char(a.amount,'FM9999999999990.00')
           || ' · ' || coalesce(nullif(trim(u.full_name),''),u.username)
           || ' · ' || private.app_status_label(a.status)
           || ' · ' || to_char(a.updated_at at time zone 'Asia/Shanghai','MM-DD') as line,
           a.updated_at,
           -- 还没办完的排前面：搜出来一堆同名申请时，先看到该处理的
           (a.status in ('finance_pending','chair_pending','payment_pending','payment_info_required','changes_requested'))::int as rank
      from public.applications a join public.app_users u on u.id = a.owner_id
     where a.status <> 'draft'
       and (a.title ilike '%'||v_kw_esc||'%'
         or coalesce(u.full_name,'') ilike '%'||v_kw_esc||'%'
         or u.username ilike '%'||v_kw_esc||'%')
     order by rank desc, a.updated_at desc
     limit 8
  ) t;

  return '【搜索】「' || v_kw || '」共 ' || v_total || ' 条' || E'\n' || v_lines
    || case when v_total > 8 then E'\n…还有 ' || (v_total - 8) || ' 条' else '' end;
end $$;
revoke all on function public.app_qq_search(text) from public, anon, authenticated;
grant execute on function public.app_qq_search(text) to service_role;

-- 运行状态：机器人是否正常、队列有没有积压、上一次收到回调是什么时候
create or replace function public.app_qq_status()
returns text language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_enabled boolean; v_groups integer;
  v_pending integer; v_fail integer; v_sending integer; v_last timestamptz;
  v_mail_pending integer; v_mail_fail integer;
  v_todo integer; v_hook timestamptz;
begin
  select coalesce(qq_notify_enabled,false),
         coalesce(array_length(qq_command_groups,1),0) + case when coalesce(qq_group_openid,'')<>'' then 1 else 0 end
    into v_enabled, v_groups
    from public.settings where id=1;

  select count(*) filter (where status='pending'),
         count(*) filter (where status='failed'),
         count(*) filter (where status='sending'),
         max(sent_at)
    into v_pending, v_fail, v_sending, v_last
    from public.qq_notifications;

  select count(*) filter (where status='pending'), count(*) filter (where status='failed')
    into v_mail_pending, v_mail_fail
    from public.notifications;

  select count(*) into v_todo from public.applications
   where status in ('finance_pending','chair_pending','payment_pending','payment_info_required','changes_requested');

  select max(received_at) into v_hook from public.qq_webhook_log;

  return '【运行状态】' || to_char(now() at time zone 'Asia/Shanghai','MM-DD HH24:MI')
    || E'\nQQ 提醒：' || case when v_enabled then '已开启' else '已关闭' end
    || '（允许指令的群 ' || v_groups || ' 个）'
    || E'\nQQ 队列：待发 ' || v_pending || ' · 发送中 ' || v_sending || ' · 失败 ' || v_fail
    || E'\n上次成功发送：' || coalesce(to_char(v_last at time zone 'Asia/Shanghai','MM-DD HH24:MI'), '从未')
    || E'\n邮件队列：待发 ' || v_mail_pending || ' · 失败 ' || v_mail_fail
    || E'\n待处理申请：' || v_todo || ' 笔'
    || E'\n最近一次群消息：' || coalesce(to_char(v_hook at time zone 'Asia/Shanghai','MM-DD HH24:MI'), '从未');
end $$;
revoke all on function public.app_qq_status() from public, anon, authenticated;
grant execute on function public.app_qq_status() to service_role;
