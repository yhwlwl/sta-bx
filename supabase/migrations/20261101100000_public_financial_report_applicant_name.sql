-- Extend the public report with the applicant's display name.
-- This is a follow-up migration so databases that already applied the original
-- public-report migration receive the new projection in order.
create or replace function public.app_public_financial_report(p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  result_rows jsonb;
  report_enabled boolean;
  row_count integer;
begin
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 1826 then
    raise exception '请选择不超过五年的有效日期范围';
  end if;

  with report_rows as (
    select to_char(p.created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as payment_date,
           p.amount,
           a.category,
           a.department,
           case
             when applicant.id is null
               or nullif(trim(applicant.full_name), '') is null
               or lower(trim(applicant.full_name)) = lower(trim(applicant.username))
               then '未填写'
             else left(trim(applicant.full_name), 80)
           end as applicant_name
      from public.settings setting
      join public.payments p on true
      join public.applications a on a.id = p.application_id
      left join public.app_users applicant on applicant.id = a.owner_id
     where setting.id = 1
       and setting.public_financial_report_enabled
       and a.status = 'paid'
       and p.created_at >= (p_start::timestamp at time zone 'Asia/Shanghai')
       and p.created_at < ((p_end + 1)::timestamp at time zone 'Asia/Shanghai')
     order by p.created_at, p.application_id
     limit 5001
  ), report_payload as (
    select coalesce(jsonb_agg(to_jsonb(report_row) order by report_row.payment_date, report_row.category, report_row.department), '[]'::jsonb) as records,
           count(*)::integer as count
      from report_rows report_row
  )
  select setting.public_financial_report_enabled,
         case when setting.public_financial_report_enabled then report_payload.records else '[]'::jsonb end,
         report_payload.count
    into report_enabled, result_rows, row_count
    from public.settings setting
    cross join report_payload
   where setting.id = 1;

  if report_enabled is distinct from true then
    return jsonb_build_object('enabled', false, 'records', '[]'::jsonb);
  end if;
  if row_count > 5000 then
    raise exception '记录超过 5000 条，请缩小日期范围';
  end if;

  return jsonb_build_object('enabled', true, 'records', result_rows);
end;
$$;
revoke all on function public.app_public_financial_report(date, date) from public, anon, authenticated;
grant execute on function public.app_public_financial_report(date, date) to service_role;
