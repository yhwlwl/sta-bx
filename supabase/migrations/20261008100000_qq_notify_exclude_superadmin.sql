-- 提醒里不再 @ 内置超级管理员。
--
-- 超级管理员按定义拥有全部身份（财委、主席、付款登记），因此每一条审批提醒都会命中他，
-- 「负责人」一行永远挂着「超级管理员」。群里的 @ 应该指向真正要动手的那个人，
-- 系统账号既不进群、也不该被点名，所以从收件人集合里剔除。
-- 注意这只影响 QQ 群提醒的 @ 与「负责人」，邮件通知与权限判定都不变。

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
    and not private.app_user_is_superadmin(u.id)
  order by b.member_openid nulls last, u.id
  limit 3;
$$;
revoke all on function private.qq_notify_targets(uuid, text, text) from public, anon, authenticated;
