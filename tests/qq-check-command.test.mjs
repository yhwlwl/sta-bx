import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { createSqlStack, rootPath } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';

let instance = 0;

// qq-bot 这个函数只在 Deno 里跑（Deno.serve / npm: 说明符），测试时把这两处换成替身，
// 其余代码原样编译执行 —— 验签和指令解析都是纯函数，值得真的跑一遍而不是照抄一份。
async function loadQqBot(admin = null) {
  let source = readFileSync(rootPath('supabase/functions/qq-bot/index.ts'), 'utf8');
  const importLine = /^import \{ createClient \} from 'npm:@supabase\/supabase-js@2'$/m;
  assert.ok(importLine.test(source), 'qq-bot 的 supabase-js 引入方式变了，请同步更新测试替身');
  // admin 由测试注入，这样能断言指令路由有没有打到对应的 RPC
  globalThis.__fakeAdmin = () => admin ?? { from: () => ({}), rpc: async () => ({ data: null }) };
  source = source.replace(importLine, 'const createClient = () => globalThis.__fakeAdmin();');
  globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
  const compiled = await transform(source, { loader: 'ts', format: 'esm' });
  // 加个 fragment 让每次都是全新模块：admin 在模块顶层创建，缓存会拿错替身
  const url = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}#${++instance}`;
  return import(url);
}

