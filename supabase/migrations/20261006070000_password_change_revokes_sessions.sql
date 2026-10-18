-- 修改密码后撤销该账号的其他登录会话，只保留正在改密码的这一条。
-- 传入的是会话令牌的 sha256 摘要，不是令牌本身，因此数据库和日志里都不会出现凭据。
-- 摘要传 null 时撤销该账号的全部会话，供管理员重置密码使用。

-- create or replace 改变参数个数时是新增重载而不是替换：旧的 3 参数版本会继续可调用，
-- 并且不会撤销任何会话。必须先删除旧签名，否则修复会被绕过。
drop function if exists public.app_change_password(uuid, text, text);

create or replace function public.app_change_password(p_user_id uuid, p_current_password text, p_new_password text, p_keep_token_hash text default null)
returns void language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare keep_hash text := nullif(trim(coalesce(p_keep_token_hash,'')),''); revoked integer := 0;
begin
  if length(coalesce(p_new_password,'')) < 10 then raise exception '新密码至少需要 10 个字符'; end if;
  if length(p_new_password) > 72 then raise exception '新密码最多 72 个字符'; end if;
  update public.app_users
  set password_hash = crypt(p_new_password, gen_salt('bf', 12)), updated_at = now()
  where id = p_user_id and active and password_hash = crypt(p_current_password, password_hash);
  if not found then raise exception '当前密码不正确'; end if;
  -- 摘要必须确实属于该账号，否则退化为撤销全部，避免用它保住别的会话。
  if keep_hash is not null and not exists(
    select 1 from public.app_sessions where user_id = p_user_id and token_hash = keep_hash
  ) then keep_hash := null; end if;
  delete from public.app_sessions where user_id = p_user_id and (keep_hash is null or token_hash <> keep_hash);
  get diagnostics revoked = row_count;
  insert into public.audit_logs(actor_id,event,detail) values(p_user_id,'修改登录密码','撤销其他登录会话 ' || revoked::text || ' 个');
end $$;

revoke all on function public.app_change_password(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.app_change_password(uuid, text, text, text) to service_role;
