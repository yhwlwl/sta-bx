-- 迁移后在事务中执行；不保留任何验证数据。
begin;
do $$
declare
  super_id uuid;
  fin_id uuid;
  chair_id uuid;
  ops_admin_id uuid;
  member_id uuid;
  row jsonb;
  app_fin uuid;
  app_chair uuid;
  app_pay uuid;
  app_returned uuid;
  app_qr uuid;
  app_self_fin uuid;
  app_self_pay uuid;
  app_paid uuid;
  items jsonb;
  ids text[];
  rejected boolean := false;
begin
  select id into super_id from public.app_users where lower(username) = 'admin' and active;
  if super_id is null then raise exception 'built-in admin is required'; end if;

  row := private.app_insert_user('verify_pending_fin_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证财委', '验证');
  fin_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (fin_id, 'finance');

  row := private.app_insert_user('verify_pending_chair_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证主席', '验证');
  chair_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (chair_id, 'chair');

  -- 普通管理员：只有 admin 身份，不是内置 admin，不应因此获得任何流程待办。
  row := private.app_insert_user('verify_pending_ops_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证普通管理员', '验证');
  ops_admin_id := (row->>'id')::uuid;
  insert into public.user_roles(user_id, role) values (ops_admin_id, 'admin');

  row := private.app_insert_user('verify_pending_member_' || substr(gen_random_uuid()::text, 1, 8), 'Test-only-1369666', '验证成员', '验证');
  member_id := (row->>'id')::uuid;

  -- 待办类型只覆盖五种流程状态，且与通知事件映射保持一致。
  if (select array_agg(distinct private.app_pending_bucket(s) order by private.app_pending_bucket(s))
        from unnest(array['finance_pending','chair_pending','payment_pending','changes_requested','payment_info_required']) s
       where private.app_pending_bucket(s) is not null) is distinct from array['chair','finance','payment','qr','returned'] then
    raise exception '待办类型键与前端契约不一致';
  end if;
  if (select count(*) from unnest(array['draft','rejected','paid','cancelled']) s where private.app_pending_bucket(s) is not null) <> 0 then
    raise exception '非待办状态不应映射成待办类型';
  end if;
  if (select count(*) from unnest(array['finance_pending','chair_pending','payment_pending','changes_requested','payment_info_required']) s
       where private.app_notify_event_for_status(s) is null) <> 0 then
    raise exception '待办状态必须都有对应的通知事件';
  end if;

  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'待财委审批','验证',50,'物资','验证',current_date,'finance_pending',1,100) returning id into app_fin;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'待主席审批','验证',500,'物资','验证',current_date,'chair_pending',1,100) returning id into app_chair;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'待付款登记','验证',50,'物资','验证',current_date,'payment_pending',1,100) returning id into app_pay;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'退回修改','验证',50,'物资','验证',current_date,'changes_requested',1,100) returning id into app_returned;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'待补充收款码','验证',50,'物资','验证',current_date,'payment_info_required',1,100) returning id into app_qr;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (fin_id,'财委自己的待审申请','验证',50,'物资','验证',current_date,'finance_pending',1,100) returning id into app_self_fin;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (fin_id,'财委自己的待付款申请','验证',50,'物资','验证',current_date,'payment_pending',1,100) returning id into app_self_pay;
  insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold)
    values (member_id,'已付款','验证',50,'物资','验证',current_date,'paid',1,100) returning id into app_paid;

  -- 财委：财委审批与付款登记两类的待办；不能看到自己提交的待审申请（不能自审），但能看到自己的待付款申请。
  items := public.app_list_pending(fin_id);
  select array_agg(x->>'application_id' order by x->>'application_id') into ids from jsonb_array_elements(items) x;
  if ids is distinct from (select array_agg(v order by v) from unnest(array[app_fin::text, app_pay::text, app_self_pay::text]) v) then
    raise exception '财委待办清单不对：%', ids;
  end if;
  if exists (select 1 from jsonb_array_elements(items) x where not (x->>'unread')::boolean) then
    raise exception '未查看过的待办必须是未读';
  end if;

  -- 主席：只有待主席审批。
  items := public.app_list_pending(chair_id);
  if jsonb_array_length(items) <> 1 or items->0->>'application_id' <> app_chair::text then
    raise exception '主席待办清单不对：%', items;
  end if;

  -- 普通管理员与普通成员都不是流程身份：普通管理员没有任何待办，成员只有自己名下的退回修改与待补充收款码。
  if jsonb_array_length(public.app_list_pending(ops_admin_id)) <> 0 then raise exception '普通管理员不应获得流程待办'; end if;
  items := public.app_list_pending(member_id);
  select array_agg(x->>'application_id' order by x->>'application_id') into ids from jsonb_array_elements(items) x;
  if ids is distinct from (select array_agg(v order by v) from unnest(array[app_returned::text, app_qr::text]) v) then
    raise exception '申请人自己的待办清单不对：%', ids;
  end if;

  -- 内置 admin 超管跨身份：三类流程待办全都能看到（审批待办仍排除自己名下的申请）。
  items := public.app_list_pending(super_id);
  select array_agg(x->>'application_id' order by x->>'application_id') into ids from jsonb_array_elements(items) x;
  if ids is distinct from (
    select array_agg(v order by v) from unnest(array[app_fin::text, app_chair::text, app_pay::text, app_self_fin::text, app_self_pay::text]) v
  ) then
    raise exception '超管待办清单不对：%', ids;
  end if;

  -- 已读标记：只写调用者自己看得到的待办；重复标记不会改变结果，状态或版本变化后重新计为未读。
  if public.app_mark_pending_seen(chair_id, array['finance']) <> 0 then raise exception '主席不应能标记财委待办'; end if;
  if public.app_mark_pending_seen(ops_admin_id, null) <> 0 then raise exception '普通管理员没有可标记的待办'; end if;
  if public.app_mark_pending_seen(fin_id, array['finance', 'payment']) <> 3 then raise exception '财委应标记三条待办'; end if;
  if exists (select 1 from jsonb_array_elements(public.app_list_pending(fin_id)) x where (x->>'unread')::boolean) then
    raise exception '标记后待办应为已读';
  end if;
  if exists (select 1 from public.pending_views where user_id = chair_id and application_id = app_fin) then
    raise exception '越权标记不应写入任何记录';
  end if;

  update public.applications set version = version + 1 where id = app_fin;
  items := public.app_list_pending(fin_id);
  if (select count(*) from jsonb_array_elements(items) x where (x->>'unread')::boolean) <> 1 then
    raise exception '版本变化后应只有该条待办重新变为未读';
  end if;

  update public.applications set status = 'chair_pending' where id = app_fin;
  if jsonb_array_length(public.app_list_pending(fin_id)) <> 2 then raise exception '申请流转后应从财委待办中消失'; end if;

  begin
    perform public.app_mark_pending_seen(fin_id, array['unknown']);
    rejected := false;
  exception when others then
    rejected := sqlerrm = '待办类型无效';
  end;
  if not rejected then raise exception '无效待办类型必须被拒绝'; end if;

  update public.app_users set active = false where id = member_id;
  begin
    perform public.app_list_pending(member_id);
    rejected := false;
  exception when others then
    rejected := sqlerrm = '账号已停用';
  end;
  if not rejected then raise exception '停用账号必须被拒绝'; end if;
end $$;

do $$
begin
  if (select relrowsecurity from pg_class where oid = to_regclass('public.pending_views')) is not true then
    raise exception 'pending_views 必须启用 RLS';
  end if;
  if has_table_privilege('anon', 'public.pending_views', 'select') or has_table_privilege('authenticated', 'public.pending_views', 'select') then
    raise exception 'pending_views 不应向浏览器角色开放';
  end if;
  if has_function_privilege('anon', 'public.app_list_pending(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.app_list_pending(uuid)', 'execute')
     or has_function_privilege('anon', 'public.app_mark_pending_seen(uuid,text[])', 'execute')
     or has_function_privilege('authenticated', 'public.app_mark_pending_seen(uuid,text[])', 'execute') then
    raise exception '待办函数不应向浏览器角色开放';
  end if;
  if not has_function_privilege('service_role', 'public.app_list_pending(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.app_mark_pending_seen(uuid,text[])', 'execute') then
    raise exception '待办函数必须允许 service_role 调用';
  end if;
end $$;
rollback;
