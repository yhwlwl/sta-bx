begin;
do $$
declare
  admin_id uuid;
  member_id uuid;
  owner_id uuid;
  app_id uuid := gen_random_uuid();
  report jsonb;
begin
  if (select public_financial_report_enabled from public.settings where id = 1) is distinct from false then
    raise exception '公开财报默认必须关闭';
  end if;
  if has_function_privilege('anon', 'public.app_public_financial_report(date,date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.app_public_financial_report(date,date)', 'EXECUTE') then
    raise exception '匿名或登录角色不应直接执行公开财报 RPC';
  end if;
  if not has_function_privilege('service_role', 'public.app_public_financial_report(date,date)', 'EXECUTE') then
    raise exception 'Edge Function service_role 缺少公开财报 RPC 权限';
  end if;

  admin_id := (private.app_insert_user('report-admin', 'Test-only-12345', '报告管理员', '') ->> 'id')::uuid;
  insert into public.user_roles(user_id, role) values (admin_id, 'admin');
  member_id := (private.app_insert_user('report-member', 'Test-only-12345', '普通成员', '') ->> 'id')::uuid;
  owner_id := member_id;
  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, owner_id, '财报测试', '不可公开的用途', 12.34, '材料', '活动组', '2026-10-02', 'paid');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 12.34, 'verify-public-report', admin_id, '2026-10-01 16:00:00+00');
  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, owner_id, '未付款测试', '不可公开的用途', 99.99, '不应出现', '不应出现', '2026-10-02', 'payment_pending');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 99.99, 'verify-public-unpaid', admin_id, '2026-10-01 17:00:00+00');

  report := public.app_public_financial_report('2026-10-02', '2026-10-02');
  if report is distinct from jsonb_build_object('enabled', false, 'records', '[]'::jsonb) then
    raise exception '公开财报关闭时必须不返回明细';
  end if;

  perform public.app_update_public_financial_report(admin_id, true);
  if not exists(select 1 from public.audit_logs where actor_id = admin_id and event = '修改公开财报设置' and detail = '开启公开财报') then
    raise exception '公开财报设置变更必须审计';
  end if;
  report := public.app_public_financial_report('2026-10-02', '2026-10-02');
  if report ->> 'enabled' <> 'true' or jsonb_array_length(report -> 'records') <> 1 then
    raise exception '付款时间北京时间边界或已付款范围有误：%', report;
  end if;
  if report -> 'records' -> 0 <> jsonb_build_object('payment_date','2026-10-02','amount',12.34,'category','材料','department','活动组') then
    raise exception '公开字段投影不正确：%', report;
  end if;
  if jsonb_array_length((public.app_public_financial_report('2026-10-01','2026-10-01') -> 'records')) <> 0 then
    raise exception '北京时间前一日不应包含边界付款';
  end if;

  begin
    perform public.app_update_public_financial_report(member_id, false);
    raise exception '普通用户不应修改公开财报设置';
  exception when others then
    if sqlerrm = '普通用户不应修改公开财报设置' then raise; end if;
  end;

  perform public.app_update_public_financial_report(admin_id, false);
  report := public.app_public_financial_report('2026-10-02', '2026-10-02');
  if report is distinct from jsonb_build_object('enabled', false, 'records', '[]'::jsonb) then
    raise exception '关闭公开财报后 RPC 不应返回业务数据';
  end if;

  begin
    perform public.app_public_financial_report(null, '2026-10-02');
    raise exception '公开财报必须要求开始日期';
  exception when others then
    if sqlerrm = '公开财报必须要求开始日期' then raise; end if;
  end;
end $$;
rollback;
