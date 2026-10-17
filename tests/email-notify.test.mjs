import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEmail, validateEmail, NOTIFY_EVENTS, NOTIFY_DEFAULT_EVENTS, NOTIFY_EVENT_GROUPS, normalizeNotifyEvents, NOTIFY_QUEUE, EMAIL_PATTERN, EMAIL_MAX } from '../src/notify-rules.js';

const source = (path) => readFileSync(path, 'utf8');
const migration = source('supabase/migrations/20261004210000_email_notify.sql');
const verify = source('supabase/migrations/20261004210000_email_notify.verify.sql');
const cron = source('supabase/migrations/20261005140000_email_notify_cron.sql');
const cronVerify = source('supabase/migrations/20261005140000_email_notify_cron.verify.sql');
const api = source('supabase/functions/app-api/index.ts');
const main = source('src/main.jsx');
const admin = source('src/admin.jsx');
const EMAIL_CORE = '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$';
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `找不到起点：${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `找不到终点：${to}`);
  return text.slice(start, end);
};
// 从 app-api 源码里读出“事件 → 仍然要处理的状态”映射，用来和数据库触发器逐项比对。
const NOTIFY_EVENT_STATUS_FROM_API = () => {
  const block = slice(api, 'const NOTIFY_EVENT_STATUS: Record<string, string> = {', '}');
  return [...block.matchAll(/'([^']+)': '([^']+)'/g)].map((match) => [match[1], match[2]]);
};

test('邮箱统一去空格转小写，空值表示解绑', () => {
  assert.equal(normalizeEmail('  Verify-Notify@Example.COM '), 'verify-notify@example.com');
  assert.equal(normalizeEmail(null), '');
});
test('邮箱校验只接受规范格式且长度受限', () => {
  assert.equal(validateEmail('a@b.cn'), '');
  assert.equal(validateEmail('  A.B+C@Sub.Domain.COM '), '');
  assert.match(normalizeEmail('A@B.CN'), EMAIL_PATTERN);
  assert.notEqual(validateEmail(''), '');
  assert.notEqual(validateEmail('not-an-email'), '');
  assert.notEqual(validateEmail('a@b'), '');
  assert.notEqual(validateEmail('a@b.c'), '');
  assert.notEqual(validateEmail(`${'x'.repeat(EMAIL_MAX)}@b.cn`), '');
});
test('数据库邮箱规则与前端一致：254 长度和同一邮箱形态', () => {
  assert.ok(migration.includes('char_length(email) <= 254'));
  assert.ok(migration.includes(EMAIL_CORE));
  assert.equal(EMAIL_PATTERN.source, `^${EMAIL_CORE}`);
  assert.equal((migration.match(/~\* '\^\[a-z0-9\._%\+\-\]\+@/g) ?? []).length, 3);
  assert.match(migration, /app_bind_email\(p_actor_id uuid, p_user_id uuid, p_email text\)[\s\S]{0,600}normalized !~\* '\^\[a-z0-9\._%\+\-\]\+@/);
});
test('邮件通知总开关默认关闭，逐类勾选默认只开五类待办', () => {
  assert.match(migration, /email_notify_enabled boolean not null default false/);
  assert.match(migration, /email_notify_events text\[\] not null default array\['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记'\]/);
  assert.match(migration, /email_notify_events <@ array\[/);
  assert.match(migration, /if not exists\(select 1 from public\.settings where id = 1 and email_notify_enabled and target_event = any\(email_notify_events\)\) then return null/);
  assert.match(verify, /开关关闭时不应生成队列记录/);
  assert.match(verify, /默认提醒类型应为五类待办/);
  assert.deepEqual(NOTIFY_DEFAULT_EVENTS, ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记']);
  // 缺字段（旧后端）回落到默认值；空数组是合法配置（管理员全部取消勾选），不能被当成缺字段。
  assert.deepEqual(normalizeNotifyEvents(undefined), NOTIFY_DEFAULT_EVENTS);
  assert.deepEqual(normalizeNotifyEvents('待付款登记'), NOTIFY_DEFAULT_EVENTS);
  assert.deepEqual(normalizeNotifyEvents([]), []);
  assert.deepEqual(normalizeNotifyEvents(['已付款', '不存在', '待财委审批', '已付款']), ['待财委审批', '已付款']);
});
test('七类提醒与四处清单一致：待办五类 + 拒绝申请/已付款两个结果通知', () => {
  assert.deepEqual(NOTIFY_EVENTS, ['待财委审批', '待主席审批', '退回修改', '待补充收款码', '待付款登记', '拒绝申请', '已付款']);
  assert.deepEqual(NOTIFY_EVENTS.filter((event) => !NOTIFY_DEFAULT_EVENTS.includes(event)), ['拒绝申请', '已付款']);
  // 状态 → 事件的映射在数据库里只有一份（private.app_notify_event_for_status 的 VALUES 表），
  // 入队触发器与投递前复核都引用它，避免同一张表写两遍后错位。
  const mapping = slice(migration, 'private.app_notify_event_for_status(p_status text)', 'where m.status = p_status');
  const sqlPairs = [...mapping.matchAll(/\('(\w+)', '([^']+)'\)/g)].map((m) => [m[2], m[1]]);
  assert.equal(sqlPairs.length, 7);
  assert.deepEqual(sqlPairs.map(([event]) => event), NOTIFY_EVENTS);
  assert.match(migration, /target_event := private\.app_notify_event_for_status\(new\.status\)/);
  // 已撤回、草稿永远不发：既不是待办也不是结果（根本不在映射表里）。
  for (const never of ['cancelled', 'draft']) assert.equal(new RegExp(`\\('${never}', `).test(mapping), false, `${never} 不应该映射成邮件事件`);
  const apiSlice = slice(api, 'const NOTIFY_EVENTS', 'const STATUS_LABELS');
  const apiEvents = [...apiSlice.matchAll(/'([^']+)': '/g)].map((m) => m[1]);
  assert.deepEqual(apiEvents, NOTIFY_EVENTS);
  const checkEvents = [...migration.matchAll(/event text not null check \(event in \(([^)]+)\)/g)][0][1];
  assert.deepEqual(checkEvents.split(',').map((item) => item.trim().replaceAll("'", '')), NOTIFY_EVENTS);
  // 设置白名单、app-api 的"事件→仍然成立的状态"映射、管理端分组都必须是同一份名单、同一个顺序。
  const settingsCheck = [...migration.matchAll(/email_notify_events <@ array\[([^\]]+)\]/g)][0][1];
  assert.deepEqual(settingsCheck.split(',').map((item) => item.trim().replaceAll("'", '')), NOTIFY_EVENTS);
  assert.deepEqual(NOTIFY_EVENT_STATUS_FROM_API().map(([event]) => event), NOTIFY_EVENTS);
  assert.deepEqual(NOTIFY_EVENT_GROUPS.flatMap((group) => group.events), NOTIFY_EVENTS);
  assert.match(verify, /退回修改只应发给申请人本人/);
  assert.match(verify, /待补充收款码只应发给申请人本人/);
  assert.match(verify, /完结态不应生成队列记录/);
  assert.match(verify, /打开结果通知后，拒绝申请应提醒申请人本人/);
  assert.match(verify, /已付款只应发给申请人本人/);
  assert.match(verify, /拒绝申请只应发给申请人本人/);
});
test('收件人由服务端按状态推导：审批事件给对应角色且跳过申请人本人', () => {
  assert.match(migration, /when '待财委审批' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'finance'\)/);
  assert.match(migration, /when '待主席审批' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'chair'\)/);
  assert.match(migration, /when '待付款登记' then u\.id <> new\.owner_id and private\.app_user_has_role\(u\.id, 'cashier'\)/);
  // 退回修改与待补充收款码是“申请人要动手”，只发给本人；三类审批/付款待办都必须排除申请人。
  assert.match(migration, /else u\.id = new\.owner_id/);
  assert.equal((migration.match(/u\.id <> new\.owner_id/g) ?? []).length, 3);
  assert.match(migration, /where u\.active\s+and coalesce\(u\.email, ''\) <> ''/);
  // 身份含义变化（例如付款登记视同财委）只需要改 private.app_user_has_role，这里必须继续走同一个判定函数。
  // 入队（触发器）与消费前复核（app_notify_recipient_allowed）两处都只能走它，不许直接查 user_roles。
  const trigger = slice(migration, 'create or replace function private.enqueue_email_notification()', 'drop trigger if exists email_notify_status_change');
  assert.equal((trigger.match(/private\.app_user_has_role\(u\.id/g) ?? []).length, 3);
  const consumerCheck = slice(migration, 'create or replace function private.app_notify_recipient_allowed', 'revoke all on function private.app_notify_recipient_allowed');
  assert.equal((consumerCheck.match(/private\.app_user_has_role\(u\.id/g) ?? []).length, 3);
  assert.equal(/from public\.user_roles\s+where user_id = u\.id/.test(migration), false);
});
test('消费前复核收件人身份：角色被撤销、账号停用或邮箱解绑后不再寄出财务详情', () => {
  assert.match(migration, /create or replace function private\.app_notify_recipient_allowed\(p_user_id uuid, p_event text\)/);
  assert.match(migration, /when '待财委审批' then private\.app_user_has_role\(u\.id, 'finance'\)/);
  assert.match(migration, /when '待主席审批' then private\.app_user_has_role\(u\.id, 'chair'\)/);
  assert.match(migration, /when '待付款登记' then private\.app_user_has_role\(u\.id, 'cashier'\)/);
  assert.match(migration, /where n\.status = 'pending' and not private\.app_notify_recipient_allowed\(n\.recipient_user_id, n\.event\)/);
  assert.match(migration, /收件人已不具备该待办的处理身份，提醒已作废/);
  assert.match(migration, /revoke all on function private\.app_notify_recipient_allowed\(uuid, text\) from public, anon, authenticated/);
  // 作废发生在领取之前，只有 pending 会被碰：别人正在发送的行不能被抢标签。
  assert.equal(/status in \('pending','sending'\) and not private\.app_notify_recipient_allowed/.test(migration), false);
  // 数据库侧作废的数量要计进管理面板的“已作废”，否则管理员看到的数字与实际不符。
  assert.match(api, /cancelled \+= Number\(claim\?\.cancelled \?\? 0\)/);
  assert.match(migration, /jsonb_build_object\('discarded', discarded, 'cancelled', cancelled, 'claimed', taken, 'rows', claimed\)/);
  assert.match(verify, /撤销身份后应作废指向该收件人的提醒/);
  assert.match(verify, /撤销身份后不应再有指向该收件人的待发提醒/);
  assert.match(verify, /身份撤销导致的作废应保留原因/);
});
test('发送前复核申请版本：跨版本重提后旧版本的提醒作废，不会和新版本一起寄出', () => {
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(api, /admin\.from\('applications'\)\.select\('id,title,amount,department,category,status,version,owner_id'\)/);
  assert.match(sendOne, /if \(typeof app\.version === 'number' && app\.version !== note\.application_version\)/);
  assert.match(sendOne, /status: 'cancelled', claim_id: null, last_error: `申请已重新提交（版本 \$\{note\.application_version\} → \$\{app\.version\}），提醒已作废`/);
  // 领取时也复核版本：pending 行与 applications.version 不一致就地作废（只碰 pending，不抢正在发送的行）。
  assert.match(migration, /from public\.applications a\s+where a\.id = n\.application_id and a\.version <> n\.application_version\s+and n\.status = 'pending'/);
  assert.match(migration, /'申请已重新提交（版本 ' \|\| n\.application_version \|\| ' → ' \|\| a\.version \|\| '），提醒已作废'/);
  assert.match(migration, /cancelled := cancelled \+ revoked/);
  assert.match(verify, /版本不一致的旧提醒应在领取时作废/);
  assert.match(verify, /版本作废应保留原因/);
  assert.match(verify, /当前版本的提醒不应被误作废/);
  // 领取结果本来就带 application_version，必须用它比较，而不是重新查一次当前值。
  assert.match(migration, /'event', event, 'recipient_user_id', recipient_user_id, 'attempts', attempts, 'last_error', last_error/);
  assert.match(migration, /'application_version', application_version/);
});
test('同一申请同一版本同一事件同一收件人只保留一封待发邮件，已作废的不占名额', () => {
  assert.match(migration, /create unique index if not exists notifications_dedupe_idx\s+on public\.notifications\(application_id, application_version, event, recipient_user_id\)\s+where status <> 'cancelled'/);
  assert.match(migration, /on conflict \(application_id, application_version, event, recipient_user_id\) where status <> 'cancelled' do nothing/);
  assert.match(verify, /同一版本同一事件应只保留一封/);
  assert.match(verify, /新版本应重新入队/);
});
test('收款码被移除会作废本轮的待付款登记提醒，重新提交后可以再次提醒', () => {
  // 触发器：离开 payment_pending 且回到“待补充收款码”时，把这一版的待付款登记提醒标记为 cancelled。
  assert.match(migration, /if old\.status = 'payment_pending' and new\.status = 'payment_info_required' then/);
  assert.match(migration, /set status = 'cancelled', claim_id = null, lease_expires_at = now\(\)/);
  assert.match(migration, /收款信息已变更，本次待付款登记提醒作废/);
  assert.match(migration, /event = '待付款登记' and status <> 'cancelled'/);
  assert.match(verify, /移除收款码应作废本轮的待付款登记提醒/);
  assert.match(verify, /重新提交收款码后应再次入队/);
});
test('后端绑定邮箱只写入当前账号，请求体与数据库层都不接受替别人绑定', () => {
  assert.match(api, /action === 'bind_email'[\s\S]{0,240}p_actor_id: actor\.user\.id, p_user_id: actor\.user\.id, p_email/);
  assert.equal(/action === 'bind_email'[\s\S]{0,320}body\.user_id/.test(api), false);
  assert.match(migration, /app_bind_email\(p_actor_id uuid, p_user_id uuid, p_email text\)[\s\S]{0,900}where id = p_user_id and active/);
  assert.match(migration, /if p_actor_id is null or p_user_id is null or p_actor_id <> p_user_id then raise exception '只能绑定自己的邮箱'; end if;/);
  assert.ok(verify.includes("perform public.app_bind_email(new_id, new_id, 'not-an-email')"));
  assert.match(verify, /替别人绑定邮箱应被拒绝/);
});
test('审计与队列记录都不落邮箱地址', () => {
  assert.match(migration, /'绑定邮箱', case when normalized = '' then '清除邮箱' else '邮箱已更新' end/);
  const bindSlice = slice(migration, 'public.app_bind_email(p_actor_id', 'public.app_update_email_notify');
  const auditLine = bindSlice.slice(bindSlice.indexOf('insert into public.audit_logs'));
  assert.equal(auditLine.includes('||'), false);
  assert.equal(/create table if not exists public\.notifications\([\s\S]{0,900}email/.test(migration), false);
});
test('邮件正文只含申请可见字段与入口链接，不含令牌或附件地址', () => {
  const builder = slice(api, 'function buildNotifyEmail', "const bucket = 'application-files'");
  for (const field of ['申请标题', '金额', '部门 / 活动', '费用类别', '申请人', '当前状态']) assert.ok(builder.includes(`['${field}'`), `正文缺少 ${field}`);
  for (const banned of ['storage_path', 'token', 'signedUrl', 'file.', 'mime']) assert.equal(builder.includes(banned), false, `正文不应出现 ${banned}`);
  assert.match(api, /escapeHtml\(appUrl\)/);
  assert.match(api, /await audit\(actorId, '发送邮件提醒'/);
});
test('队列消费参数在前端、后端与数据库取值范围三方一致', () => {
  assert.match(api, new RegExp(`const NOTIFY_BATCH = ${NOTIFY_QUEUE.batch}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_ROUNDS = ${NOTIFY_QUEUE.rounds}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_CONCURRENCY = ${NOTIFY_QUEUE.concurrency}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_SEND_TIMEOUT_MS = ${NOTIFY_QUEUE.sendTimeoutMs}\\b`));
  // 租约不再写死：它按预算派生（预算 + 60 秒，至少 5 分钟、最多 900 秒），保证整轮预算不会超出自己的租约。
  assert.match(api, new RegExp(`const NOTIFY_LEASE_LIMIT_SECONDS = ${NOTIFY_QUEUE.leaseSeconds * 3}\\b`));
  assert.match(api, /const NOTIFY_LEASE_SECONDS = Math\.min\(NOTIFY_LEASE_LIMIT_SECONDS, Math\.max\(300, Math\.ceil\(NOTIFY_MAX_RUNTIME_MS \/ 1000\) \+ 60\)\)/);
  assert.ok(NOTIFY_QUEUE.leaseSeconds * 1000 > NOTIFY_QUEUE.sendTimeoutMs, '默认租约必须比单封超时更久，否则慢批次会被别人抢走');
  assert.match(api, new RegExp(`const NOTIFY_MAX_AGE_HOURS = ${NOTIFY_QUEUE.maxAgeHours}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_MAX_ATTEMPTS = ${NOTIFY_QUEUE.maxAttempts}\\b`));
  assert.match(api, new RegExp(`const NOTIFY_BACKOFF_CAP_MINUTES = ${NOTIFY_QUEUE.backoffCapMinutes}\\b`));
  // 预算：默认值必须明显低于托管免费方案的 150 秒墙钟与 idle timeout，并且可由服务端环境变量调大。
  assert.match(api, new RegExp(`const NOTIFY_DEFAULT_RUNTIME_MS = ${NOTIFY_QUEUE.maxRuntimeMs}\\b`));
  assert.ok(NOTIFY_QUEUE.maxRuntimeMs < 150000, '默认预算必须留在免费方案的 150 秒墙钟之内');
  assert.ok(NOTIFY_QUEUE.maxRuntimeMs > NOTIFY_QUEUE.sendTimeoutMs * 3, '默认预算至少要够跑几个发送组');
  assert.match(api, /Deno\.env\.get\('NOTIFY_MAX_RUNTIME_MS'\)/);
  assert.match(api, /Math\.min\(Math\.max\(configuredRuntimeMs, NOTIFY_MIN_RUNTIME_MS\), NOTIFY_MAX_RUNTIME_LIMIT_MS\)/);
  assert.match(api, /const NOTIFY_MAX_RUNTIME_LIMIT_MS = 840000/);
  assert.match(api, /const NOTIFY_LEASE_LIMIT_SECONDS = 900/);
  // 下限必须高于"一组 + 收尾"，否则每轮都会在第一组之前退出、一封都发不出去（实测过的坑）。
  assert.match(api, /const NOTIFY_MIN_RUNTIME_MS = NOTIFY_GROUP_BUDGET_MS \+ NOTIFY_WRAPUP_BUDGET_MS \+ NOTIFY_SEND_TIMEOUT_MS/);
  const groupBudget = NOTIFY_QUEUE.sendTimeoutMs + 5000;
  const minBudget = groupBudget + 20000 + NOTIFY_QUEUE.sendTimeoutMs;
  assert.ok(minBudget > groupBudget + 20000, '配置下限必须大于一组预算 + 收尾余量');
  assert.ok(NOTIFY_QUEUE.maxRuntimeMs > minBudget, '默认预算必须大于配置下限');
  assert.match(migration, /p_limit < 1 or p_limit > 200/);
  assert.match(migration, /p_lease_seconds < 30 or p_lease_seconds > 900/);
  assert.match(migration, /p_max_age_hours < 1 or p_max_age_hours > 168/);
  assert.ok(NOTIFY_QUEUE.batch >= 1 && NOTIFY_QUEUE.batch <= 200);
  assert.ok(NOTIFY_QUEUE.leaseSeconds >= 30 && NOTIFY_QUEUE.leaseSeconds <= 900);
  assert.ok(NOTIFY_QUEUE.maxAgeHours >= 1 && NOTIFY_QUEUE.maxAgeHours <= 168);
  assert.ok(NOTIFY_QUEUE.leaseSeconds * 1000 > NOTIFY_QUEUE.sendTimeoutMs, '租约必须比单封超时更久，否则慢批次会被别人抢走');
});
test('发送前先原子领取：带批次号与租约，写回必须同时匹配，两个发送方不会重复寄信', () => {
  assert.match(migration, /create or replace function public\.app_claim_notifications\(p_claim_id uuid, p_limit integer, p_lease_seconds integer, p_max_age_hours integer, p_max_attempts integer default 5\)/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /set status = 'sending', lease_expires_at = now\(\) \+ make_interval\(secs => p_lease_seconds\), claim_id = p_claim_id/);
  assert.match(api, /rpc\('app_claim_notifications', \{ p_claim_id: claimId, p_limit: NOTIFY_BATCH, p_lease_seconds: NOTIFY_LEASE_SECONDS, p_max_age_hours: NOTIFY_MAX_AGE_HOURS, p_max_attempts: NOTIFY_MAX_ATTEMPTS \}\)/);
  assert.match(api, /\.eq\('id', note\.id\)\.eq\('status', 'sending'\)\.eq\('claim_id', claimId\)/);
  assert.match(migration, /status text not null default 'pending' check \(status in \('pending','sending','sent','failed','cancelled'\)\)/);
  // 旧的四参数签名必须先删掉，否则 PostgREST 的命名参数调用会在两个重载之间产生歧义。
  assert.match(migration, /where n\.nspname = 'public' and p\.proname = 'app_claim_notifications'[\s\S]{0,120}drop function public\.%I\(%s\)/);
});
test('中断批次退回队列并计入尝试，超龄提醒丢弃且保留原因，恢复路径同样受失败上限约束', () => {
  assert.match(migration, /where status = 'sending' and lease_expires_at <= now\(\)/);
  assert.match(migration, /set status = 'pending', attempts = attempts \+ 1, claim_id = null, next_attempt_at = now\(\)/);
  assert.match(migration, /上一次发送未完成，已重新排队/);
  assert.match(migration, /where status = 'pending' and created_at < now\(\) - make_interval\(hours => p_max_age_hours\)/);
  assert.match(migration, /小时未发送，已丢弃/);
  // 恢复路径也执行失败上限，并且超龄的 sending 行直接判丢弃，不会先退回队列再被本轮寄出。
  assert.match(migration, new RegExp(`p_max_attempts integer default ${NOTIFY_QUEUE.maxAttempts}\\)`));
  assert.match(migration, /attempts \+ 1 >= p_max_attempts/);
  assert.match(migration, /'连续 ' \|\| \(attempts \+ 1\) \|\| ' 次发送未完成，已停止重试'/);
  assert.match(migration, /if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then raise exception '失败重试上限无效'/);
  assert.match(api, /p_max_attempts: NOTIFY_MAX_ATTEMPTS/);
  assert.match(verify, /中断批次应重新领取并计入一次尝试/);
  assert.match(verify, /超龄提醒不应继续留在队列/);
  assert.match(verify, /丢弃应保留原因/);
  assert.match(verify, /中断恢复应在尝试次数用满后判失败/);
  assert.match(verify, /超龄的发送中行恢复时应记为已丢弃/);
});
test('队列消费只有一个实现，管理员会话与定时任务共用', () => {
  assert.match(api, /const drainNotifications = async \(actorId: string \| null\) =>/);
  assert.match(api, /action === 'send_notifications'[\s\S]{0,240}requireRole\(actor, 'admin'\)/);
  assert.match(api, /return await drainNotifications\(actor\.user\.id\)/);
  assert.match(api, /return await drainNotifications\(null\)/);
  assert.equal(/const due, error: dueError/.test(api), false, '不允许再走“裸查队列再逐行写回”的旧路径');
});
test('定时入口只放行消费队列，密钥不正确就拒绝，且不要求用户登录', () => {
  assert.match(api, /if \(action === 'send_notifications' && cronHeader\)/);
  assert.match(api, /if \(!cronSecret \|\| !sameSecret\(cronHeader, cronSecret\)\) throw new HttpError\('定时密钥不正确。', 401\)/);
  assert.match(api, /Deno\.env\.get\('CRON_SECRET'\)/);
  assert.match(api, /function sameSecret\(left: string, right: string\)[\s\S]{0,240}diff \^= left\.charCodeAt\(index\) \^ right\.charCodeAt\(index\)/);
  const preAuth = slice(api, '// 定时任务没有用户会话', "if (action === 'me')");
  assert.deepEqual([...new Set([...preAuth.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]))], ['send_notifications']);
  assert.equal(preAuth.includes('requireRole'), false, '定时入口不得借用某个人的登录会话');
});
test('开关关闭优先于密钥检查：定时任务不会因为没配邮件服务而反复失败刷日志', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  assert.ok(drain.indexOf('if (!settingsRow.email_notify_enabled)') < drain.indexOf('if (!apiUrl || !apiKey || !emailFrom)'));
  assert.match(drain, /if \(!settingsRow\.email_notify_enabled\) return ok\(\{ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, stale: 0, skipped: true/);
  assert.match(drain, /if \(actorId === null\) return ok\(\{[\s\S]{0,200}misconfigured: true/);
  assert.match(drain, /throw new HttpError\('邮件服务尚未配置，请项目负责人为 app-api 配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM。', 503\)/);
  assert.match(drain, /AbortSignal\.timeout\(NOTIFY_SEND_TIMEOUT_MS\)/);
  assert.match(drain, /while \(rounds < NOTIFY_ROUNDS && !stop\)/);
  assert.match(drain, /rows\.slice\(index, index \+ NOTIFY_CONCURRENCY\)/);
});
test('一轮消费有时间预算：每一组之前判断"够不够跑完这一组并收尾"，到点原样退回队列', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  assert.match(drain, /const timeLeft = \(\) => NOTIFY_MAX_RUNTIME_MS - \(Date\.now\(\) - startedAt\)/);
  // 只判断"> 0"不够：最后一组会被平台墙钟掐断，剩下的行只能等租约到期、白吃一次尝试次数。
  assert.match(drain, /if \(timeLeft\(\) < NOTIFY_GROUP_BUDGET_MS \+ NOTIFY_WRAPUP_BUDGET_MS\) break/);
  assert.match(drain, /if \(timeLeft\(\) < NOTIFY_GROUP_BUDGET_MS \+ NOTIFY_WRAPUP_BUDGET_MS \|\| throttleWait > 0\) \{ stop = true; break \}/);
  assert.match(api, /const NOTIFY_GROUP_BUDGET_MS = NOTIFY_SEND_TIMEOUT_MS \+ 5000/);
  assert.match(api, /const NOTIFY_WRAPUP_BUDGET_MS = 20000/);
  assert.equal(/timeLeft\(\) <= 0/.test(drain), false, '不允许再只判断"> 0"');
  // 退回队列的行必须回到 pending、清掉批次号，并且不写 attempts。
  const release = slice(drain, 'const release = (note', 'const recheckGroup = async');
  assert.match(release, /status: 'pending', claim_id: null/);
  assert.equal(/attempts:/.test(release), false, '退回队列不能消耗尝试次数');
  assert.match(drain, /const leftovers = rows\.filter\(\(note\) => !touched\.has\(note\.id\)\)/);
  assert.match(drain, /deferred \+= results\.filter\(Boolean\)\.length/);
  assert.match(drain, /本轮时间用尽，已退回队列/);
});
test('投递前复核每个发送组：白名单契约——只有明确判 send 的行才投递', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  // handler 侧：每组之前调用数据库复核，按 verdict 行事——send 才投递、cancel 就地作废、skip/缺席一律不发也不改状态。
  assert.match(drain, /const recheckGroup = async \(group: Record<string, any>\[\]\) => \{/);
  assert.match(drain, /verdicts = await rpc\('app_notify_verify_rows', \{ p_claim_id: claimId, p_ids: group\.map\(\(note\) => note\.id\) \}\)/);
  assert.match(drain, /const verdict = verdictById\.get\(Number\(note\.id\)\)/);
  assert.match(drain, /if \(verdict\?\.verdict !== 'send'\) \{/);
  assert.match(drain, /const reason = verdict\.reason \|\| '投递前复核未通过，提醒已作废'/);
  assert.match(drain, /if \(await settle\(note, \{ status: 'cancelled', claim_id: null, last_error: reason\.slice\(0, 300\) \}\)\) cancelled\+\+/);
  // skip/缺席分支只能计数，不能写回任何状态：旧版就是在这里把"没有判定"当成了放行。
  // （收尾退回队列对"本批持有、仅租约过期"的 skip 仍生效，那是既有中断恢复语义，不是复核写的。）
  const skipBranch = drain.slice(drain.indexOf("if (verdict?.verdict !== 'send')"));
  const skipElse = skipBranch.slice(skipBranch.indexOf('} else {'));
  assert.match(skipElse.slice(0, 400), /stale\+\+/, 'skip/缺席的行应计进跳过数');
  assert.equal(/settle\(/.test(skipElse.slice(0, skipElse.indexOf('stale++'))), false, 'skip/缺席的行不能被复核写回状态');
  assert.match(drain, /const group = await recheckGroup\(rows\.slice\(index, index \+ NOTIFY_CONCURRENCY\)\)/);
  // 放行的行先按"当前邮箱"重读一次收件人（不能拿整批开始时的地址快照投递），再逐封发送；
  // 重读失败与复核失败同一套降级策略：整组退回队列并收尾。
  assert.match(drain, /const fresh = await admin\.from\('app_users'\)\.select\('id,email,active'\)\.in\('id', \[\.\.\.new Set\(group\.map\(\(note\) => note\.recipient_user_id\)\)\]\)/);
  assert.match(drain, /if \(fresh\.error\) \{[\s\S]{0,400}status: 'pending', claim_id: null[\s\S]{0,200}stop = true/);
  assert.match(drain, /await Promise\.all\(group\.map\(sendOne\)\)/);
  // 数据库侧：请求里的每个 id 都必须拿到明确判定；非本次领取的行判 skip，而不是“从结果里消失”。
  assert.match(migration, /create or replace function public\.app_notify_verify_rows\(p_claim_id uuid, p_ids bigint\[\]\)/);
  // `p_claim_id is null` 也要判 skip：否则"行 claim_id 也是 NULL"时 is distinct from 为假、会被误判成 send。
  assert.match(migration, /when p_claim_id is null or n\.status <> 'sending' or n\.claim_id is distinct from p_claim_id or n\.lease_expires_at <= now\(\)\s+then 'skip'/);
  assert.match(migration, /when not private\.app_notify_recipient_allowed\(n\.recipient_user_id, n\.event\)\s+then 'cancel'/);
  assert.match(migration, /when a\.id is null or a\.version is distinct from n\.application_version\s+then 'cancel'/);
  assert.match(migration, /when n\.event is distinct from private\.app_notify_event_for_status\(a\.status\)\s+then 'cancel'/);
  assert.match(migration, /else 'send'/);
  assert.match(migration, /该行已不属于本次领取（状态、批次或租约已变化），不再投递/);
  // 旧 blocked 复核入口必须整体删除，不许在库里留下第二个复核函数（那正是“缺席即放行”的来源）。
  assert.match(migration, /p\.proname = 'app_notify_blocked_rows'[\s\S]{0,120}drop function public\.%I\(%s\)/);
  assert.equal(/\.rpc\(\s*'app_notify_blocked_rows'/.test(api), false, 'handler 不应再调用旧 blocked 契约（注释里提到历史函数名不算）');
  assert.match(migration, /revoke all on function public\.app_notify_verify_rows\(uuid, bigint\[\]\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.app_notify_verify_rows\(uuid, bigint\[\]\) to service_role/);
  // 投递前复核只看逐类开关，不看总开关：总开关是暂停（下一轮 skipped），不是"该类型被关闭"的作废理由。
  assert.match(migration, /when not exists\(select 1 from public\.settings s where s\.id = 1 and n\.event = any\(s\.email_notify_events\)\)\s+then 'cancel'/);
  const verifyFn = slice(migration, 'create or replace function public.app_notify_verify_rows', '-- 永久失败');
  assert.equal(verifyFn.includes('email_notify_enabled'), false, '投递前复核不应把总开关当成作废条件');
  assert.match(verify, /领取后撤销身份的行应被投递前复核判为 cancel/);
  assert.match(verify, /身份仍有效的行应被投递前复核明确放行/);
  assert.match(verify, /已被作废的提醒应判为 skip/);
  assert.match(verify, /批次号不匹配的行应判为 skip/);
  assert.match(verify, /租约已过期的行应判为 skip/);
  assert.match(verify, /投递前复核不应改动已作废行的状态/);
});
test('提醒类型配置：逐类开关入库、非枚举值被拒、只有管理员能改、关闭后积压行作废', () => {
  assert.match(migration, /create or replace function public\.app_update_email_notify\(p_actor_id uuid, p_enabled boolean, p_events text\[\]\)/);
  assert.match(migration, /if p_events is null or exists\(\s+select 1 from unnest\(p_events\) e\s+where e is null or e not in \('待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款'\)\) then\s+raise exception '提醒类型无效'/);
  // 固定顺序 + 去重由服务端做，前端传什么顺序都不影响判定。
  assert.match(migration, /unnest\(array\['待财委审批','待主席审批','退回修改','待补充收款码','待付款登记','拒绝申请','已付款'\]\) with ordinality/);
  assert.match(migration, /set email_notify_enabled = p_enabled, email_notify_events = normalized/);
  assert.match(migration, /values \(p_actor_id, '修改邮件通知设置',/);
  assert.match(migration, /'提醒类型', jsonb_build_object\('原值', to_jsonb\(old_events\), '新值', to_jsonb\(normalized\)\)\)/);
  // 换签名要先把旧重载删掉，否则 PostgREST 命名参数调用会有歧义。
  assert.match(migration, /where n\.nspname = 'public' and p\.proname = 'app_update_email_notify'[\s\S]{0,120}drop function public\.%I\(%s\)/);
  assert.match(migration, /revoke all on function public\.app_update_email_notify\(uuid, boolean, text\[\]\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.app_update_email_notify\(uuid, boolean, text\[\]\) to service_role/);
  // 领取时关掉的类型就地作废（总开关关闭时不调用领取：app-api 直接返回 skipped）。
  assert.match(migration, /where n\.status = 'pending'\s+and not exists\(select 1 from public\.settings s where s\.id = 1 and n\.event = any\(s\.email_notify_events\)\)/);
  assert.match(migration, /'管理员已关闭「' \|\| n\.event \|\| '」提醒，本封已作废'/);
  assert.match(migration, /cancelled := cancelled \+ disabled/);
  // app-api：读配置、校验请求体、把事件数组透传给 RPC，并在管理数据里回传当前勾选。
  assert.match(api, /admin\.from\('settings'\)\.select\('email_notify_enabled,email_notify_events'\)\.eq\('id', 1\)\.single\(\)/);
  assert.match(api, /admin\.from\('settings'\)\.select\('threshold,registration_enabled,email_notify_enabled,email_notify_events,qq_notify_enabled,qq_group_openid,qq_notify_events(,qq_command_groups)?'\)\.eq\('id', 1\)\.single\(\)/);
  assert.match(api, /if \(!Array\.isArray\(body\.events\)\) throw new HttpError\('请选择要发送的提醒类型。'\)/);
  assert.match(api, /await rpc\('app_update_email_notify', \{ p_actor_id: actor\.user\.id, p_enabled: body\.enabled, p_events: events \}\)/);
  assert.match(api, /email_notify_events: Array\.isArray\(settingResult\.data\.email_notify_events\) \? settingResult\.data\.email_notify_events : \[\]/);
  // verify：默认值、结果通知默认关 → 打开后入队、乱序规范化、普通成员/非法枚举被拒、单类关闭作废积压。
  assert.match(verify, /默认提醒类型应为五类待办/);
  assert.match(verify, /提醒类型应按固定顺序去重保存/);
  assert.match(verify, /普通成员不应能修改提醒设置/);
  assert.match(verify, /非法提醒类型应被拒绝/);
  assert.match(verify, /关闭类型后已积压的该类提醒应作废/);
  assert.match(verify, /关闭类型的作废应保留原因/);
});
test('管理端把提醒类型交给管理员勾选：总开关 + 分组逐类，保存时一起提交', () => {
  assert.match(admin, /request\('update_email_notify', \{ enabled: emailNotify, events: emailEvents \}\)/);
  assert.match(admin, /setEmailEvents\(normalizeNotifyEvents\(result\.data\.email_notify_events\)\)/);
  assert.match(admin, /NOTIFY_EVENT_GROUPS\.map\(\(group\) => <div className="notify-event-group" key=\{group\.title\}>/);
  assert.match(admin, /checked=\{emailEvents\.includes\(event\)\}/);
  assert.match(admin, /setEmailEvents\(normalizeNotifyEvents\(e\.target\.checked \? \[\.\.\.emailEvents, event\] : emailEvents\.filter\(\(item\) => item !== event\)\)\)/);
  assert.match(admin, /已勾选 \{emailEvents\.length\} \/ \{NOTIFY_EVENTS\.length\} 类提醒/);
  assert.match(admin, /结果类（拒绝申请、已付款）只发给申请人本人，默认不勾选，需要时打开/);
  assert.match(admin, /import \{ NOTIFY_QUEUE, NOTIFY_EVENTS, NOTIFY_DEFAULT_EVENTS, NOTIFY_EVENT_GROUPS, normalizeNotifyEvents \} from '\.\/notify-rules\.js';/);
  assert.match(main, /是否收到邮件提醒由管理员在设置里配置/);
  assert.match(main, /结果类（申请被拒绝、已完成打款）默认关闭/);
});
test('发送前复核状态：已经不处于待办状态的提醒改为作废，不再寄出', () => {
  assert.deepEqual(NOTIFY_EVENT_STATUS_FROM_API(), [
    ['待财委审批', 'finance_pending'], ['待主席审批', 'chair_pending'], ['退回修改', 'changes_requested'],
    ['待补充收款码', 'payment_info_required'], ['待付款登记', 'payment_pending'],
    ['拒绝申请', 'rejected'], ['已付款', 'paid'],
  ]);
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /const expectedStatus = NOTIFY_EVENT_STATUS\[note\.event\]/);
  assert.match(sendOne, /if \(expectedStatus && app\.status !== expectedStatus\)/);
  assert.match(sendOne, /status: 'cancelled', claim_id: null, last_error: `申请状态已变为「\$\{STATUS_LABELS\[app\.status\] \?\? app\.status\}」，提醒已作废`/);
  // 事件与期望状态的映射必须和数据库里那份唯一的映射表一致。
  const mapping = slice(migration, 'private.app_notify_event_for_status(p_status text)', 'where m.status = p_status');
  const sqlMapping = [...mapping.matchAll(/\('(\w+)', '([^']+)'\)/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(NOTIFY_EVENT_STATUS_FROM_API(), sqlMapping);
});
test('邮件服务限频（429）不计入尝试次数，按 Retry-After 暂停本轮并退回其余行', () => {
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /if \(response\.status === 429\)/);
  assert.match(sendOne, /response\.headers\.get\('retry-after'\)/);
  assert.match(sendOne, /throttleWait = Math\.max\(throttleWait, Math\.min\(Math\.max\(wait, NOTIFY_THROTTLE_MIN_WAIT_SECONDS\), NOTIFY_THROTTLE_MAX_WAIT_SECONDS\)\)/);
  // 限频的那封回到 pending 且 attempts 不变；其余没发送的行整批退回，不逐封烧尝试次数。
  const throttleBranch = slice(sendOne, 'if (throttled) {', 'const attempts = note.attempts + 1');
  assert.match(throttleBranch, /status: 'pending', claim_id: null/);
  assert.equal(/attempts:/.test(throttleBranch), false, '限频不能计入尝试次数');
  assert.match(throttleBranch, /邮件服务限频（HTTP 429）/);
  assert.match(api, /const NOTIFY_THROTTLE_MIN_WAIT_SECONDS = 30/);
  assert.match(api, /const NOTIFY_THROTTLE_MAX_WAIT_SECONDS = 600/);
});
test('发送时跳过已停用收件人和不存在的申请，失败按 2 的幂退避并封顶', () => {
  assert.match(api, /admin\.from\('app_users'\)\.select\('id,email,full_name,username,active'\)/);
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  assert.match(sendOne, /if \(!app\) \{/);
  assert.match(sendOne, /last_error: '申请已不存在'/);
  assert.match(sendOne, /if \(!recipient\?\.email\) \{/);
  assert.match(sendOne, /last_error: '收件人邮箱已不存在'/);
  assert.match(sendOne, /if \(!recipient\.active\)/);
  assert.match(sendOne, /last_error: '收件人账号已停用'/);
  assert.match(sendOne, /if \(attempts >= NOTIFY_MAX_ATTEMPTS\)/);
  assert.match(sendOne, /Math\.min\(2 \*\* attempts, NOTIFY_BACKOFF_CAP_MINUTES\)/);
});
test('写回失败不算已处理：计数只在写回成功后增加，行留给退回步骤或租约', () => {
  const drain = slice(api, 'const drainNotifications = async', "const { count: pendingLeft");
  // settle 返回是否写回成功；失败时该行不进 touched，于是会被收尾的退回步骤重新处理。
  // 用 `.select('id')` 拿回写结果：0 行命中也算失败（那一行已经被别的批次抢走），否则计数与重复投递都看不出来。
  assert.match(drain, /const \{ data, error \} = await admin\.from\('notifications'\)\.update\(fields\)\.eq\('id', note\.id\)\.eq\('status', 'sending'\)\.eq\('claim_id', claimId\)\.select\('id'\)/);
  assert.match(drain, /if \(!Array\.isArray\(data\) \|\| data\.length !== 1\) return false/);
  assert.match(drain, /if \(error\) return false[\s\S]{0,80}touched\.add\(note\.id\)[\s\S]{0,20}return true/);
  // 每种终局都在写回成功后才计数，审计里的数字不虚报。
  const sendOne = slice(api, 'const sendOne = async', 'for (let index = 0;');
  for (const counter of ['sent\\+\\+', 'failed\\+\\+', 'cancelled\\+\\+', 'retried\\+\\+']) {
    const gated = new RegExp(`if \\(await settle\\(note, \\{[\\s\\S]{0,220}?\\)\\) ${counter}`);
    assert.match(sendOne, gated, `${counter} 应该在写回成功后才计数`);
  }
  // 退回步骤只统计写回成功的行，而且同一行只能计一次：被复核判 skip、收尾又退回成功的行，
  // 计数要从「跳过」挪进「退回」，否则 6 行的队列会报出 7 个封数（运行时用例「复核跳过的行不再被重复计进
  // 「本轮退回」：6 行提醒的封数必须对齐」盯着这条；审计文案也不能再声称"本轮均未投递"）。
  assert.match(drain, /const group = leftovers\.slice\(index, index \+ NOTIFY_CONCURRENCY\)/);
  assert.match(drain, /const results = await Promise\.all\(group\.map\(\(note\) => release\(note, message\)\)\)/);
  assert.match(drain, /deferred \+= results\.filter\(Boolean\)\.length/);
  assert.match(drain, /const movedFromStale = results\.filter\(\(released, position\) => released && staleIds\.has\(Number\(group\[position\]\.id\)\)\)\.length/);
  assert.match(drain, /stale -= movedFromStale/);
  // 收尾文案区分"复核失败"与"时间用尽"：复核失败时预算根本没用到。
  assert.match(drain, /recheckFailures > 0 \? '投递前复核失败，本轮未继续，已退回队列' : '本轮时间用尽，已退回队列'/);
  // 领取时把上一次的失败原因带回来，退回时不会把它冲掉。
  assert.match(migration, /'attempts', attempts, 'last_error', last_error\) order by created_at, id/);
});
test('永久失败可以重新排队，且只有管理员可以', () => {
  assert.match(migration, /create or replace function public\.app_reset_failed_notifications\(p_actor_id uuid\)/);
  assert.match(migration, /if not private\.app_user_has_role\(p_actor_id, 'admin'\) then raise exception '没有管理员权限'; end if;/);
  assert.match(migration, /set status = 'pending', attempts = 0, next_attempt_at = now\(\), lease_expires_at = now\(\), claim_id = null\s+where status = 'failed'/);
  assert.match(api, /action === 'reset_notifications'[\s\S]{0,240}requireRole\(actor, 'admin'\)/);
  assert.match(api, /rpc\('app_reset_failed_notifications', \{ p_actor_id: actor\.user\.id \}\)/);
  assert.match(verify, /重置后失败项应回到待发送/);
  assert.match(verify, /非管理员不应能重置队列/);
});
test('密钥只从 Edge Function 环境读取，配置值不进前端、仓库与日志', () => {
  assert.match(api, /Deno\.env\.get\('EMAIL_API_KEY'\)/);
  assert.match(api, /Deno\.env\.get\('EMAIL_FROM'\)/);
  assert.equal(api.includes('console.log(apiKey'), false);
  assert.equal(api.includes('console.log(cronSecret'), false);
  assert.equal(cron.includes('Bearer '), false, '定时调度 SQL 不得内嵌任何真实密钥');
});
test('定时消费用 pg_cron，缺扩展或未配置时只提示不阻塞，且不写死项目地址', () => {
  assert.match(cron, /create or replace function public\.app_register_email_cron\(\)/);
  assert.match(cron, /cron\.schedule\(%L, %L, %L\)/);
  assert.match(cron, /job_name, '\*\/5 \* \* \* \*'/);
  assert.match(cron, /'x-app-cron', p_cron_secret/);
  // pg_net 的 timeout_milliseconds 现在真的生效（官方文档 default 2000 毫秒）：必须显式传，否则一轮消费几秒就被掐断。
  assert.match(cron, /timeout_milliseconds := %s/);
  assert.match(cron, /stabx\.email_cron_timeout_ms/);
  assert.match(cron, /declare cron_timeout_ms integer := case when raw_timeout ~ '\^\[0-9\]\+\$' then raw_timeout::integer else 140000 end/);
  assert.match(cron, /current_setting\('stabx\.email_cron_secret', true\)/);
  assert.match(cron, /not exists\(select 1 from pg_available_extensions where name = 'pg_cron'\)/);
  assert.match(cron, /for old_job in select jobid from cron\.job where jobname = job_name loop/);
  assert.equal(cron.includes('https://'), false, '项目地址来自数据库参数，不写进仓库');
  assert.match(cronVerify, /重复登记应只保留一条调度/);
  // PL/pgSQL 的 RAISE 不能用 || 拼字符串（'…' || var 是语法错误，评审在邮件迁移里发现过一次，
  // 姊妹脚本 20261005140000_email_notify_cron.verify.sql 里还有一处，是真实执行测试抓出来的）。
  for (const text of [verify, cronVerify]) {
    assert.equal(/raise\s+(exception|notice)\s+'[^']*'\s*\|\|/.test(text), false, 'RAISE 必须用 % 占位符，不能拼字符串');
  }
});
test('迁移先检查散装 SQL 的前置依赖，避免运行期才报函数不存在', () => {
  assert.match(migration, /if to_regprocedure\('private\.app_insert_user\(text,text,text,text\)'\) is null then/);
  assert.match(migration, /请先执行 supabase\/admin-settings-audit\.sql/);
  // 建号分配角色与身份判定同样在运行期才会用到，缺了也要在迁移时就报出来。
  assert.match(migration, /if to_regprocedure\('public\.app_set_member_roles\(uuid,uuid,text\[\],boolean\)'\) is null then/);
  assert.match(migration, /if to_regprocedure\('private\.app_user_has_role\(uuid,text\)'\) is null then/);
});
test('状态中文标签在 app-api 与前端两份拷贝之间逐项一致', () => {
  // 这两份是各自独立的拷贝（Edge Function 不能引用前端模块、前端也不引用函数），没有任何运行期约束，
  // 只能靠这条契约测试挡住"改一处忘另一处"。
  const apiLabels = [...slice(api, 'const STATUS_LABELS: Record<string, string> = {', '}').matchAll(/([a-z_]+): '([^']+)'/g)].map((match) => [match[1], match[2]]);
  const mainLabels = [...slice(main, 'const STATUS = {', '};').matchAll(/([a-z_]+): '([^']+)'/g)].map((match) => [match[1], match[2]]);
  for (const status of ['draft', 'finance_pending', 'chair_pending', 'changes_requested', 'rejected', 'payment_info_required', 'payment_pending', 'paid', 'cancelled']) {
    assert.ok(apiLabels.some(([key]) => key === status), `app-api 的 STATUS_LABELS 缺少 ${status}`);
  }
  assert.deepEqual(mainLabels, apiLabels, '两端的状态中文标签必须逐项一致');
});
test('管理员列表只回传是否绑定邮箱，不回传地址本身', () => {
  assert.match(api, /has_email: bound\.has\(row\.id\)/);
  const membersSlice = slice(api, "action === 'admin_members'", "action === 'update_registration'");
  assert.equal(membersSlice.includes(', email'), false);
  assert.match(admin, /profile\.has_email \? '' : ' · 未绑定邮箱'/);
});
test('管理数据的每个队列查询都要报错，不再静默显示 0 封', () => {
  assert.match(api, /if \(settingResult\.error \|\| auditResult\.error \|\| pendingResult\.error \|\| sendingResult\.error \|\| sentResult\.error \|\| failedResult\.error \|\| cancelledResult\.error\)/);
  assert.match(api, /cancelled: cancelledResult\.count \?\? 0/);
  assert.match(api, /if \(failuresResult\.error\) throw new Error\('通知队列读取失败。'\)/);
  assert.match(api, /if \(recipientsResult\.error\) throw new Error\('用户信息读取失败。'\)/);
  const failureSlice = slice(api, 'const failureRows = failuresResult.data', "if (action === 'admin_members')");
  assert.equal(failureSlice.includes(',email'), false);
  assert.match(api, /\.select\('id,event,application_id,recipient_user_id,attempts,last_error,created_at'\)/);
});
test('管理端提供开关、五类队列统计、配置提示、失败明细与手动发送入口', () => {
  assert.ok(admin.includes('<h2>邮件通知</h2>'));
  assert.match(admin, /待发送 \{queue\.pending\} 封 · 发送中 \{queue\.sending\} 封 · 已发送 \{queue\.sent\} 封 · 失败 \{queue\.failed\} 封 · 已作废 \{queue\.cancelled\} 封/);
  assert.match(admin, /「已作废」表示提醒发出前申请状态已经变化/);
  assert.match(admin, /request\('send_notifications', \{\}\)/);
  assert.match(admin, /request\('reset_notifications', \{\}\)/);
  assert.match(admin, /data\.email_service_configured === false/);
  assert.match(admin, /邮箱（可选，用于接收待办提醒）/);
});
test('后端未随前端一起部署时设置面板仍有兜底，不再整页白屏', () => {
  assert.equal(admin.includes('data.notifications.pending'), false);
  // 逐字段兜底：老后端不返回 cancelled 时，面板显示 0 而不是 undefined。
  assert.match(admin, /const queue = \{ pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, \.\.\.\(data\?\.notifications \?\? \{\}\) \};/);
  assert.match(admin, /const failures = data\?\.failures \?\? \[\];/);
});
test('账户页可自助绑定或解绑邮箱，按服务端规范回显并即时更新本地资料', () => {
  assert.ok(main.includes('<h2>邮箱提醒</h2>'));
  assert.match(main, /apiRequest\('bind_email', \{ email: value \}\)/);
  assert.match(main, /const stored = value \? normalizeEmail\(value\) : '';/);
  assert.match(main, /onProfileUpdate\(\{ email: stored \|\| null \}\)/);
  assert.match(main, /已清除邮箱，将不再收到邮件提醒/);
  assert.match(main, /系统不验证邮箱归属/);
  assert.match(main, /import \{ normalizeEmail, validateEmail \} from '\.\/notify-rules\.js';/);
});
test('账户入口不再只叫修改密码', () => {
  assert.match(main, /onClick=\{\(\) => open\('account'\)\}>账户设置<\/button>/);
  assert.match(main, /<h2>修改密码<\/h2>/);
});
test('新表和新函数延续最小权限：RLS 加 service_role 专属执行', () => {
  assert.match(migration, /alter table public\.notifications enable row level security/);
  assert.match(migration, /revoke all on table public\.notifications from public, anon, authenticated/);
  for (const fn of ['app_bind_email(uuid, uuid, text)', 'app_update_email_notify(uuid, boolean, text[])', 'app_claim_notifications(uuid, integer, integer, integer, integer)', 'app_notify_verify_rows(uuid, bigint[])', 'app_reset_failed_notifications(uuid)']) {
    assert.ok(migration.includes(`revoke all on function public.${fn} from public, anon, authenticated;`));
    assert.ok(migration.includes(`grant execute on function public.${fn} to service_role;`));
  }
  assert.match(migration, /revoke all on function private\.enqueue_email_notification\(\) from public, anon, authenticated/);
  assert.match(cron, /revoke all on function public\.app_register_email_cron\(\) from public, anon, authenticated;/);
  assert.match(cron, /grant execute on function public\.app_register_email_cron\(\) to service_role;/);
});
test('迁移行为验证真的驱动状态变化，而不是只看对象是否存在', () => {
  for (const needed of [
    'insert into public.applications(owner_id, title, purpose, amount, category, department, use_date, status, version)',
    "update public.applications set status = 'finance_pending', version = 1 where id = app_id;",
    '待财委审批的收件人应恰好是财委与内置 admin',
    '待主席审批的收件人应恰好是主席与内置 admin',
    'public.app_claim_notifications(claim_1, 200, 300, 24, 5)',
    '已领取的行必须处于发送中',
    '领取必须带上未过期的租约',
    '同一封邮件不应被两个批次领取',
    'public.app_reset_failed_notifications(super_id)',
    '移除收款码应作废本轮的待付款登记提醒',
    '重新提交收款码后应再次入队',
    '替别人绑定邮箱应被拒绝',
    'public.app_notify_verify_rows(claim_1, array[blocked_row])',
    '领取后撤销身份的行应被投递前复核判为 cancel',
    '不存在的 id 不应出现在复核结果里（缺席不是放行）',
    '缺少批次号时不应放行任何行',
    '关闭类型后已积压的该类提醒应作废',
    '打开结果通知后，拒绝申请应提醒申请人本人',
    '无身份成员不应收到任何提醒',
    '投递前复核只应针对正在发送的行',
    '超龄 sending 行恢复丢弃时应计入 discarded',
    '普通成员不应能修改提醒设置',
  ]) assert.ok(verify.includes(needed), `验证脚本缺少：${needed}`);
  // 这两条曾经是恒真断言（拿第二批返回的 id 去比第一批的 claim_id）；现在改成比较两批的 id 交集。
  assert.match(verify, /intersect\s+select unnest\(claim_1_ids\)/);
  assert.equal(/claim_id = claim_1 and id in \(\s*select \(element->>'id'\)::bigint from jsonb_array_elements/.test(verify), false, '不允许再写恒真的双批次断言');
  assert.equal(/\binsert into public\.notifications\b/.test(verify), false, '队列记录必须由触发器产生，验证不能自己插行');
});
