// Issue #5：登录失败限流与异常登录保护。
//
// 这一组用例跑的是真实 SQL 栈（PGlite）+ 真实 app-api handler，只有 supabase-js 被替换成
// 内存适配器（与 tests/finance-self-payment.test.mjs 同一套做法）。
// 关键验收点之一是「不同账号和不同来源的限流策略不会互相误伤」，所以这里必须能伪造来源 IP：
// call() 直接构造带 cf-connecting-ip 的 Request，与 createAdmin / clientIp 读取的请求头一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createSqlStack, rootPath, SQL_STACK_TIMEOUT } from './helpers/sql-stack.mjs';
import { createSqlClient } from './helpers/pglite-supabase-adapter.mjs';

const PASSWORD = 'Test-only-1369666';
const WRONG_PASSWORD = 'definitely-not-the-password';
const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';
const IP_SHARED = '198.51.100.9';
const IP_REGISTER = '192.0.2.77';

// 这个用例会连续发 ~50 次登录/注册请求（限流本身就是「多试几次才看得出效果」），
// 而 SQL 栈加载（全部迁移 + 全部 .verify.sql）在 CI 上通常要 60-80 秒，
// 所以用比 SQL_STACK_TIMEOUT 更宽的预算，避免整条用例被测试框架的超时取消。
const THROTTLE_TIMEOUT = 240000;

