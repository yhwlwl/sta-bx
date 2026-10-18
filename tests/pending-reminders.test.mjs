import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createSqlStack, rootPath, SQL_STACK_TIMEOUT } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';
import {
  PENDING_BUCKETS, PENDING_BUCKET_KEYS, visibleBucketKeys, summarizePending, pendingItemsOf,
} from '../src/pending-rules.js';

const readSource = (relative) => readFile(rootPath(relative), 'utf8');

test('待办规则：身份决定可见分组，普通管理员不因 admin 角色获得流程待办', () => {
  const member = { profile: { id: 'u1', username: 'member' }, roles: [] };
  const finance = { profile: { id: 'u2', username: 'finance' }, roles: ['finance'] };
  const chair = { profile: { id: 'u3', username: 'chair' }, roles: ['chair'] };
  const opsAdmin = { profile: { id: 'u4', username: 'ops' }, roles: ['admin'] };
  const superAdmin = { profile: { id: 'u5', username: 'admin' }, roles: ['admin'] };

  assert.deepEqual(visibleBucketKeys(member), ['returned', 'qr']);
  assert.deepEqual(visibleBucketKeys(finance), ['finance', 'payment', 'returned', 'qr'], '财委即付款登记能力');
  assert.deepEqual(visibleBucketKeys(chair), ['chair', 'returned', 'qr']);
  assert.deepEqual(visibleBucketKeys(opsAdmin), ['returned', 'qr'], '普通管理员不应获得流程待办');
  assert.deepEqual(visibleBucketKeys(superAdmin), PENDING_BUCKET_KEYS, '内置 admin 跨身份');
});

test('待办汇总：数量与列表同源，未读只统计服务端标记为未读的条目', () => {
  const items = [
    { bucket: 'finance', application_id: 'a1', unread: true },
    { bucket: 'finance', application_id: 'a2', unread: false },
    { bucket: 'payment', application_id: 'a3', unread: true },
    { bucket: 'qr', application_id: 'a4', unread: true },
  ];
  const summary = summarizePending(items);
  const stat = (key) => summary.buckets.find((bucket) => bucket.key === key);

  assert.equal(stat('finance').pending, 2);
  assert.equal(stat('finance').unread, 1);
  assert.equal(stat('payment').pending, 1);
  assert.equal(stat('chair').pending, 0, '没有待办的分组必须显示 0 而不是缺失');
  assert.equal(summary.unreadTeam, 2);
  assert.equal(summary.unreadMine, 1);
  assert.equal(summary.unreadTotal, 3);
  assert.equal(summary.total, items.length);
  const returned = { bucket: 'returned', application_id: 'a5', unread: false };
  assert.equal(summarizePending([...items, returned]).unreadMine, 1, '已读的本人待办不计入角标');

  // 角标数量与列表条数来自同一份数据：每个分组的 pending 必须等于该分组列表长度。
  for (const bucket of PENDING_BUCKETS) assert.equal(stat(bucket.key).pending, pendingItemsOf(items, bucket.key).length);
  assert.equal(pendingItemsOf(items, '').length, 4);
  assert.equal(summarizePending(null).total, 0);
  assert.equal(summarizePending(undefined).unreadTotal, 0);
});

