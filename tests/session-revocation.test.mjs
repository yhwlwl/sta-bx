import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(path, 'utf8');
const API = 'supabase/functions/app-api/index.ts';
const SQL = 'supabase/migrations/20261006070000_password_change_revokes_sessions.sql';

// 与迁移中的保留判断等价：摘要不再属于该账号时退化为撤销全部。
const sessionsToKeep = (sessions, userId, requested) => (
  requested && sessions.some((session) => session.user_id === userId && session.token_hash === requested)
    ? [requested]
    : []
);

test('改密码保留当前会话，并撤销该账号的其他会话', () => {
  const sessions = [
    { user_id: 'u1', token_hash: 'current' },
    { user_id: 'u1', token_hash: 'leaked-laptop' },
    { user_id: 'u1', token_hash: 'leaked-phone' },
    { user_id: 'u2', token_hash: 'someone-else' },
  ];
  const kept = sessionsToKeep(sessions, 'u1', 'current');
  assert.deepEqual(kept, ['current']);
  const remaining = sessions.filter((session) => session.user_id !== 'u1' || kept.includes(session.token_hash));
  assert.deepEqual(remaining.map((session) => session.token_hash), ['current', 'someone-else']); // 不误伤其他账号
});

test('伪造、过期或空的摘要不会保住会话，而是撤销全部', () => {
  const sessions = [{ user_id: 'u1', token_hash: 'current' }, { user_id: 'u2', token_hash: 'foreign' }];
  assert.deepEqual(sessionsToKeep(sessions, 'u1', 'foreign'), []);         // 属于其他账号的摘要
  assert.deepEqual(sessionsToKeep(sessions, 'u1', 'already-revoked'), []); // 已被撤销的摘要
  assert.deepEqual(sessionsToKeep(sessions, 'u1', ''), []);
  assert.deepEqual(sessionsToKeep(sessions, 'u1', null), []);              // 管理员重置：撤销全部
});

test('迁移先删旧签名再建新签名，避免重载绕过会话撤销', () => {
  const sql = source(SQL);
  assert.match(sql, /drop function if exists public\.app_change_password\(uuid, text, text\);/);
  assert.match(sql, /create or replace function public\.app_change_password\(p_user_id uuid, p_current_password text, p_new_password text, p_keep_token_hash text default null\)/);
  assert.ok(sql.indexOf('drop function') < sql.indexOf('create or replace function'), '删除旧签名必须在创建新签名之前');
  assert.doesNotMatch(sql, /app_change_password\(p_user_id uuid, p_current_password text, p_new_password text\)/); // 不再存在 3 参数版本
});

test('撤销只按 token_hash 定位，且保留值必须先校验归属', () => {
  const sql = source(SQL);
  assert.match(sql, /delete from public\.app_sessions where user_id = p_user_id and \(keep_hash is null or token_hash <> keep_hash\)/);
  assert.match(sql, /where user_id = p_user_id and token_hash = keep_hash/);
  assert.match(sql, /get diagnostics revoked = row_count/);
});

test('迁移沿用 extensions search_path，并对新签名重设权限', () => {
  const sql = source(SQL);
  assert.match(sql, /set search_path = public, private, extensions, pg_temp/);
  assert.match(sql, /revoke all on function public\.app_change_password\(uuid, text, text, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.app_change_password\(uuid, text, text, text\) to service_role/);
});

test('审计只记录撤销条数，不记录密码也不记录令牌', () => {
  const sql = source(SQL);
  assert.match(sql, /'修改登录密码','撤销其他登录会话 ' \|\| revoked::text \|\| ' 个'/);
  assert.doesNotMatch(sql, /p_current_password\s*\|\||\|\|\s*p_current_password/);
  assert.doesNotMatch(sql, /p_new_password\s*\|\||\|\|\s*p_new_password/);
  assert.doesNotMatch(sql, /p_keep_token\b(?!_hash)/); // 不存在明文令牌参数
});

test('后端从请求头推导保留摘要，不接受客户端传入', () => {
  const api = source(API);
  assert.match(api, /const keepHash = await sessionHashToKeep\(admin, actor\.user\.id, await sha256Hex\(getSessionToken\(req\)\)\)/);
  assert.match(api, /async function sessionHashToKeep\(admin: AdminClient, userId: string, tokenHash: string\)/);
  assert.match(api, /\.eq\('user_id', userId\)\.eq\('token_hash', tokenHash\)/);
  assert.match(api, /return data\?\.token_hash \?\? null/);
  assert.doesNotMatch(api, /p_keep_token_hash: (?:body|String\(body)/); // 保留标识绝不能来自请求体
  assert.equal(/console\.(log|error)\([^)]*token/i.test(api), false);
});

test('账户页提示与「保留当前会话、撤销其他会话」的行为一致', () => {
  const main = source('src/main.jsx');
  assert.ok(main.includes('其他设备上的登录会立即退出'));
  assert.ok(main.includes('其他设备上的登录已退出'));
  assert.match(main, /\/登录已过期\|请先登录\//);
});
