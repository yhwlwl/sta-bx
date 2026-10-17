-- QQ 群提醒内容富化 + @ 负责人。
--
-- 原实现每条提醒只发一句「有新的「xxx」动态，请相关成员登录平台查看」，群里看不出是谁、
-- 申请什么、多少钱、到哪一步了。本迁移把详情写进消息，并 @ 该待办的处理人。
--
-- QQ 群只支持 <qqbot-at-user id="member_openid" />（@全员仅文字子频道可用，群聊不支持），
-- 而 member_openid 只能从群事件里读出来，因此新增绑定表：管理员拿到某个成员的 member_openid
-- 后在这里登记，之后发给这个群的提醒就能 @ 到他。没有绑定的人不会中断发送，只是退化成
-- 「负责人：张三」这样的纯文本。
--
-- 注意：群消息从此包含申请标题、申请人姓名与金额。这改变了原先"群里只有提醒类型"的取舍，
-- 前提是这个群本身就是财委/主席的工作群（无关成员看不到）。

-- 绑定表：按群存，换群不用清；成员账号删除时级联删除。
create table if not exists public.qq_member_bindings (
  group_openid text not null,
  user_id uuid not null references public.app_users(id) on delete cascade,
  member_openid text not null,
  created_at timestamptz not null default now(),
  primary key (group_openid, user_id)
);
alter table public.qq_member_bindings drop constraint if exists qq_member_bindings_openid_check;
alter table public.qq_member_bindings add constraint qq_member_bindings_openid_check
  check (member_openid ~ '^[A-Za-z0-9_-]{16,128}$');
-- 一个人在同一群里只会有一个 member_openid；反过来一个 openid 也不能绑到两个人身上。
create unique index if not exists qq_member_bindings_openid_key
  on public.qq_member_bindings(group_openid, member_openid);
alter table public.qq_member_bindings enable row level security;
revoke all on table public.qq_member_bindings from public, anon, authenticated;
grant all on table public.qq_member_bindings to service_role;

