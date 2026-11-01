import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { filterPublicRecords, summarizePublicRecords } from '../src/public-report.js';

let hookCursor = 0;
let hookValues = [];
globalThis.__publicReportReact = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
    return [hookValues[index], (next) => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next; }];
  },
  useEffect() {},
  useMemo(factory) { return factory(); },
};
globalThis.__publicReportApi = async () => ({ data: { enabled: true, records: [] }, error: null });
globalThis.__publicReportHelpers = { filterPublicRecords, summarizePublicRecords };
const componentSource = readFileSync('src/public-report.jsx', 'utf8')
  .replace(/import React, \{[^}]+\} from 'react';\r?\n/, 'const React = globalThis.__publicReportReact; const { useEffect, useMemo, useState } = React;\n')
  .replace(/import \{ apiRequest \} from '.\/api.js';\r?\n/, 'const { apiRequest } = globalThis.__publicReportApiModule;\n')
  .replace(/import \{ filterPublicRecords, summarizePublicRecords \} from '.\/public-report.js';\r?\n/, 'const { filterPublicRecords, summarizePublicRecords } = globalThis.__publicReportHelpers;\n');
globalThis.__publicReportApiModule = { apiRequest: globalThis.__publicReportApi };
const { code: componentCode } = await transform(componentSource, { loader: 'jsx', format: 'esm' });
const { PublicReport } = await import(`data:text/javascript;base64,${Buffer.from(componentCode).toString('base64')}`);

function findElements(tree, predicate, found = []) {
  if (Array.isArray(tree)) { for (const child of tree) findElements(child, predicate, found); return found; }
  if (!tree || typeof tree !== 'object') return found;
  if (tree.type && tree.props) {
    if (predicate(tree)) found.push(tree);
    findElements(tree.props.children, predicate, found);
  }
  return found;
}

function renderPublicReport() { hookCursor = 0; return PublicReport(); }

let handler;
let actorRoles = ['admin'];
let rpcResult = { enabled: true, records: [] };
const rpcCalls = [];
const tablesRead = [];
globalThis.Deno = {
  env: { get: () => '' },
  serve: (value) => { handler = value; },
};
globalThis.__publicReportClient = () => ({
  from(table) {
    tablesRead.push(table);
    const data = table === 'app_sessions' ? { user_id: 'actor', expires_at: '2099-01-01T00:00:00Z' }
      : table === 'app_users' ? { id: 'actor', username: 'manager', active: true }
        : table === 'user_roles' ? actorRoles.map((role) => ({ role })) : null;
    const query = { then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); } };
    for (const method of ['select', 'eq', 'maybeSingle', 'single', 'update', 'insert', 'delete', 'order', 'range', 'limit', 'in']) {
      query[method] = () => method === 'maybeSingle' || method === 'single' ? Promise.resolve({ data, error: null }) : query;
    }
    return query;
  },
  async rpc(name, args) { rpcCalls.push({ name, args }); return { data: rpcResult, error: null }; },
});

const source = readFileSync('supabase/functions/app-api/index.ts', 'utf8')
  .replace(/import \{ createClient \} from '[^']+'\r?\n/, 'const createClient = globalThis.__publicReportClient;\n');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { readPublicReportDates, projectPublicFinancialRecords } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

