-- 修复：负责人最多只取 3 个，超出的人被静默丢弃。
--
-- 上一版为了「@ 太多人等于没 @」给 qq_notify_targets 加了 limit 3，但主席实际有 4 个人
-- （赵思琪、袁欣航、白瑾瑜、张力源），第 4 个直接消失，「负责人」一行看起来像是漏配了角色。
-- 审批人数量本来就少，正确的取舍是：把人列全，只在超过 10 个时截断（防止误配大量角色后刷屏）。
--
-- 排序保持"已绑定 member_openid 的排前面"，这样名额不够时优先 @ 得到人。

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
  limit 10;
$$;
revoke all on function private.qq_notify_targets(uuid, text, text) from public, anon, authenticated;