test('Ed25519 签名与 QQ 官方测试向量一致', async () => {
  const { botSeed, signHex, verifySignature, parseCommand } = await loadQqBot();
  const decoder = new TextDecoder();

  // 文档示例：secret 28 字节 → seed 补齐到 32 字节
  assert.equal(decoder.decode(botSeed('naOC0ocQE3shWLAfffVLB1rhYPG7')), 'naOC0ocQE3shWLAfffVLB1rhYPG7naOC');
  // secret 16 字节 → 反复自我拼接
  assert.equal(decoder.decode(botSeed('DG5g3B4j9X2KOErG')), 'DG5g3B4j9X2KOErGDG5g3B4j9X2KOErG');

  // 官方「回调地址验证」示例：plain_token + event_ts 的签名必须逐字节一致
  assert.equal(
    await signHex('DG5g3B4j9X2KOErG', '1725442341' + 'Arq0D5A61EgUu4OxUvOp'),
    '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  );

  // 请求签名与验证
  const secret = 'naOC0ocQE3shWLAfffVLB1rhYPG7';
  const body = '{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}';
  const good = await signHex(secret, '1725442341' + body);
  assert.equal(await verifySignature(secret, '1725442341', body, good), true);
  assert.equal(await verifySignature(secret, '1725442341', body + ' ', good), false);
  assert.equal(await verifySignature(secret, '1725442342', body, good), false);
  assert.equal(await verifySignature('other-secret', '1725442341', body, good), false);
  assert.equal(await verifySignature(secret, '', body, good), false);
  assert.equal(await verifySignature(secret, '1725442341', body, 'zzzz'), false);

  // 指令解析：前后空格、大小写、全角斜杠、多余空格都要归一
  assert.equal(parseCommand(' /check'), 'check');
  assert.equal(parseCommand('/CHECK'), 'check');
  assert.equal(parseCommand('／check'), 'check');
  assert.equal(parseCommand('/check   resend'), 'check resend');
  assert.equal(parseCommand('  /check\tresend  '), 'check resend');
  assert.equal(parseCommand('你好'), '你好');
});

test('/check 待办汇总与 /check resend 补发', { timeout: 120000 }, async () => {
  const { db } = await createSqlStack();
  const admin = createSqlClient(db);
  const rpc = async (name, args) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const { rows: [{ id: actor }] } = await db.query("select id from public.app_users where username='admin'");
  const { rows: [{ id: owner }] } = await db.query(
    "select (private.app_insert_user('check_user','Only-for-tests-7712','检查用户','测试')->>'id')::uuid id",
  );
  // 真的财委成员：汇总里的「负责人」取自角色映射，超管会被过滤掉，所以必须另建一个
  await db.query(
    "select private.app_insert_user('check_fin','Only-for-tests-9911','财委甲','财务委员会')",
  );
  await db.query(
    "select public.app_set_member_roles($1::uuid,(select id from public.app_users where username='check_fin'),array['finance'],true)",
    [actor],
  );
  const group = 'AABBCCDDEEFF00112233445566778899';
  await rpc('app_update_qq_notify', {
    p_actor_id: actor, p_enabled: true, p_group_openid: group,
    p_events: ['待财委审批', '待主席审批', '待补充收款码'],
  });

  // 没有待办时要说清楚，而不是发一堆空标题
  assert.match(await rpc('app_qq_check_report', {}), /没有待处理事项/);

  const { rows: [{ id: appId }] } = await db.query(
    "insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version) values ($1,'活动物资','测试',45,'物资','财务委员会',current_date,'draft',1) returning id",
    [owner],
  );
  await db.query("update public.applications set status='finance_pending' where id=$1", [appId]);

  const report = await rpc('app_qq_check_report', {});
  assert.match(report, /^【待办检查】\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(report, /共 1 条待处理/);
  assert.match(report, /待财委审批 1 条/);
  assert.match(report, /活动物资 ¥45\.00 · 检查用户/);
  assert.match(report, /已等 \d+ 天/);
  assert.match(report, /（财委甲）/); // 负责人取自真实角色映射，且不含超级管理员
  assert.ok(!report.includes('超级管理员'), '超管应被过滤掉');

  // 模拟"状态该提醒、却从没进过队列"的漏发（例如当时机器人没开）：
  // 删掉触发器写入的那条，再让 /check resend 补回来
  await db.query('delete from public.qq_notifications where application_id=$1', [appId]);

  const first = await rpc('app_qq_resend', {});
  assert.equal(first.ok, true);
  assert.equal(first.enqueued, 1);
  assert.equal(first.pending, 1);

  // 再补发一次不能重复入队（判重索引兜底）
  const second = await rpc('app_qq_resend', {});
  assert.equal(second.enqueued, 0);
  assert.equal(second.pending, 1, '重复执行不应放大队列');

  // 投递失败的行可以被恢复重排
  await db.query("update public.qq_notifications set status='failed' where application_id=$1", [appId]);
  const third = await rpc('app_qq_resend', {});
  assert.equal(third.failed, 1);
  assert.equal(third.pending, 1);

  // 关掉开关后补发要有明确原因，不能静默成功
  await rpc('app_update_qq_notify', { p_actor_id: actor, p_enabled: false, p_group_openid: group, p_events: [] });
  const off = await rpc('app_qq_resend', {});
  assert.equal(off.ok, false);
  assert.match(off.reason, /未开启/);

  // 指令群白名单：提醒群之外，还允许在别的群用 /check
  const save = (groups) => rpc('app_update_qq_command_groups', { p_actor_id: actor, p_groups: groups });
  const stored = async () => (await db.query('select qq_command_groups from public.settings where id=1')).rows[0].qq_command_groups;

  assert.deepEqual(await stored(), [], '默认没有额外指令群');
  await save(['ACE5A6F82F1859574D66FFD79D86FC6C', 'ACE5A6F82F1859574D66FFD79D86FC6C']);
  assert.deepEqual(await stored(), ['ACE5A6F82F1859574D66FFD79D86FC6C'], '重复项应去重');

  // 填错格式会让群里永远静默无响应，所以必须在这里就报错
  await assert.rejects(() => save(['123456']), /格式不正确/);
  await assert.rejects(() => save(['短了']), /格式不正确/);
  await assert.rejects(() => save(Array.from({ length: 11 }, (_, i) => `AAAAAAAABBBBBBBB${i}`)), /最多 10 个/);
  await assert.rejects(
    () => rpc('app_update_qq_command_groups', { p_actor_id: owner, p_groups: [] }),
    /没有管理员权限/,
  );

  // 清空白名单后只剩提醒群
  await save([]);
  assert.deepEqual(await stored(), []);

  // /stat：数字要和后台对得上（待处理 1 笔，本月还没有打款）
  const stat = await rpc('app_qq_stat', {});
  assert.match(stat, /^【本月概况】\d{4}-\d{2}/);
  assert.match(stat, /待处理 1 笔 · ¥45\.00/);
  assert.match(stat, /本月已付款 0 笔 · ¥0\.00/);
  assert.match(stat, /本月新提交 1 笔/);

  // /search：标题、申请人名都能命中，空关键字和通配符不能把全库翻出来
  assert.match(await rpc('app_qq_search', { p_keyword: '活动' }), /共 1 条[\s\S]*活动物资 ¥45\.00 · 检查用户 · 待财委审批/);
  assert.match(await rpc('app_qq_search', { p_keyword: '检查用户' }), /共 1 条/);
  assert.match(await rpc('app_qq_search', { p_keyword: '不存在的' }), /没有找到/);
  assert.match(await rpc('app_qq_search', { p_keyword: '  ' }), /请写成|请在后面加关键字/);
  assert.match(await rpc('app_qq_search', { p_keyword: '%' }), /没有找到/, '通配符必须被转义');

  // /status：一眼看出机器人活着没有、队列堵没堵
  const status = await rpc('app_qq_status', {});
  assert.match(status, /^【运行状态】\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(status, /QQ 提醒：已关闭（允许指令的群 1 个）/);
  assert.match(status, /QQ 队列：待发 \d+ · 发送中 0 · 失败 0/);
  assert.match(status, /待处理申请：1 笔/);
  assert.match(status, /最近一次群消息：从未/);
});

test('指令路由：每个指令都打到对应的 RPC', async () => {
  const calls = [];
  const fake = {
    from: () => ({}),
    rpc: async (name, args) => {
      calls.push([name, args ?? {}]);
      if (name === 'app_qq_resend') return { data: { ok: true, enqueued: 2, failed: 1, pending: 3 } };
      return { data: `R:${name}` };
    },
  };
  const { runCommand } = await loadQqBot(fake);
  const last = () => calls[calls.length - 1];

  assert.match(await runCommand(''), /\/check/, '空指令给帮助');
  assert.match(await runCommand('help'), /\/status/);
  assert.match(await runCommand('帮助'), /\/search/);

  assert.equal(await runCommand('check'), 'R:app_qq_check_report');
  assert.equal(await runCommand('检查'), 'R:app_qq_check_report');

  assert.equal(await runCommand('stat'), 'R:app_qq_stat');
  assert.equal(await runCommand('统计'), 'R:app_qq_stat');

  assert.equal(await runCommand('search 活动物资'), 'R:app_qq_search');
  assert.deepEqual(last(), ['app_qq_search', { p_keyword: '活动物资' }], '关键字原样传给 SQL');

  assert.equal(await runCommand('status'), 'R:app_qq_status');
  assert.equal(await runCommand('状态'), 'R:app_qq_status');

  const before = calls.length;
  assert.match(await runCommand('search'), /请写成 \/search/);
  assert.equal(calls.length, before, '没给关键字就不该查库');

  assert.match(await runCommand('随便打点什么'), /没有这个指令/);

  assert.match(await runCommand('check 补发'), /新排队 2 条，恢复失败 1 条，当前待发 3 条/);

  // RPC 报错要变成一句人话，而不是把堆栈甩到群里
  const failing = { from: () => ({}), rpc: async () => ({ error: { message: 'boom' } }) };
  const { runCommand: failingRun } = await loadQqBot(failing);
  await assert.rejects(() => failingRun('stat'), /app_qq_stat: boom/);
});
