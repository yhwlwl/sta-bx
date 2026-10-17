import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

// Execute the actual Edge handler; only the Supabase transport and Deno host are mocked.
const source = readFileSync('supabase/functions/app-api/index.ts', 'utf8');
// Windows 上 core.autocrlf 会把工作区副本转成 CRLF，按行锚定的正则会静默失配（CI 的 Linux 上看不出来），
// 所以这里只锚定到行尾、不假设换行符。改错时 transformed 仍带着 npm: 导入，用例会以 ERR_UNSUPPORTED_ESM_URL_SCHEME 失败。
const transformed = source.replace(/import \{ createClient \} from '[^']+'\r?\n/, 'const createClient = globalThis.__auditClient;\n');
let handler, actorRoles = ['admin'], queries, rpcCalls, rpcResult;
globalThis.Deno = { env: { get: () => '' }, serve: (fn) => { handler = fn; } };
globalThis.__auditClient = () => ({
  from(table) {
    queries.push(table);
    const data = table === 'app_sessions' ? { user_id: 'actor', expires_at: '2099-01-01' }
      : table === 'app_users' ? { id: 'actor', username: 'manager', active: true }
      : table === 'user_roles' ? actorRoles.map(role => ({role}))
      : table === 'settings' ? { threshold: 100, registration_enabled: true } : null;
    const query = { then(resolve, reject) { return Promise.resolve({data, error:null}).then(resolve, reject); } };
    for (const method of ['select', 'eq', 'maybeSingle', 'single', 'update', 'insert', 'delete', 'order', 'range', 'limit', 'in']) query[method] = () => query;
    return query;
  },
  async rpc(name, args) { rpcCalls.push({name, args}); return rpcResult(name, args); },
});
const { code } = await transform(transformed, { loader: 'ts', format: 'esm' });
const { readAuditFilters } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const limitedRow = {id: 1, username:'legacy', event:'登录账号', detail:'操作', ip_address:null, metadata:{}, request_id:null};
function reset() {
  queries = []; rpcCalls = []; actorRoles = ['admin'];
  rpcResult = () => ({data: {logs:[limitedRow], total:1, page:1, snapshot:'9007199254740993', scope:'limited'}, error:null});
}
async function request(body) {
  const response = await handler(new Request('https://test.invalid', { method:'POST', headers:{'content-type':'application/json','x-app-session':'test-session'}, body:JSON.stringify(body) }));
  return {status:response.status, ...(await response.json())};
}

test('筛选日期、长度和分页参数实际校验，快照 bigint 不损失精度', () => {
  assert.equal(readAuditFilters({snapshot:'9007199254740993'}, true).snapshot, '9007199254740993');
  for (const body of [{start:'2026-02-30'}, {start:'2026-10-02',end:'2026-10-01'}, {username:'x'.repeat(81)}, {page_size:7}, {snapshot:'9223372036854775808'}, {snapshot:'-1'}]) assert.throws(() => readAuditFilters(body, true));
});
test('日志列表将全部筛选和快照交给共享 RPC', async () => {
  reset();
  const result = await request({action:'admin_audit', username:'legacy',event:'登录',ip:'',start:'2026-10-01',end:'2026-10-05',page:2,page_size:10,snapshot:'9007199254740993'});
  assert.equal(result.status,200);
  assert.deepEqual(rpcCalls[0], {name:'app_list_audit_logs', args:{p_actor_id:'actor',p_username:'legacy',p_event:'登录',p_ip:'',p_start:'2026-10-01',p_end:'2026-10-05',p_page:2,p_page_size:10,p_snapshot:'9007199254740993',p_include_system:false}});
  assert.ok(!queries.includes('audit_logs'));
});

test('默认不返回系统日志，勾选后才带上', async () => {
  reset();
  await request({action:'admin_audit'});
  assert.equal(rpcCalls[0].args.p_include_system,false,'默认隐藏定时任务日志');
  reset();
  await request({action:'admin_audit',include_system:true});
  assert.equal(rpcCalls[0].args.p_include_system,true,'勾选后一并返回');
  reset();
  await request({action:'export_audit',include_system:true});
  assert.equal(rpcCalls[0].args.p_include_system,true,'导出沿用同一个开关');
});
test('兼容 admin_data 通过共享投影返回日志，不能绕过权限', async () => {
  reset();
  const result = await request({action:'admin_data'});
  assert.equal(result.status,200);
  assert.deepEqual(result.data.audit,[limitedRow]);
  assert.equal(result.data.scope,'limited');
  assert.ok(!queries.includes('audit_logs'));
});
test('导出与列表共用 RPC 和固定快照，保留普通管理员受限投影', async () => {
  reset();
  rpcResult = (name,args) => ({data:{logs:args.p_page === 1 ? Array(1000).fill(limitedRow) : [{...limitedRow,id:1001}],total:1001,snapshot:'9007199254740993',scope:'limited'}, error:null});
  const result = await request({action:'export_audit',username:'legacy',event:'登录',start:'2026-10-01'});
  assert.equal(result.data.rows.length,1001);
  assert.equal(rpcCalls.length,2);
  assert.equal(rpcCalls[0].args.p_snapshot,null);
  assert.equal(rpcCalls[1].args.p_snapshot,'9007199254740993');
  assert.equal(rpcCalls[1].args.p_username,'legacy');
  assert.equal(result.data.scope,'limited');
  assert.ok(result.data.rows.every(row => row.ip_address === null && !Object.keys(row.metadata).length));
  assert.equal(queries.filter(table => table === 'audit_logs').length,1); // export audit INSERT only
});
test('数据库拒绝的 IP 筛选也会阻止 API 导出', async () => {
  reset();
  rpcResult = () => ({data:null,error:{message:'仅超级管理员可以按 IP 筛选'}});
  const result = await request({action:'export_audit',ip:'10.0.'});
  assert.equal(result.status,400);
  assert.equal(result.error.message,'仅超级管理员可以按 IP 筛选');
  assert.ok(!queries.includes('audit_logs'));
});
test('非管理员不能访问新列表、兼容列表或导出', async () => {
  for (const action of ['admin_audit','admin_data','export_audit']) {
    reset(); actorRoles = [];
    assert.equal((await request({action})).status,403);
    assert.equal(rpcCalls.length,0);
  }
});
test('SQL 仅服务端可执行，界面隐藏普通管理员 IP 搜索并复用快照', () => {
  const sql = readFileSync('supabase/audit-search-and-pagination.sql','utf8');
  const jsx = readFileSync('src/admin.jsx','utf8');
  assert.match(sql,/from public,anon,authenticated/);
  assert.match(sql,/to service_role/);
  assert.match(jsx,/\{superAdmin && <input type="search" aria-label="搜索 IP 地址"/);
  assert.match(jsx,/snapshot: snapshotRef.current.snapshot/);
  assert.match(jsx,/snapshot: auditSnapshot/);
  assert.match(jsx,/setResult\(null\)/); // invalid filters must not display stale rows
});
