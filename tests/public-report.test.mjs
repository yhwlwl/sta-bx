import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { filterPublicRecords, summarizePublicRecords } from '../src/public-report.js';
import { buildPublicReportCsv, publicReportSnapshotKey } from '../src/public-report-export.js';

let hookCursor = 0;
let hookValues = [];
globalThis.__publicReportReact = {
  Fragment: 'fragment',
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
    return [hookValues[index], (next) => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next; }];
  },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useRef(initial) { const index = hookCursor++; if (!(index in hookValues)) hookValues[index] = { current: initial }; return hookValues[index]; },
};
let publicApiResult = { data: { enabled: true, records: [] }, error: null };
let publicApiRequest = async () => publicApiResult;
globalThis.__publicReportApi = (...args) => publicApiRequest(...args);
globalThis.__publicReportHelpers = { filterPublicRecords, summarizePublicRecords };
globalThis.__publicReportExportHelpers = { buildPublicReportCsv, publicReportSnapshotKey };
const componentSource = readFileSync('src/public-report.jsx', 'utf8')
  .replace(/import React, \{[^}]+\} from 'react';\r?\n/, 'const React = globalThis.__publicReportReact; const { useEffect, useMemo, useRef, useState } = React;\n')
  .replace(/import \{ apiRequest \} from '.\/api.js';\r?\n/, 'const { apiRequest } = globalThis.__publicReportApiModule;\n')
  .replace(/import \{ filterPublicRecords, summarizePublicRecords \} from '.\/public-report.js';\r?\n/, 'const { filterPublicRecords, summarizePublicRecords } = globalThis.__publicReportHelpers;\n')
  .replace(/import \{ buildPublicReportCsv, publicReportSnapshotKey \} from '.\/public-report-export.js';\r?\n/, 'const { buildPublicReportCsv, publicReportSnapshotKey } = globalThis.__publicReportExportHelpers;\n');
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
  rpcResult = { enabled: true, records: [{ payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组', purpose: 'private', owner_id: 'secret' }] };
  const result = await request({ action: 'public_financial_report', start: '2026-10-02', end: '2026-10-31' });
  assert.equal(result.status, 200);
  assert.deepEqual(rpcCalls[0], { name: 'app_public_financial_report', args: { p_start: '2026-10-02', p_end: '2026-10-31' } });
  assert.deepEqual(result.data, { enabled: true, records: [{ payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组' }] });
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

test('公开 RPC 投影校验并剔除额外字段与异常记录', () => {
  assert.deepEqual(projectPublicFinancialRecords([{ payment_date: '2026-10-02', amount: '12.34', category: '材料', department: '活动组', actor_id: 'hidden' }]), [
    { payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组' },
  ]);
  for (const records of [[{ payment_date: '2026-02-30', amount: 1, category: 'x', department: 'y' }], [{ payment_date: '2026-10-01', amount: -1, category: 'x', department: 'y' }], Array(5001).fill({})]) {
    assert.throws(() => projectPublicFinancialRecords(records));
  }
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

test('下载前重新确认开关与记录；公式文本被降级为文本且只导出筛选后的四个公开字段', async () => {
  const records = [
    { payment_date: '2026-10-02', amount: 12.34, category: '\t=1+1', department: '活动,"组"\n二组', purpose: 'private', owner_id: 'secret', actor_id: 'secret' },
    { payment_date: '2026-10-03', amount: 99, category: '交通', department: '其他组', purpose: 'private too', owner_id: 'another secret' },
  ];
  hookValues = [];
  hookValues[0] = { start: '2026-10-01', end: '2026-10-31' };
  hookValues[2] = records;
  hookValues[3] = true;
  hookValues[4] = false;
  hookValues[6] = records[0].category;
  hookValues[7] = records[0].department;
  let apiCalls = 0;
  publicApiRequest = async (action, payload) => { apiCalls += 1; assert.equal(action, 'public_financial_report'); assert.deepEqual(payload, { start: '2026-10-01', end: '2026-10-31' }); return { data: { enabled: true, records }, error: null }; };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;
  const downloaded = [];
  URL.createObjectURL = (blob) => { downloaded.push(blob); return 'blob:csv'; };
  URL.revokeObjectURL = () => {};
  globalThis.document = { createElement: () => ({ click() { downloaded.push(this); } }) };
  globalThis.window = { setTimeout, requestAnimationFrame: (callback) => callback(), print() { throw new Error('download must not print'); } };
  try {
    const tree = renderPublicReport();
    const button = findElements(tree, (element) => element.type === 'button' && element.props.children.includes('下载 CSV'))[0];
    assert.ok(button, JSON.stringify(findElements(tree, (element) => element.type === 'button').map((element) => element.props.children)));
    await button.props.onClick();
    assert.equal(apiCalls, 1);
    assert.equal(downloaded.length, 2, hookValues[9]);
    const anchor = downloaded[1];
    assert.equal(anchor.download, '财报_2026-10-01_2026-10-31.csv');
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await downloaded[0].arrayBuffer());
    assert.ok(csv.startsWith('\uFEFF'));
    assert.match(csv, /"统计周期","2026-10-01 至 2026-10-31"/);
    assert.match(csv, /"说明","仅含已付款记录"/);
    assert.match(csv, /"付款日期","费用类别","部门 \/ 活动","金额（元）"/);
    assert.ok(csv.includes('"\'\t=1+1"'));
    assert.ok(csv.includes('"活动,""组""\n二组"'));
    assert.ok(!csv.includes('交通') && !csv.includes('其他组'));
    assert.ok(!csv.includes('private') && !csv.includes('secret') && !csv.includes('purpose'));
    assert.deepEqual(publicReportSnapshotKey(records), publicReportSnapshotKey(records.map((record) => ({ ...record, purpose: 'another secret' }))));
  } finally {
    publicApiRequest = async () => publicApiResult;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    if (previousCreateObjectUrl) URL.createObjectURL = previousCreateObjectUrl; else delete URL.createObjectURL;
    if (previousRevokeObjectUrl) URL.revokeObjectURL = previousRevokeObjectUrl; else delete URL.revokeObjectURL;
  }
});

test('空周期生成有元数据和暂无数据行的 CSV；异常周期与用户公式拒绝或转义', () => {
  const csv = buildPublicReportCsv({ start: '2026-10-01', end: '2026-10-31', records: [], generatedAt: new Date('2026-10-31T00:00:00.000Z') });
  assert.match(csv, /"统计周期","2026-10-01 至 2026-10-31"/);
  assert.match(csv, /"生成时间（北京时间）"/);
  assert.match(csv, /"说明","仅含已付款记录"/);
  assert.match(csv, /"暂无数据","","",""/);
  assert.throws(() => buildPublicReportCsv({ start: '2026-02-30', end: '2026-03-01', records: [] }));
  const formulaCsv = buildPublicReportCsv({ start: '2026-10-01', end: '2026-10-31', category: '+cmd', department: '@SUM(A1)', records: [] });
  assert.match(formulaCsv, /"费用类别","'\+cmd"/);
  assert.match(formulaCsv, /"部门 \/ 活动","'@SUM\(A1\)"/);
});

test('关闭开关、请求失败、筛选竞态或数据变化时不下载', async () => {
  const row = { payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组' };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousCreateObjectUrl = URL.createObjectURL;
  const downloads = [];
  URL.createObjectURL = () => { downloads.push('blob'); return 'blob:csv'; };
  globalThis.document = { createElement: () => ({ click() { downloads.push('click'); } }) };
  globalThis.window = { setTimeout, requestAnimationFrame: (callback) => callback(), print() {} };
  const setup = () => {
    hookValues = [];
    hookValues[0] = { start: '2026-10-01', end: '2026-10-31' }; hookValues[2] = [row]; hookValues[3] = true; hookValues[4] = false;
    const tree = renderPublicReport();
    return findElements(tree, (element) => element.type === 'button' && element.props.children.includes('下载 CSV'))[0];
  };
  try {
    let button = setup();
    let apiCalls = 0;
    publicApiRequest = async () => { apiCalls += 1; return { data: { enabled: false, records: [] }, error: null }; };
    await button.props.onClick();
    assert.equal(downloads.length, 0);
    assert.equal(apiCalls, 1);

    button = setup();
    publicApiRequest = async () => { apiCalls += 1; return { data: null, error: { message: 'request failed' } }; };
    await button.props.onClick();
    assert.equal(downloads.length, 0);

    button = setup();
    let resolvePending;
    publicApiRequest = () => { apiCalls += 1; return new Promise((resolve) => { resolvePending = resolve; }); };
    const callsBeforeRace = apiCalls;
    const inFlight = button.props.onClick();
    await Promise.resolve();
    renderPublicReport();
    const second = button.props.onClick();
    hookValues[6] = '交通';
    renderPublicReport();
    resolvePending({ data: { enabled: true, records: [row] }, error: null });
    await Promise.all([inFlight, second]);
    assert.equal(downloads.length, 0);
    assert.equal(apiCalls, callsBeforeRace + 1);
    assert.equal(hookValues[2][0], row); // changed filters discard the pending response

    button = setup();
    let resolveClosed;
    publicApiRequest = () => new Promise((resolve) => { resolveClosed = resolve; });
    const closePending = button.props.onClick();
    hookValues[6] = '交通';
    renderPublicReport();
    resolveClosed({ data: { enabled: false, records: [] }, error: null });
    await closePending;
    assert.equal(hookValues[3], false); // a close response still disables the page after filters move
    assert.deepEqual(hookValues[2], []);

    button = setup();
    publicApiRequest = async () => ({ data: { enabled: true, records: [{ ...row, amount: 50 }] }, error: null });
    await button.props.onClick();
    assert.equal(downloads.length, 0);
    assert.equal(hookValues[2][0].amount, 50); // newer data is shown before allowing another export

    button = setup();
    let resolveDateCycle;
    publicApiRequest = () => new Promise((resolve) => { resolveDateCycle = resolve; });
    const dateCycleExport = button.props.onClick();
    const firstTree = renderPublicReport();
    const startInput = findElements(firstTree, (element) => element.type === 'input' && element.props.type === 'date')[0];
    startInput.props.onChange({ target: { value: '2026-10-03' } });
    renderPublicReport();
    startInput.props.onChange({ target: { value: '2026-10-01' } }); // A → B → A must still invalidate the old snapshot
    renderPublicReport();
    resolveDateCycle({ data: { enabled: true, records: [row] }, error: null });
    await dateCycleExport;
    assert.equal(downloads.length, 0);

    button = setup();
    const requestCount = apiCalls;
    hookValues[4] = true; // a page query is in progress while an old handler is still referenced
    renderPublicReport();
    await button.props.onClick();
    assert.equal(apiCalls, requestCount);

    button = setup();
    let resolveUnmounted;
    publicApiRequest = () => new Promise((resolve) => { resolveUnmounted = resolve; });
    const unmounted = button.props.onClick();
    hookValues[11].current = false;
    resolveUnmounted({ data: { enabled: true, records: [row] }, error: null });
    await unmounted;
    assert.equal(downloads.length, 0);
  } finally {
    publicApiRequest = async () => publicApiResult;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    if (previousCreateObjectUrl) URL.createObjectURL = previousCreateObjectUrl; else delete URL.createObjectURL;
  }
});

test('打印动作重新验证数据，并调用浏览器打印', async () => {
  const row = { payment_date: '2026-10-02', amount: 12.34, category: '材料', department: '活动组' };
  hookValues = [];
  hookValues[0] = { start: '2026-10-01', end: '2026-10-31' }; hookValues[2] = [row]; hookValues[3] = true; hookValues[4] = false;
  let printed = 0; let apiCalls = 0; let frame;
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, requestAnimationFrame: (callback) => { frame = callback; }, print: () => { printed += 1; } };
  publicApiRequest = async () => { apiCalls += 1; return { data: { enabled: true, records: [row] }, error: null }; };
  try {
    const tree = renderPublicReport();
    const button = findElements(tree, (element) => element.type === 'button' && element.props.children.includes('打印 / 保存 PDF'))[0];
    await button.props.onClick();
    assert.equal(apiCalls, 1);
    assert.equal(printed, 0);
    assert.match(hookValues[10], /\d{4}/); // the print-only report metadata has a generation time
    frame();
    assert.equal(printed, 1);
  } finally {
    publicApiRequest = async () => publicApiResult;
    globalThis.window = previousWindow;
  }
});

test('打印样式隐藏筛选和按钮并允许表格跨页显示', () => {
  const css = readFileSync('src/style.css', 'utf8');
  assert.match(css, /@media print[\s\S]*?\.public-report-filters[\s\S]*?display:none!important/);
  assert.match(css, /@media print[\s\S]*?\.public-report-list \.table-scroll\{overflow:visible\}/);
  assert.match(css, /@media print[\s\S]*?\.public-report-list tr\{break-inside:avoid;page-break-inside:avoid\}/);
});