test('待办契约：前端分组、SQL 状态映射、Edge 白名单三处逐项一致', async () => {
  const sql = await readSource('supabase/migrations/20261011120000_pending_reminders.sql');
  const api = await readSource('supabase/functions/app-api/index.ts');

  const mapping = [...sql.matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(mapping, PENDING_BUCKETS.map((bucket) => [bucket.status, bucket.key]), 'SQL 状态映射必须与前端 PENDING_BUCKETS 一致');
  for (const status of ['draft', 'rejected', 'paid', 'cancelled']) {
    assert.ok(!mapping.some(([mapped]) => mapped === status), `${status} 不应产生待办`);
  }

  const allow = api.match(/const PENDING_BUCKETS = \[([^\]]+)\]/);
  assert.ok(allow, 'app-api 必须声明 PENDING_BUCKETS 白名单');
  assert.deepEqual(
    allow[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')),
    PENDING_BUCKET_KEYS,
    'Edge 白名单必须与前端一致',
  );
  assert.match(api, /if \(action === 'list_pending'\)/);
  assert.match(api, /if \(action === 'mark_pending_seen'\)/);
  // 已读标记必须落在库里，服务端重启、换设备都不会把已读状态丢掉。
  assert.match(sql, /create table if not exists public\.pending_views/);
  assert.match(sql, /grant execute on function public\.app_list_pending\(uuid\) to service_role/);
  assert.match(sql, /grant execute on function public\.app_mark_pending_seen\(uuid, text\[\]\) to service_role/);
});

test('待办提醒：真实库按身份返回待办，已读随状态与版本变化失效', { timeout: SQL_STACK_TIMEOUT }, async () => {
  const { db } = await createSqlStack();
  const buildDir = rootPath('tests', '.tmp', 'pending-reminders');
  const savedDeno = globalThis.Deno;
  const savedClient = globalThis.__PENDING_CLIENT__;
  try {
    const client = createSqlClient(db);
    globalThis.__PENDING_CLIENT__ = client;
    let handler;
    globalThis.Deno = {
      env: { get: (key) => ({ SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test-key' })[key] ?? '' },
      serve: (fn) => { handler = fn; },
    };
    await mkdir(buildDir, { recursive: true });
    const stub = `${buildDir}/client.mjs`;
    await writeFile(stub, 'export function createClient() { return globalThis.__PENDING_CLIENT__; }');
    const source = (await readFile(rootPath('supabase/functions/app-api/index.ts'), 'utf8'))
      .replace("from 'npm:@supabase/supabase-js@2'", `from ${JSON.stringify(pathToFileURL(stub).href)}`);
    await writeFile(`${buildDir}/api.mjs`, (await transform(source, { loader: 'ts', format: 'esm' })).code);
    await import(pathToFileURL(`${buildDir}/api.mjs`).href);

    const call = async (token, action, args = {}) => {
      const response = await handler(new Request('http://localhost/functions/v1/app-api', {
        method: 'POST',
        headers: { 'x-app-session': token, 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
      }));
      return { status: response.status, ...(await response.json()) };
    };
    const signIn = async (name, password) => {
      const login = await call('', 'login', { username: name, password });
      assert.equal(login.status, 200, `${name} 应能登录：${JSON.stringify(login)}`);
      return login.data.session.token;
    };
    const addUser = async (name, role) => {
      const { rows } = await db.query("select (private.app_insert_user($1, 'Test-only-1369666', $1, '测试')->>'id')::uuid as id", [name]);
      if (role) await db.query('insert into public.user_roles(user_id,role) values ($1,$2)', [rows[0].id, role]);
      return { id: rows[0].id, token: await signIn(name, 'Test-only-1369666') };
    };
    const addApplication = async (ownerId, status) => {
      const { rows } = await db.query(
        "insert into public.applications(owner_id,title,purpose,amount,category,department,use_date,status,version,rule_threshold) values ($1,$2,'测试',50,'物资','测试',current_date,$3,1,100) returning id",
        [ownerId, `${status} 申请`, status],
      );
      return rows[0].id;
    };
    const idsOf = (items) => items.map((item) => item.application_id).sort();
    const bucketOf = (summary, key) => summary.buckets.find((bucket) => bucket.key === key);

    const finance = await addUser('pending_finance', 'finance');
    const chair = await addUser('pending_chair', 'chair');
    const opsAdmin = await addUser('pending_ops_admin', 'admin');
    const member = await addUser('pending_member');
    const superToken = await signIn('admin', 'Admin-only-1369666');

    const appFinance = await addApplication(member.id, 'finance_pending');
    const appChair = await addApplication(member.id, 'chair_pending');
    const appPayment = await addApplication(member.id, 'payment_pending');
    const appReturned = await addApplication(member.id, 'changes_requested');
    const appQr = await addApplication(member.id, 'payment_info_required');
    const appFinanceOwn = await addApplication(finance.id, 'finance_pending');
    const appPaymentOwn = await addApplication(finance.id, 'payment_pending');
    const appPaid = await addApplication(member.id, 'paid');

    // 财委：财委审批 + 付款登记两类；不能看到自己提交的待审申请，但能看到自己的待付款申请。
    const financeList = await call(finance.token, 'list_pending');
    assert.equal(financeList.status, 200);
    assert.deepEqual(idsOf(financeList.data), [appFinance, appPayment, appPaymentOwn].sort());
    assert.ok(financeList.data.every((item) => item.unread === true), '首次看到的待办都应未读');
    const financeSummary = summarizePending(financeList.data);
    assert.equal(bucketOf(financeSummary, 'finance').pending, pendingItemsOf(financeList.data, 'finance').length, '分组数量必须等于列表条数');
    assert.equal(bucketOf(financeSummary, 'finance').pending, 1);
    assert.equal(bucketOf(financeSummary, 'payment').pending, 2);
    assert.equal(financeSummary.unreadTeam, 3);
    assert.equal(financeSummary.unreadMine, 0);

    // 主席与申请人：各看各的。
    const chairList = await call(chair.token, 'list_pending');
    assert.deepEqual(idsOf(chairList.data), [appChair]);
    const memberList = await call(member.token, 'list_pending');
    assert.deepEqual(idsOf(memberList.data), [appReturned, appQr].sort(), '成员只看到自己名下的退回修改与待补充收款码');

    // 普通管理员只有 admin 身份：没有任何流程待办；内置超管跨身份看到全部审批待办。
    const opsList = await call(opsAdmin.token, 'list_pending');
    assert.deepEqual(opsList.data, [], '普通管理员不应看到无对应身份的审批操作');
    const superList = await call(superToken, 'list_pending');
    assert.deepEqual(idsOf(superList.data), [appFinance, appChair, appPayment, appFinanceOwn, appPaymentOwn].sort());

    // 进入列表后标记已查看：只影响自己看得到的待办，且不影响别人的未读状态。
    const seen = await call(finance.token, 'mark_pending_seen', { buckets: ['finance', 'payment'] });
    assert.equal(seen.status, 200);
    assert.equal(seen.data.marked, 3);
    const financeAfterSeen = await call(finance.token, 'list_pending');
    assert.equal(summarizePending(financeAfterSeen.data).unreadTeam, 0, '标记后角标应清零');
    assert.equal(summarizePending(financeAfterSeen.data).total, 3, '已读不等于已处理，待办本身还在');
    const superAfterSeen = await call(superToken, 'list_pending');
    assert.equal(summarizePending(superAfterSeen.data).unreadTeam, 5, '别人的已读标记不应影响超管');

    // 拿别人的待办类型来标记不会产生任何效果。
    const crossBucket = await call(member.token, 'mark_pending_seen', { buckets: ['finance'] });
    assert.equal(crossBucket.status, 200);
    assert.equal(crossBucket.data.marked, 0);
    const financeAfterCross = await call(finance.token, 'list_pending');
    assert.equal(summarizePending(financeAfterCross.data).unreadTeam, 0, '他人标记不应把财委的待办标成未读或已读');

    // 申请被处理：从待办里消失。
    await db.query("update public.applications set status='chair_pending' where id=$1", [appFinance]);
    const financeAfterFlow = await call(finance.token, 'list_pending');
    assert.deepEqual(idsOf(financeAfterFlow.data), [appPayment, appPaymentOwn].sort(), '流转走的申请应从财委待办中消失');
    const chairAfterFlow = await call(chair.token, 'list_pending');
    assert.deepEqual(idsOf(chairAfterFlow.data), [appChair, appFinance].sort());

    // 版本变化（退回后重新提交）：同一条申请再次提醒。
    await db.query('update public.applications set version = version + 1 where id=$1', [appChair]);
    const chairAfterResubmit = await call(chair.token, 'list_pending');
    assert.equal(summarizePending(chairAfterResubmit.data).unreadTeam, 2, '状态或版本变化后必须重新计为未读');
    await call(chair.token, 'mark_pending_seen', { buckets: ['chair'] });
    assert.equal(summarizePending((await call(chair.token, 'list_pending')).data).unreadTeam, 0);

    // 已付款等终态永远不进待办。
    assert.ok(!idsOf(financeAfterFlow.data).includes(appPaid));
    assert.deepEqual((await call(member.token, 'list_pending')).data.filter((item) => item.status === 'paid'), []);

    // 入参校验与停用账号。
    const invalid = await call(finance.token, 'mark_pending_seen', { buckets: ['unknown'] });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.error.message, '待办类型无效。');
    await db.query('update public.app_users set active=false where id=$1', [member.id]);
    assert.notEqual((await call(member.token, 'list_pending')).status, 200);
  } finally {
    globalThis.Deno = savedDeno;
    globalThis.__PENDING_CLIENT__ = savedClient;
    await db.close();
    await rm(buildDir, { recursive: true, force: true });
  }
});
