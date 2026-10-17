-- 允许在哪些群响应 /check。
--
-- 原来只认「提醒目标群」一个群号，结果在别的群发 /check 被静默忽略（见 qq_webhook_log 里
-- 收到 ACE5A6F8… 而配置 E08583C2…）。指令和提醒本来就是两件事：
-- 提醒往固定群发，指令可以有几个工作群。这里加一个白名单，提醒目标群始终允许，
-- 不需要重复填。

alter table public.settings add column if not exists qq_command_groups text[] not null default '{}';

create or replace function public.app_update_qq_command_groups(p_actor_id uuid, p_groups text[])
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_clean text[];
begin
  if not private.app_user_has_role(p_actor_id,'admin') then raise exception '没有管理员权限'; end if;
  if p_groups is null then raise exception '指令群参数无效'; end if;
  if array_length(p_groups,1) is not null and array_length(p_groups,1) > 10 then
    raise exception '指令群最多 10 个';
  end if;
  if exists(select 1 from unnest(p_groups) g where g is null or g !~ '^[A-Za-z0-9_-]{16,128}$') then
    raise exception '群OpenID格式不正确（不是数字群号）';
  end if;

  select coalesce(array_agg(distinct trim(g) order by trim(g)), array[]::text[]) into v_clean
    from unnest(p_groups) g where trim(g) <> '';

  perform 1 from public.settings where id=1 for update;
  update public.settings set qq_command_groups = v_clean, updated_at = now(), updated_by = p_actor_id
    where id=1;
  insert into public.audit_logs(actor_id,event,detail)
    values(p_actor_id,'修改QQ指令群',case when cardinality(v_clean)=0 then '清空指令群白名单'
      else '允许指令的群：' || array_to_string(v_clean,'、') end);
end $$;
revoke all on function public.app_update_qq_command_groups(uuid, text[]) from public, anon, authenticated;
grant execute on function public.app_update_qq_command_groups(uuid, text[]) to service_role;