-- 状态的中文名。app-api 里也有一份 STATUS_LABELS（用于邮件正文兜底），
-- 群消息文案在数据库里生成，所以这里需要同一份映射；取值与前者逐字一致。
create or replace function private.app_status_label(p_status text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select m.label from (values
    ('draft', '草稿'),
    ('finance_pending', '待财委审批'),
    ('chair_pending', '待主席审批'),
    ('changes_requested', '退回修改'),
    ('rejected', '已拒绝'),
    ('payment_info_required', '待补充收款码'),
    ('payment_pending', '待付款'),
    ('paid', '已付款'),
    ('cancelled', '已撤回')
  ) as m(status, label)
  where m.status = p_status;
$$;
revoke all on function private.app_status_label(text) from public, anon, authenticated;

-- 这条提醒该由谁处理：与 private.enqueue_email_notification 的身份判定逐条一致
-- （调用方一律走 private.app_user_has_role，所以"付款登记视同财委"这类变化自动生效）。
-- 五类待办排除申请人本人；结果类通知（拒绝申请/已付款）只指向申请人。
-- 最多取 3 个人：群消息里 @ 太多人等于没 @，也避免一条提醒刷屏。
create or replace function private.qq_notify_targets(p_application_id uuid, p_event text, p_group_openid text)
returns table(user_id uuid, display_name text, member_openid text)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select u.id, coalesce(nullif(trim(u.full_name), ''), u.username), b.member_openid
  from public.applications a
  join public.app_users u on u.active
  left join public.qq_member_bindings b on b.user_id = u.id and b.group_openid = p_group_openid
  where a.id = p_application_id
    and case p_event
      when '待财委审批' then u.id <> a.owner_id and private.app_user_has_role(u.id, 'finance')
      when '待主席审批' then u.id <> a.owner_id and private.app_user_has_role(u.id, 'chair')
      when '待付款登记' then u.id <> a.owner_id and private.app_user_has_role(u.id, 'cashier')
      else u.id = a.owner_id
    end
  order by b.member_openid nulls last, u.id
  limit 3;
$$;
revoke all on function private.qq_notify_targets(uuid, text, text) from public, anon, authenticated;

-- 群消息正文。所有入参都由调用方从已领取的队列行给出（不在这里回头查 qq_notifications，
-- 避免与同一语句里的 status 更新互相影响），因此这个函数对测试也可以直接调用。
-- 时间统一按北京时间展示：群成员看到的"刚才"应该和手机时钟一致。
create or replace function private.qq_notify_content(
  p_application_id uuid, p_event text, p_group_openid text, p_created_at timestamptz
) returns text language sql stable security definer set search_path = public, private, pg_temp as $$
  select
    case when coalesce(cardinality(t.ids), 0) > 0
      then (select string_agg('<qqbot-at-user id="' || x || '" />', ' ') from unnest(t.ids) as x) || ' '
      else '【财务报销平台】'
    end
    || p_event || E'\n'
    || '申请人：' || coalesce(nullif(trim(u.full_name), ''), u.username, '成员') || E'\n'
    || '申请事项：' || a.title || E'\n'
    || '金额：¥' || to_char(a.amount, 'FM9999999999990.00') || E'\n'
    || '部门 / 活动：' || a.department || E'\n'
    || '时间：' || to_char(p_created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || E'\n'
    || '当前状态：' || coalesce(private.app_status_label(a.status), a.status) || E'\n'
    || '负责人：' || coalesce(array_to_string(t.names, '、'), '待确认')
  from public.applications a
  left join public.app_users u on u.id = a.owner_id
  cross join lateral (
    select
      array_agg(g.member_openid) filter (where g.member_openid is not null) as ids,
      array_agg(g.display_name) as names
    from private.qq_notify_targets(a.id, p_event, p_group_openid) g
  ) t
  where a.id = p_application_id;
$$;
revoke all on function private.qq_notify_content(uuid, text, text, timestamptz) from public, anon, authenticated;

-- 领取时就把正文算好，app-api 只负责发出去。其余行为（24 小时过期、60 秒租约、
-- 每轮 3 条、skip locked、失败上限 5 次）与上一版完全一致。
create or replace function public.app_claim_qq_notifications(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare claimed jsonb;
begin
 if not exists(select 1 from public.settings where id=1 and qq_notify_enabled) then return '[]'::jsonb; end if;
 update public.qq_notifications n set status='cancelled',claim_id=null,last_error='提醒已过期或不再适用'
 where status in ('pending','sending') and (created_at<now()-interval '24 hours' or not private.qq_notify_valid(n));
 update public.qq_notifications set status=case when attempts>=5 then 'failed' else 'pending' end,claim_id=null,last_error='上次投递中断或结果保存失败'
 where status='sending' and lease_expires_at<now();
 with picked as (
 select id from public.qq_notifications where status='pending' and next_attempt_at<=now() and attempts<5
 order by id for update skip locked limit 3
 ), leased as (
 update public.qq_notifications n set status='sending',claim_id=p_claim_id,lease_expires_at=now()+interval '60 seconds',attempts=attempts+1
 from picked where n.id=picked.id returning n.*
 ) select coalesce(jsonb_agg(to_jsonb(leased) || jsonb_build_object(
     'content', private.qq_notify_content(leased.application_id, leased.event, leased.group_openid, leased.created_at)
   ) order by leased.id),'[]'::jsonb) into claimed from leased;
 return claimed;
end $$;

-- 管理员维护绑定：member_openid 来自"该成员在目标群里 @ 一次机器人"时事件里的
-- author.member_openid（scripts/qq-capture-group-openid.ps1 -Bind 会打印出来）。
create or replace function public.app_set_qq_binding(p_actor_id uuid, p_username text, p_member_openid text)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare target_group text; target_user uuid; target_name text;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  select coalesce(qq_group_openid,'') into target_group from public.settings where id=1;
  if coalesce(target_group,'')='' then raise exception '请先在上方填写并保存目标群 OpenID'; end if;
  if coalesce(trim(p_member_openid),'')='' then raise exception '请输入成员的 member_openid'; end if;
  if trim(p_member_openid) !~ '^[A-Za-z0-9_-]{16,128}$' then raise exception 'member_openid 格式不正确（应为 16–128 位字母、数字、下划线或短横线）'; end if;
  select id, coalesce(nullif(trim(full_name),''),username) into target_user, target_name
  from public.app_users where lower(username)=lower(trim(coalesce(p_username,''))) and active;
  if target_user is null then raise exception '用户名不存在或该账号已停用'; end if;
  -- 一个 openid 只能绑一个人：重复绑定同一 openid 时先摘掉旧的那个人，避免消息 @ 错对象。
  delete from public.qq_member_bindings where group_openid=target_group and member_openid=trim(p_member_openid) and user_id<>target_user;
  insert into public.qq_member_bindings(group_openid,user_id,member_openid)
  values(target_group,target_user,trim(p_member_openid))
  on conflict(group_openid,user_id) do update set member_openid=excluded.member_openid,created_at=now();
  insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'绑定QQ群成员','为 ' || target_name || ' 登记 member_openid');
end $$;

create or replace function public.app_delete_qq_binding(p_actor_id uuid, p_username text)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare target_group text; target_name text;
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  select coalesce(qq_group_openid,'') into target_group from public.settings where id=1;
  select coalesce(nullif(trim(full_name),''),username) into target_name
  from public.app_users where lower(username)=lower(trim(coalesce(p_username,'')));
  delete from public.qq_member_bindings b using public.app_users u
  where b.group_openid=target_group and b.user_id=u.id and lower(u.username)=lower(trim(coalesce(p_username,'')));
  insert into public.audit_logs(actor_id,event,detail) values(p_actor_id,'解除QQ群成员绑定','解除 ' || coalesce(target_name,'成员'));
end $$;

revoke all on function public.app_claim_qq_notifications(uuid),public.app_set_qq_binding(uuid,text,text),public.app_delete_qq_binding(uuid,text)
  from public,anon,authenticated;