test('登录失败按账号与来源限流，成功后清零，注册按 IP 限流，审计不含密码', { timeout: THROTTLE_TIMEOUT }, async () => {
  const { db } = await createSqlStack();
  const buildDir = rootPath('tests', '.tmp', 'login-throttle');
  const savedDeno = globalThis.Deno;
  const savedClient = globalThis.__LOGIN_THROTTLE_CLIENT__;
  try {
    const client = createSqlClient(db);
    // 通用 adapter 的 rpc 会把函数求值两次（tests/helpers/pglite-supabase-adapter.mjs:212 的
    // `select f(...) as result, pg_typeof(f(...)) as result_type`，为了拿返回类型而多算一次）。
    // 这里用到的函数全都是「有副作用」的那类，多算一次的后果很实际：限流计数翻倍（阈值 5 变成第 3 次就锁），
    // 注册则会第一次成功、第二次撞唯一约束而报「用户名已存在」。
    // 这与 tests/finance-self-payment.test.mjs:16-33 是同一个坑，处理方式相同：只调一次。
    const originalRpc = client.rpc.bind(client);
    const singleCallRpc = new Set(['app_login_gate', 'app_login_record_attempt', 'app_create_user']);
    client.rpc = async (name, args = {}) => {
      if (!singleCallRpc.has(name)) return originalRpc(name, args);
      const entries = Object.entries(args ?? {});
      try {
        const result = await db.query(
          `select public.${name}(${entries.map((_, index) => `$${index + 1}`).join(', ')}) as result`,
          entries.map(([, value]) => value),
        );
        return { data: result.rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message, code: null, details: null, hint: null } };
      }
    };
    globalThis.__LOGIN_THROTTLE_CLIENT__ = client;
    let handler;
    globalThis.Deno = {
      env: { get: (key) => ({ SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'test-key' })[key] ?? '' },
      serve: (fn) => { handler = fn; },
    };
    await mkdir(buildDir, { recursive: true });
    const stub = `${buildDir}/client.mjs`;
    await writeFile(stub, 'export function createClient() { return globalThis.__LOGIN_THROTTLE_CLIENT__; }');
    const source = (await readFile(rootPath('supabase/functions/app-api/index.ts'), 'utf8'))
      .replace("from 'npm:@supabase/supabase-js@2'", `from ${JSON.stringify(pathToFileURL(stub).href)}`);
    await writeFile(`${buildDir}/api.mjs`, (await transform(source, { loader: 'ts', format: 'esm' })).code);
    await import(pathToFileURL(`${buildDir}/api.mjs`).href);

    // call(): 可指定来源 IP；不传就相当于没有来源头（例如内网直连）。
    const call = async (action, args = {}, { ip } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (ip) headers['cf-connecting-ip'] = ip;
      const response = await handler(new Request('http://localhost/functions/v1/app-api', {
        method: 'POST', headers, body: JSON.stringify({ action, ...args }),
      }));
      return { status: response.status, ...(await response.json()) };
    };
    const login = (username, password, ip) => call('login', { username, password }, { ip });
    const newUser = async (name, role) => {
      const { rows } = await db.query("select (private.app_insert_user($1, $2, $1, '测试')->>'id')::uuid as id", [name, PASSWORD]);
      const id = rows[0].id;
      if (role) await db.query('insert into public.user_roles(user_id,role) values ($1,$2)', [id, role]);
      return id;
    };
    const failuresOf = async (key) => (await db.query('select failures, locked_until from public.login_attempts where key=$1', [key])).rows[0] ?? null;

    // ---------------------------------------------------------------- 1. 正常登录不受影响
    await newUser('throttle_user_a');
    const firstLogin = await login('throttle_user_a', PASSWORD, IP_A);
    assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin));
    assert.ok(firstLogin.data.session.token);
    assert.equal(await failuresOf('login:user:throttle_user_a'), null, '成功登录后不应留下失败计数');

    // ---------------------------------------------------------------- 2. 阈值内不锁定（允许 5 次失败）
    for (const round of [1, 2, 3, 4, 5]) {
      const attempt = await login('throttle_user_a', WRONG_PASSWORD, IP_A);
      assert.equal(attempt.status, 401, `第 ${round} 次错误密码应返回 401`);
      assert.equal(attempt.error.message, '用户名或密码不正确。');
    }
    assert.equal((await failuresOf('login:user:throttle_user_a')).failures, 5);
    assert.equal((await failuresOf('login:user:throttle_user_a')).locked_until, null, '阈值内不应锁定');

    // ---------------------------------------------------------------- 3. 跨过阈值的那一次就返回限流
    // 阈值 5 的语义是「允许 5 次失败，第 6 次开始限流」：第 6 次本身必须返回 429 并带等待时间。
    // 若先返回「密码不正确」、等第 7 次才锁，攻击者就能从响应差异判断账号是否已进入锁定。
    const sixth = await login('throttle_user_a', WRONG_PASSWORD, IP_A);
    assert.equal(sixth.status, 429, JSON.stringify(sixth));
    assert.match(sixth.error.message, /登录尝试过于频繁/);
    assert.match(sixth.error.message, /30 秒后重试/, '首次限流的等待时间应为 30 秒');
    assert.equal((await failuresOf('login:user:throttle_user_a')).failures, 6);

    // 被限流期间即使密码正确也被拦住：证明 crypt() 校验被跳过（验收标准「不能无限高速执行密码校验」）。
    const blockedWithCorrectPassword = await login('throttle_user_a', PASSWORD, IP_A);
    assert.equal(blockedWithCorrectPassword.status, 429, '限流期间正确密码也不应通过');
    assert.equal((await failuresOf('login:user:throttle_user_a')).failures, 6, '被限流时不应再累计失败次数');

    // ---------------------------------------------------------------- 4. 不同账号不互相误伤
    await newUser('throttle_user_b');
    assert.equal((await login('throttle_user_b', PASSWORD, IP_B)).status, 200, '别的账号被限流不应影响我');

    // ---------------------------------------------------------------- 5. 同一 IP 的不同账号在前几次失败内不连坐
    await newUser('throttle_user_c');
    for (const round of [1, 2, 3, 4, 5]) {
      assert.equal((await login('throttle_user_c', WRONG_PASSWORD, IP_SHARED)).status, 401);
    }
    assert.equal(
      (await login('throttle_user_b', PASSWORD, IP_SHARED)).status, 200,
      '账号维度满额但 IP 维度未满时，同一出口下的其他账号仍应能登录',
    );

    // ---------------------------------------------------------------- 6. IP 维度达到阈值后拦住该来源
    // 用不同用户名继续从同一 IP 猜：账号维度各自未满，只能靠 IP 维度挡住。
    // IP_SHARED 这时已有 5 次失败（来自 throttle_user_c），再打 15 次补到恰好 20。
    for (let round = 0; round < 15; round++) {
      await login(`throttle_nobody_${round}`, WRONG_PASSWORD, IP_SHARED);
    }
    const ipFailures = await failuresOf(`login:ip:${IP_SHARED}`);
    assert.equal(ipFailures.failures, 20, `IP 维度应累计到 20 次失败，实际 ${ipFailures.failures}`);
    assert.equal(ipFailures.locked_until, null, '第 20 次失败属于阈值内，不应锁定');

    const ipOverflow = await login('throttle_nobody_extra', WRONG_PASSWORD, IP_SHARED);
    assert.equal(ipOverflow.status, 429, JSON.stringify(ipOverflow));
    const ipBlocked = await login('throttle_user_b', PASSWORD, IP_SHARED);
    assert.equal(ipBlocked.status, 429, 'IP 维度超阈值后应限流该来源，即使密码正确');
    assert.match(ipBlocked.error.message, /登录尝试过于频繁/);
    // 限流按来源隔离，不会全球连坐。
    assert.equal((await login('throttle_user_b', PASSWORD, '198.51.100.10')).status, 200, '换来源 IP 后应能正常登录');

    // ---------------------------------------------------------------- 7. 审计：记录失败事件，但不含密码、不泄露账号是否存在
    const auditRows = await db.query("select event, detail, actor_id from public.audit_logs where event in ('登录失败','登录账号')");
    assert.ok(auditRows.rows.some((row) => row.event === '登录失败'), '登录失败必须留下审计事件');
    const auditText = auditRows.rows.map((row) => `${row.event} ${row.detail}`).join('\n');
    assert.equal(auditText.includes(WRONG_PASSWORD), false, '审计不得包含密码原文');
    assert.equal(auditText.includes(PASSWORD), false, '审计不得包含任何密码原文');
    assert.equal(auditRows.rows.find((row) => row.event === '登录失败').actor_id, null, '匿名失败事件不应挂到某个账号上');
    assert.equal(/不存在|未注册|无此账号|已锁定|已停用/.test(auditText), false, '审计不应记录账号是否存在或是否被锁');

    // ---------------------------------------------------------------- 8. 成功登录清零账号维度
    await newUser('throttle_user_d');
    for (const round of [1, 2, 3, 4]) {
      assert.equal((await login('throttle_user_d', WRONG_PASSWORD, '203.0.113.44')).status, 401);
    }
    assert.equal((await failuresOf('login:user:throttle_user_d')).failures, 4);
    assert.equal((await login('throttle_user_d', PASSWORD, '203.0.113.44')).status, 200);
    assert.equal(await failuresOf('login:user:throttle_user_d'), null, '成功登录应清零账号维度的失败计数');
    // 清零之后重新计数，不被之前的次数连坐。
    assert.equal((await login('throttle_user_d', WRONG_PASSWORD, '203.0.113.44')).status, 401);
    assert.equal((await failuresOf('login:user:throttle_user_d')).failures, 1, '清零后应从 1 重新计数');

    // ---------------------------------------------------------------- 9. 普通管理员不能解锁，超管可以
    const opsAdminId = await newUser('throttle_ops_admin', 'admin');
    const superId = (await db.query("select id from public.app_users where lower(username)='admin'")).rows[0].id;
    await assert.rejects(
      db.query('select public.app_admin_reset_login_throttle($1,$2,$3)', [opsAdminId, 'throttle_user_a', '']),
      /只有内置超级管理员/,
    );
    const reset = await db.query('select public.app_admin_reset_login_throttle($1,$2,$3) as result', [superId, 'throttle_user_a', '']);
    assert.ok(Number(reset.rows[0].result.removed) >= 1, '超管解锁应删除限流记录');
    assert.equal((await login('throttle_user_a', PASSWORD, IP_A)).status, 200, '解锁后应能立即登录');

    // ---------------------------------------------------------------- 10. 注册按 IP 限流，且成功注册不清零 IP 计数
    // 测试栈默认 registration_enabled=false（sql-stack.mjs:124），app_create_user 会先挡住注册，
    // 这里打开开关才能验证到限流这一层。
    await db.query('update public.settings set registration_enabled = true where id = 1');
    for (const round of [0, 1, 2]) {
      const bad = await call('register', { username: '!!非法用户名!!', password: PASSWORD }, { ip: IP_REGISTER });
      assert.notEqual(bad.status, 200, '非法用户名不应注册成功');
    }
    assert.equal((await failuresOf(`login:ip:${IP_REGISTER}`)).failures, 3, '注册失败必须按 IP 记账');
    // 中文用户名同样不合法（用户名只允许字母数字点下划线短横线），也要记账。
    const badChinese = await call('register', { username: 'throttle_中文', password: PASSWORD }, { ip: IP_REGISTER });
    assert.notEqual(badChinese.status, 200, '非法用户名（中文）不应注册成功');
    assert.equal((await failuresOf(`login:ip:${IP_REGISTER}`)).failures, 4, '第二次非法注册也应记账');

    // 成功注册：不影响 IP 维度的计数（既不清零、也不累加）。
    // 不清零是刻意的：否则脚本换个自己刚注册的账号成功一次就能把 IP 计数洗掉。
    const okRegister = await call('register', { username: 'throttle_reg_ok', password: PASSWORD }, { ip: IP_REGISTER });
    assert.equal(okRegister.status, 200, '正常注册应成功: ' + JSON.stringify(okRegister));
    assert.equal((await failuresOf(`login:ip:${IP_REGISTER}`)).failures, 4, '成功注册既不清零也不累加 IP 维度的计数');
    // 注册只用 IP 维度记账，不应给该账号留下账号维度的计数。
    assert.equal(await failuresOf('login:user:throttle_reg_ok'), null, '注册不应给账号维度留下计数');
    // 注册出来的账号本身可以正常登录（证明没有把注册流程带坏）。
    assert.equal((await login('throttle_reg_ok', PASSWORD, IP_B)).status, 200, '刚注册的账号应能登录');

    // 把该 IP 打成「锁定中」，注册必须被拦住（这是「批量刷号」的挡板）。
    // gate 依据的是 locked_until（有效锁），不是失败次数本身：次数多但锁已过期就不该继续拦，
    // 所以这里直接把锁设到未来。
    await db.query("update public.login_attempts set failures=21, locked_until=now() + interval '5 minutes' where key=$1", [`login:ip:${IP_REGISTER}`]);
    const gateLocked = (await db.query('select public.app_login_gate($1,$2) as g', ['', IP_REGISTER])).rows[0].g;
    assert.equal(gateLocked.blocked, true, '锁定中的来源应被拦住');
    assert.ok(Number(gateLocked.retry_after_seconds) > 0, '被拦时应给出剩余等待秒数');

    const regBlocked = await call('register', { username: 'throttle_reg_blocked', password: PASSWORD }, { ip: IP_REGISTER });
    assert.equal(regBlocked.status, 429, JSON.stringify(regBlocked));
    assert.match(regBlocked.error.message, /注册尝试过于频繁/);
    // 且不会因为被限流就凭空创建出账号。
    assert.equal((await db.query("select count(*)::int as n from public.app_users where username='throttle_reg_blocked'")).rows[0].n, 0);

    // ---------------------------------------------------------------- 11. 没有来源头的请求不会被误伤
    assert.equal((await login('throttle_user_b', PASSWORD)).status, 200, '无法判定来源时不应限流');

    // ---------------------------------------------------------------- 12. 限流表只由服务端使用
    for (const signature of ['app_login_gate(text,text)', 'app_login_record_attempt(text,boolean,text,text)', 'app_admin_reset_login_throttle(uuid,text,text)']) {
      const { rows } = await db.query("select has_function_privilege('anon',$1,'execute') as anon, has_function_privilege('authenticated',$1,'execute') as authenticated, has_function_privilege('service_role',$1,'execute') as service", [`public.${signature}`]);
      assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true }, signature);
    }
    const { rows: tablePrivileges } = await db.query("select has_table_privilege('anon','public.login_attempts','select') as anon, has_table_privilege('authenticated','public.login_attempts','select') as authenticated");
    assert.deepEqual(tablePrivileges[0], { anon: false, authenticated: false });
  } finally {
    globalThis.Deno = savedDeno;
    globalThis.__LOGIN_THROTTLE_CLIENT__ = savedClient;
    await db.close();
    await rm(buildDir, { recursive: true, force: true });
  }
});