async function request(body, session = '') {
  const headers = { 'content-type': 'application/json' };
  if (session) headers['x-app-session'] = session;
  const response = await handler(new Request('https://test.invalid', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: response.status, ...(await response.json()) };
}

test('公开财报日期必须完整、有效、有序且不超过五年', () => {
  assert.deepEqual(readPublicReportDates({ start: '2026-10-01', end: '2026-10-31' }), { start: '2026-10-01', end: '2026-10-31' });
  for (const body of [{ start: '', end: '2026-10-31' }, { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-11-01', end: '2026-10-31' }, { start: '2020-01-01', end: '2026-01-01' }]) {
    assert.throws(() => readPublicReportDates(body));
  }
});

test('公开 API 无需会话，并只通过受限 RPC 取得记录', async () => {
  rpcCalls.length = 0; tablesRead.length = 0;
  rpcResult = { enabled: true, records: [{ payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组', applicant_name: '张三', purpose: 'private', owner_id: 'secret', username: 'private-user' }] };
  const result = await request({ action: 'public_financial_report', start: '2026-10-02', end: '2026-10-31' });
  assert.equal(result.status, 200);
  assert.deepEqual(rpcCalls[0], { name: 'app_public_financial_report', args: { p_start: '2026-10-02', p_end: '2026-10-31' } });
  assert.deepEqual(result.data, { enabled: true, records: [{ payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组', applicant_name: '张三' }] });
  assert.deepEqual(tablesRead, []); // public request does not resolve a user or query business tables
});

test('公开关闭时 API 清空记录；无效日期不会发起 RPC', async () => {
  rpcCalls.length = 0; tablesRead.length = 0;
  rpcResult = { enabled: false, records: [] };
  const closed = await request({ action: 'public_financial_report', start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(closed.data, { enabled: false, records: [] });
  assert.equal((await request({ action: 'public_financial_report', start: '2026-02-30', end: '2026-03-01' })).status, 400);
  assert.equal(rpcCalls.length, 1);
});

test('公开 RPC 投影只允许姓名白名单并剔除用户标识等额外字段', () => {
  assert.deepEqual(projectPublicFinancialRecords([{ payment_date: '2026-10-02', amount: '12.34', category: '材料', department: '活动组', applicant_name: '张三', actor_id: 'hidden', username: 'hidden', email: 'hidden' }]), [
    { payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组', applicant_name: '张三' },
  ]);
  const emojiName = '😀'.repeat(41);
  assert.equal(projectPublicFinancialRecords([{ payment_date: '2026-10-01', amount: 1, category: 'x', department: 'y', applicant_name: emojiName }])[0].applicant_name, emojiName);
  for (const records of [[{ payment_date: '2026-02-30', amount: 1, category: 'x', department: 'y', applicant_name: '' }], [{ payment_date: '2026-10-01', amount: -1, category: 'x', department: 'y', applicant_name: '' }], [{ payment_date: '2026-10-01', amount: 1, category: 'x', department: 'y' }], [{ payment_date: '2026-10-01', amount: 1, category: 'x', department: 'y', applicant_name: 42 }], [{ payment_date: '2026-10-01', amount: 1, category: 'x', department: 'y', applicant_name: '张'.repeat(81) }], [{ payment_date: '2026-10-01', amount: 1, category: 'x', department: 'y', applicant_name: '😀'.repeat(81) }], Array(5001).fill({})]) {
    assert.throws(() => projectPublicFinancialRecords(records));
  }
});

test('公开明细显示申请人姓名并按 React 文本渲染', () => {
  hookValues = [
    { start: '2026-10-01', end: '2026-10-31' }, 'month',
    [{ payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组', applicant_name: '张三 <测试>' }],
    true, false, '', '', '',
  ];
  const tree = renderPublicReport();
  const text = [];
  const collect = (node) => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
    if (node && typeof node === 'object') collect(node.props?.children);
  };
  collect(tree);
  assert.ok(text.includes('报销人'));
  assert.ok(text.includes('张三 <测试>'));
  assert.ok(text.join(' ').includes('资料更新后历史记录中的姓名也会更新'));
});

test('管理员开关经过会话和角色校验后才调用数据库 RPC', async () => {
  rpcCalls.length = 0; tablesRead.length = 0; actorRoles = ['admin'];
  assert.equal((await request({ action: 'update_public_financial_report', enabled: true }, 'session')).status, 200);
  assert.deepEqual(rpcCalls[0], { name: 'app_update_public_financial_report', args: { p_actor_id: 'actor', p_enabled: true } });
  rpcCalls.length = 0; actorRoles = [];
  assert.equal((await request({ action: 'update_public_financial_report', enabled: true }, 'session')).status, 403);
  assert.equal(rpcCalls.length, 0);
});

test('组合筛选后的统计来自同一组付款记录，金额以分汇总且空集为零', () => {
  const records = [
    { payment_date: '2026-10-02', amount: 10.01, category: '材料', department: '活动组' },
    { payment_date: '2026-10-20', amount: 0.02, category: '材料', department: '活动组' },
    { payment_date: '2026-11-01', amount: 20, category: '交通', department: '活动组' },
  ];
  const filtered = filterPublicRecords(records, { category: '材料', department: '活动组' });
  assert.equal(filtered.length, 2);
  assert.deepEqual(summarizePublicRecords(filtered), {
    totalCents: 1003, count: 2, averageCents: 502,
    months: [{ month: '2026-10', count: 2, totalCents: 1003 }],
    categories: [{ category: '材料', count: 2, totalCents: 1003 }],
  });
  assert.deepEqual(summarizePublicRecords([]), { totalCents: 0, count: 0, averageCents: 0, months: [], categories: [] });
});

test('切换到自定义日期保留当前范围，日期预设范围也可再切回自定义', () => {
  hookValues = [];
  const initialTree = renderPublicReport();
  const selects = findElements(initialTree, (element) => element.type === 'select' && typeof element.props.onChange === 'function');
  const dateInputs = findElements(initialTree, (element) => element.type === 'input' && element.props.type === 'date');
  const initialDates = dateInputs.map((input) => input.props.value);
  assert.equal(selects.length, 3); // 时间、类别、部门

  selects[0].props.onChange({ target: { value: 'custom' } });
  let tree = renderPublicReport();
  let currentDateInputs = findElements(tree, (element) => element.type === 'input' && element.props.type === 'date');
  assert.deepEqual(currentDateInputs.map((input) => input.props.value), initialDates);
  assert.equal(findElements(tree, (element) => element.type === 'select')[0].props.value, 'custom');

  const springValue = `spring:${new Date().getFullYear()}`;
  findElements(tree, (element) => element.type === 'select')[0].props.onChange({ target: { value: springValue } });
  tree = renderPublicReport();
  currentDateInputs = findElements(tree, (element) => element.type === 'input' && element.props.type === 'date');
  const semesterDates = currentDateInputs.map((input) => input.props.value);
  assert.deepEqual(semesterDates, [`${new Date().getFullYear()}-02-01`, `${new Date().getFullYear()}-07-31`]);

  findElements(tree, (element) => element.type === 'select')[0].props.onChange({ target: { value: 'custom' } });
  tree = renderPublicReport();
  currentDateInputs = findElements(tree, (element) => element.type === 'input' && element.props.type === 'date');
  assert.deepEqual(currentDateInputs.map((input) => input.props.value), semesterDates);
});
