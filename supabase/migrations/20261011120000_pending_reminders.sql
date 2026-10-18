-- Issue #9：工作台待处理提醒与未读状态。
--
-- 1) private.app_visible_pending 是"谁能看到哪些待办"的唯一口径，身份判定与 private.enqueue_email_notification
--    里的收件人口径保持一致：审批待办排除申请人本人（不能自审），付款登记允许本人（财委可登记自己的付款），
--    退回修改与待补充收款码只属于申请人本人。
-- 2) public.pending_views 记录"某人已经看过某申请的某个状态与版本"；状态或版本变化后重新计为未读，
--    所以申请被退回后重新提交（version 加一）会再次提醒同一批处理人。
-- 3) app_list_pending 返回待办明细（带 unread 标记），app_mark_pending_seen 在进入列表时写已读标记。

create table if not exists public.pending_views (
  user_id uuid not null references public.app_users(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  status text not null,
  version integer not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, application_id)
);

create index if not exists pending_views_application_idx on public.pending_views(application_id);
alter table public.pending_views enable row level security;
revoke all on table public.pending_views from public, anon, authenticated;

-- 状态 → 待办类型。五种状态必须与 private.app_notify_event_for_status 的待办状态一一对应（verify 脚本逐项比对），
-- 也必须与前端 src/pending-rules.js 的 PENDING_BUCKETS 一致（tests/pending-reminders.test.mjs 逐项比对）。
create or replace function private.app_pending_bucket(p_status text)
returns text language sql immutable as $$
  select case p_status
    when 'finance_pending' then 'finance'
    when 'chair_pending' then 'chair'
    when 'payment_pending' then 'payment'
    when 'changes_requested' then 'returned'
    when 'payment_info_required' then 'qr'
  end
$$;
revoke all on function private.app_pending_bucket(text) from public, anon, authenticated;

create or replace function private.app_can_handle_bucket(p_user_id uuid, p_bucket text)
returns boolean language sql stable security definer set search_path = public, private, pg_temp as $$
  select case p_bucket
    when 'finance' then private.app_user_has_role(p_user_id, 'finance')
    when 'chair' then private.app_user_has_role(p_user_id, 'chair')
    when 'payment' then private.app_user_has_role(p_user_id, 'cashier')
    else false
  end
$$;
revoke all on function private.app_can_handle_bucket(uuid, text) from public, anon, authenticated;

create or replace function private.app_visible_pending(p_actor_id uuid)
returns table (
  bucket text, application_id uuid, title text, amount numeric, status text,
  owner_id uuid, owner_name text, version integer, updated_at timestamptz
)
language sql stable security definer set search_path = public, private, pg_temp as $$
  select private.app_pending_bucket(a.status) as bucket,
         a.id, a.title, a.amount, a.status, a.owner_id,
         coalesce(p.full_name, '成员') as owner_name, a.version, a.updated_at
  from public.applications a
  left join public.profiles p on p.id = a.owner_id
  where private.app_pending_bucket(a.status) is not null
    and case private.app_pending_bucket(a.status)
      when 'finance' then a.owner_id <> p_actor_id and private.app_can_handle_bucket(p_actor_id, 'finance')
      when 'chair' then a.owner_id <> p_actor_id and private.app_can_handle_bucket(p_actor_id, 'chair')
      when 'payment' then private.app_can_handle_bucket(p_actor_id, 'payment')
      else a.owner_id = p_actor_id
    end
$$;
revoke all on function private.app_visible_pending(uuid) from public, anon, authenticated;

create or replace function public.app_list_pending(p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare result jsonb;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', v.bucket,
           'application_id', v.application_id,
           'title', v.title,
           'amount', v.amount,
           'status', v.status,
           'owner_id', v.owner_id,
           'owner_name', v.owner_name,
           'version', v.version,
           'updated_at', v.updated_at,
           'unread', pv.user_id is null
         ) order by v.updated_at desc, v.application_id), '[]'::jsonb)
    into result
  from private.app_visible_pending(p_actor_id) v
  left join public.pending_views pv
    on pv.user_id = p_actor_id and pv.application_id = v.application_id
   and pv.status = v.status and pv.version = v.version;
  return result;
end;
$$;
revoke all on function public.app_list_pending(uuid) from public, anon, authenticated;
grant execute on function public.app_list_pending(uuid) to service_role;

-- 进入列表时标记已读。p_buckets 为空表示"当前身份能看到的所有待办"；
-- 只写入调用者自己确实能处理的待办，所以拿别人的待办类型来标记不会产生任何效果。
create or replace function public.app_mark_pending_seen(p_actor_id uuid, p_buckets text[] default null)
returns integer language plpgsql security definer set search_path = public, private, pg_temp as $$
declare marked integer;
begin
  if not private.app_user_active(p_actor_id) then raise exception '账号已停用'; end if;
  if p_buckets is not null and exists (
    select 1 from unnest(p_buckets) as bucket where bucket not in ('finance', 'chair', 'payment', 'returned', 'qr')
  ) then raise exception '待办类型无效'; end if;
  insert into public.pending_views(user_id, application_id, status, version, seen_at)
  select p_actor_id, v.application_id, v.status, v.version, now()
  from private.app_visible_pending(p_actor_id) v
  where p_buckets is null or v.bucket = any(p_buckets)
  on conflict (user_id, application_id) do update
    set status = excluded.status, version = excluded.version, seen_at = excluded.seen_at;
  get diagnostics marked = row_count;
  return marked;
end;
$$;
revoke all on function public.app_mark_pending_seen(uuid, text[]) from public, anon, authenticated;
grant execute on function public.app_mark_pending_seen(uuid, text[]) to service_role;
