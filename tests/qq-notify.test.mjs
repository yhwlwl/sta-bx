import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { createSqlStack, rootPath } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';

// 跑真实消费代码和真实 PostgreSQL RPC；仅 QQ HTTP 使用替身。
test('QQ 独立队列、并发领取、复核、API错误、限频和发送记账', { timeout: 120000 }, async () => {
  const { db } = await createSqlStack();
  const originalFetch = globalThis.fetch;
  try {
    const admin = createSqlClient(db);
    const rpc = async (name, args) => { const r = await admin.rpc(name, args); if (r.error) throw new Error(r.error.message); return r.data; };
    const audit = async (actor_id, event, detail) => { const r = await admin.from('audit_logs').insert({ actor_id, event, detail }); if (r.error) throw new Error(r.error.message); };
    const env = { QQ_BOT_APP_ID: 'test-app', QQ_BOT_APP_SECRET: 'secret-value', APP_URL: 'https://example.com' };
    const source = readFileSync(rootPath('supabase/functions/app-api/index.ts'), 'utf8');
    const fragment = source.slice(source.indexOf('  const drainQqNotifications ='), source.indexOf("  if (action === 'public_settings')"));
    const compiled = await transform('function makeDrain() {\n' + fragment + '\nreturn drainQqNotifications;\n}', { loader: 'ts', format: 'esm' });
    const drain = new Function('admin', 'rpc', 'audit', 'Deno', 'HttpError', compiled.code + '\nreturn makeDrain();')(admin, rpc, audit, { env: { get: (k) => env[k] } }, Error);
    const { rows: [{ id: actor }] } = await db.query("select id from public.app_users where username='admin'");
    const { rows: [{ id: owner }] } = await db.query("select (private.app_insert_user('qq_user','Test-only-1369666','隐私姓名','测试')->>'id')::uuid id");
    const group = 'AABBCCDDEEFF00112233445566778899';
    await rpc('app_update_qq_notify', { p_actor_id: actor, p_enabled: true, p_group_openid: group, p_events: ['待财委审批', '待主席审批'] });
    const configure = (enabled, target = group, events = ['待财委审批', '待主席审批']) => rpc('app_update_qq_notify', { p_actor_id: actor, p_enabled: enabled, p_group_openid: target, p_events: events });
    assert.equal((await admin.rpc('app_update_qq_notify', { p_actor_id: owner, p_enabled: true, p_group_openid: group, p_events: [] })).error != null, true);
    const app = async () => {
      const { rows: [{ id }] } = await db.query("insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version) values ($1,'私密标题','测试',10,'物资','测试',current_date,'draft',1) returning id", [owner]);
      await db.query("update public.applications set status='finance_pending' where id=$1", [id]);
      return id;
    };
    const id = await app();
    assert.equal((await db.query('select count(*)::int n from public.notifications')).rows[0].n, 0, '没有邮箱也会生成QQ提醒');
    const claim = crypto.randomUUID();
    const claimed = await rpc('app_claim_qq_notifications', { p_claim_id: claim });
    assert.equal(claimed.length, 1);
    assert.equal((await rpc('app_claim_qq_notifications', { p_claim_id: crypto.randomUUID() })).length, 0);
    await db.query("update public.applications set status='chair_pending' where id=$1", [id]);
    assert.equal(await rpc('app_verify_qq_notification', { p_id: claimed[0].id, p_claim_id: claim }), false);
    let calls = [];
    let mode = 'success';
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('getAppAccessToken')) return Response.json({ access_token: 'token', expires_in: 7200 });
      if (mode === 'businessError') return Response.json({ code: 40034105 });
      if (mode === 'throttle') return Response.json({ code: 429 }, { status: 429 });
      if (mode === 'timeout') throw new Error('secret-value');
      return Response.json({ id: 'message-id' });
    };
    assert.equal((await drain(actor)).sent, 1);
    const message = calls.find((c) => c.url.includes('/messages'));
    assert.equal(message.url, `https://api.bot.qq.com/v2/groups/${group}/messages`);
    assert.equal(message.options.headers.authorization, 'QQBot token');
    const payload = JSON.parse(message.options.body);
    assert.equal(payload.msg_type, 0);
    assert.equal('msg_id' in payload, false);
    // 旧契约是"群里只发提醒类型，不暴露申请内容"；20261007120000 起群消息改为带详情
    // （前提是目标群本身就是财委/主席的工作群），这里改为断言详情确实进去了。
    assert.ok(payload.content.includes('申请人：隐私姓名'), '群消息要写清是谁申请的');
    assert.ok(payload.content.includes('申请事项：私密标题'), '群消息要写清申请了什么');
    assert.ok(payload.content.includes('金额：¥10.00'), '金额按元保留两位小数');
    assert.ok(payload.content.includes('当前状态：待主席审批'), '当前状态用中文标签');
    assert.ok(payload.content.includes('https://example.com'), 'APP_URL 仍然附在末尾');
    assert.equal((await drain(actor)).sent, 0, '已发送不重复领取');
    await app(); mode = 'businessError';
    assert.equal((await drain(actor)).retried, 1);
    let row = (await db.query("select * from public.qq_notifications where status='pending' order by id desc limit 1")).rows[0];
    assert.match(row.last_error, /40034105/); assert.equal(row.attempts, 1);
    await db.query("update public.qq_notifications set next_attempt_at=now() where status='pending'");
    mode = 'throttle'; assert.equal((await drain(actor)).retried, 1);
    row = (await db.query('select * from public.qq_notifications where id=$1', [row.id])).rows[0];
    assert.equal(row.attempts, 1, '429不消耗尝试次数');
    await db.query("update public.qq_notifications set next_attempt_at=now(),attempts=4 where status='pending'");
    mode = 'timeout'; assert.equal((await drain(actor)).failed, 1);
    row = (await db.query('select * from public.qq_notifications where id=$1', [row.id])).rows[0];
    assert.equal(row.status, 'failed'); assert.ok(!row.last_error.includes('secret-value'));
    assert.equal(await rpc('app_reset_qq_notifications', { p_actor_id: actor }), 1);
    await configure(true, group, ['待主席审批']);
    assert.equal((await db.query("select count(*)::int n from public.qq_notifications where status='pending'")).rows[0].n, 0, '取消类型作废积压');
    await configure(true);
    await app(); await configure(false);
    calls=[]; assert.equal((await drain(actor)).skipped, true); assert.equal(calls.length, 0);
    await configure(true, '11223344556677889900AABBCCDDEEFF');
    assert.equal((await db.query("select count(*)::int n from public.qq_notifications where status='pending'")).rows[0].n, 0, '换群作废积压');
    await app();
    await db.query("update public.qq_notifications set created_at=now()-interval '25 hours' where status='pending'");
    assert.equal((await rpc('app_claim_qq_notifications', { p_claim_id: crypto.randomUUID() })).length, 0);
    await app();
    const recoveryClaim = await rpc('app_claim_qq_notifications', { p_claim_id: crypto.randomUUID() });
    assert.equal(recoveryClaim.length, 1);
    await db.query("update public.qq_notifications set lease_expires_at=now()-interval '1 second',attempts=5 where id=$1", [recoveryClaim[0].id]);
    assert.equal((await rpc('app_claim_qq_notifications', { p_claim_id: crypto.randomUUID() })).length, 0);
    assert.equal((await db.query('select status from public.qq_notifications where id=$1', [recoveryClaim[0].id])).rows[0].status, 'failed');
    const grants = await db.query("select has_table_privilege('anon','public.qq_notifications','SELECT') allowed");
    assert.equal(grants.rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('anon','public.app_claim_qq_notifications(uuid)','EXECUTE') allowed")).rows[0].allowed, false);
    // 完整入口验证：cron 只接受原有消费动作；QQ认证故障不能阻止邮件消费。
    const originalDeno = globalThis.Deno;
    try {
      let handler;
      env.CRON_SECRET = 'test-cron';
      globalThis.__qqTestClient = () => admin;
      globalThis.Deno = { env: { get: (key) => env[key] ?? '' }, serve: (fn) => { handler = fn; } };
      const full = await transform(source.replace(/import \{ createClient \} from '[^']+'/, 'const createClient = globalThis.__qqTestClient;'), { loader: 'ts', format: 'esm' });
      await import('data:text/javascript;base64,' + Buffer.from(full.code).toString('base64'));
      const request = async (action, headers = {}, fields = {}) => {
        const response = await handler(new Request('https://test.invalid', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...fields }) }));
        return { status: response.status, ...(await response.json()) };
      };
      assert.equal((await request('send_qq_notifications', { 'x-app-cron': 'test-cron' })).status, 401);
      assert.equal((await request('send_notifications', { 'x-app-cron': 'wrong' })).status, 401);
      const login = await request('login', {}, { username: 'qq_user', password: 'Test-only-1369666' });
      assert.equal(login.status, 200);
      assert.equal((await request('send_qq_notifications', { 'x-app-session': login.data.session.token })).status, 403);
      globalThis.fetch = async () => Response.json({ code: 12345 }, { status: 403 });
      const cron = await request('send_notifications', { 'x-app-cron': 'test-cron' });
      assert.equal(cron.status, 200); assert.equal(cron.data.skipped, true);
      assert.equal((await db.query("select count(*)::int n from public.audit_logs where event='发送QQ提醒失败'")).rows[0].n, 1);
    } finally { globalThis.Deno = originalDeno; delete globalThis.__qqTestClient; }

    // @ 负责人：登记 member_openid 后，消息首行变成 <qqbot-at-user/>，并在末尾列出负责人姓名。
    // 先把群固定回 group：上面的用例把目标群换成了别的值，绑定与解除都按"当前设置的群"生效。
    await configure(true, group);
    await db.query("insert into public.qq_member_bindings(group_openid,user_id,member_openid) values($1,$2,'MEMBEROPENID0000000000000000000001')", [group, owner]);
    const { rows: [{ c: mentioned }] } = await db.query("select private.qq_notify_content($1,'退回修改',$2,now()) c", [id, group]);
    assert.match(mentioned, /^<qqbot-at-user id="MEMBEROPENID0000000000000000000001" \/> 退回修改/);
    assert.match(mentioned, /负责人：隐私姓名/);
    // 没登记的成员不会让消息变成空白：退回"负责人：待确认"或列出姓名，但绝不能没有正文。
    const { rows: [{ c: unbound }] } = await db.query("select private.qq_notify_content($1,'待财委审批',$2,now()) c", [id, 'FFEEDDCCBBAA00998877665544332211']);
    assert.ok(unbound.startsWith('【财务报销平台】待财委审批'));
    assert.ok(unbound.includes('申请事项：私密标题'));
    // 重复绑定同一个 openid 给另一个人时，旧绑定必须被摘掉（否则会 @ 错对象）。
    const { rows: [{ id: other }] } = await db.query("select (private.app_insert_user('qq_other','Test-only-1369666','另一位','测试')->>'id')::uuid id");
    await rpc('app_set_qq_binding', { p_actor_id: actor, p_username: 'qq_other', p_member_openid: 'MEMBEROPENID0000000000000000000001' });
    assert.equal((await db.query('select count(*)::int n from public.qq_member_bindings where group_openid=$1', [group])).rows[0].n, 1);
    await rpc('app_delete_qq_binding', { p_actor_id: actor, p_username: 'qq_other' });
    assert.equal((await db.query('select count(*)::int n from public.qq_member_bindings where group_openid=$1', [group])).rows[0].n, 0);
    // 非管理员不能改绑定。
    assert.equal((await admin.rpc('app_set_qq_binding', { p_actor_id: other, p_username: 'qq_user', p_member_openid: 'MEMBEROPENID0000000000000000000002' })).error != null, true);

  } finally { globalThis.fetch = originalFetch; await db.close(); }
});
