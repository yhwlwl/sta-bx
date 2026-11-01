begin;
do $$
declare
  admin_id uuid;
  named_applicant_id uuid;
  legacy_applicant_id uuid;
  orphaned_applicant_id uuid;
  unicode_applicant_id uuid;
  app_id uuid;
  report jsonb;
begin
  select id into admin_id from public.app_users where lower(username) = 'admin';
  if admin_id is null then raise exception '内置 admin 前置账号不存在'; end if;

  named_applicant_id := (private.app_insert_user('report-named-applicant', 'Test-only-12345', '  李 明  ', '') ->> 'id')::uuid;
  legacy_applicant_id := (private.app_insert_user('report-legacy-applicant', 'Test-only-12345', '', '') ->> 'id')::uuid;
  orphaned_applicant_id := (private.app_insert_user('report-missing-app-user', 'Test-only-12345', '已删除用户', '') ->> 'id')::uuid;
  unicode_applicant_id := (private.app_insert_user('report-unicode-applicant', 'Test-only-12345', repeat('😀', 41), '') ->> 'id')::uuid;

  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, named_applicant_id, '具名报销测试', '内部用途不得公开', 12.34, '材料', '活动组', '2026-10-02', 'paid');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 12.34, 'verify-applicant-name', admin_id, '2026-10-01 16:00:00+00');

  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, legacy_applicant_id, '用户名回退测试', '内部用途不得公开', 23.45, '材料', '活动组', '2026-10-02', 'paid');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 23.45, 'verify-applicant-fallback', admin_id, '2026-10-01 17:00:00+00');

  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, orphaned_applicant_id, '缺失用户测试', '内部用途不得公开', 34.56, '材料', '活动组', '2026-10-02', 'paid');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 34.56, 'verify-applicant-missing', admin_id, '2026-10-01 18:00:00+00');
  delete from public.app_users where id = orphaned_applicant_id;

  app_id := gen_random_uuid();
  insert into public.applications(id, owner_id, title, purpose, amount, category, department, use_date, status)
  values (app_id, unicode_applicant_id, 'Unicode 姓名测试', '内部用途不得公开', 45.67, '材料', '活动组', '2026-10-02', 'paid');
  insert into public.payments(application_id, amount, reference, actor_id, created_at)
  values (app_id, 45.67, 'verify-applicant-unicode', admin_id, '2026-10-01 19:00:00+00');

  perform public.app_update_public_financial_report(admin_id, true);
  report := public.app_public_financial_report('2026-10-02', '2026-10-02');
  if jsonb_array_length(report -> 'records') <> 4 then
    raise exception '增加报销人资料不应丢失付款记录：%', report;
  end if;
  if not (report -> 'records' @> jsonb_build_array(jsonb_build_object(
    'payment_date','2026-10-02','amount',12.34,'category','材料','department','活动组','applicant_name','李 明'
  ))) then
    raise exception '公开字段应显示申请人姓名，而非付款操作人：%', report;
  end if;
  if not (report -> 'records' @> jsonb_build_array(jsonb_build_object(
    'payment_date','2026-10-02','amount',45.67,'category','材料','department','活动组','applicant_name',repeat('😀', 41)
  ))) then
    raise exception '非 BMP 的 41 个 Unicode 字符应按字符数保留姓名：%', report;
  end if;
  if not (report -> 'records' @> jsonb_build_array(jsonb_build_object('applicant_name','未填写'))) then
    raise exception '姓名为空/等于用户名或 app_users 记录缺失时应显示未填写：%', report;
  end if;
  if report::text like '%report-named-applicant%' or report::text like '%verify-applicant-name%' or report::text like '%内部用途不得公开%' then
    raise exception '公开财报包含用户名、付款流水或内部申请内容：%', report;
  end if;

  if has_function_privilege('anon', 'public.app_public_financial_report(date,date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.app_public_financial_report(date,date)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.app_public_financial_report(date,date)', 'EXECUTE') then
    raise exception '更新 RPC 后的执行权限不正确';
  end if;
end $$;
rollback;
