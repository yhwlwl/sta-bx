import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
const secretKey = secretKeys
  ? JSON.parse(secretKeys).default
  : (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
function createAdmin(req: Request, requestId: string, action = '', actorId = '') {
  const source = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'].find((key) => req.headers.get(key))
  const address = source ? req.headers.get(source)?.split(',')[0].trim() ?? '' : ''
  const ip = /^[0-9a-fA-F:.]{3,64}$/.test(address) ? address : ''
  return createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { 'x-audit-ip': ip, 'x-audit-ip-source': ip ? source! : '', 'x-audit-action': action, 'x-audit-actor': actorId, 'x-audit-request-id': requestId } },
  })
}
type AdminClient = ReturnType<typeof createAdmin>

// 事件名必须与迁移 notifications.event 的 check 约束、settings.email_notify_events 的白名单和
// private.app_notify_event_for_status 的状态映射保持一致（测试逐项比对两处清单）。
// 五类"需要有人动手"的待办发给对应身份的成员或申请人本人；拒绝申请、已付款是结果通知，只发给申请人本人，
// 默认不在 settings.email_notify_events 里（管理员可在设置里打开）。已撤回、草稿不发。
const NOTIFY_EVENTS: Record<string, string> = {
  '待财委审批': '有新的申请等待财委审批',
  '待主席审批': '有新的申请等待主席审批',
  '退回修改': '您的申请被退回，请修改后重新提交',
  '待补充收款码': '您的申请已通过审批，请补充收款信息',
  '待付款登记': '有新的报销等待付款登记',
  '拒绝申请': '您的申请未通过审批',
  '已付款': '您的报销已完成打款',
}
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', finance_pending: '待财委审批', chair_pending: '待主席审批',
  changes_requested: '退回修改', rejected: '已拒绝', payment_info_required: '待补充收款码',
  payment_pending: '待付款', paid: '已付款', cancelled: '已撤回',
}
// 每个事件对应“仍然成立”的状态：领取之后、真正发送之前复核一次。
// 待办类状态变了（被别人处理、被撤回、收款人换了）就不再催。
// 结果类（拒绝/已付款）对应终态：申请一旦再次变化（例如被拒绝后重新提交），
// 版本复核与状态复核都会把这封已经不再成立的待发提醒作废——这是有意的，不是"误判"。
const NOTIFY_EVENT_STATUS: Record<string, string> = {
  '待财委审批': 'finance_pending',
  '待主席审批': 'chair_pending',
  '退回修改': 'changes_requested',
  '待补充收款码': 'payment_info_required',
  '待付款登记': 'payment_pending',
  '拒绝申请': 'rejected',
  '已付款': 'paid',
}
// 队列消费参数与 src/notify-rules.js 中的同名常量保持一致（Edge Function 无法直接引用前端模块）。
const NOTIFY_BATCH = 100
const NOTIFY_ROUNDS = 8
const NOTIFY_CONCURRENCY = 5
const NOTIFY_SEND_TIMEOUT_MS = 15000
const NOTIFY_MAX_AGE_HOURS = 24
const NOTIFY_MAX_ATTEMPTS = 5
const NOTIFY_BACKOFF_CAP_MINUTES = 60
// 一轮消费最多跑这么久。托管免费方案的 worker 墙钟上限与请求 idle timeout 都是 150 秒
// （https://supabase.com/docs/guides/functions/limits），所以默认预算必须明显低于 150 秒：
// 被平台硬杀的话，剩余的行会卡在“发送中”、按中断累加失败次数，正常积压也可能耗尽重试预算。
// 自托管可以调大：环境变量 NOTIFY_MAX_RUNTIME_MS（毫秒），钳在下面算出的下限与上限之间。
// 投递一个发送组（最多 5 封并发、单封 15 秒超时）加上写回，以及收尾时把没发送的行退回队列与写审计。
// 每开始一组之前判断“剩下的时间够不够跑完这一组并收尾”，而不是只判断是否大于 0：
// 否则最后一组会被平台掐断，那些行只能等租约到期、白吃一次尝试次数。
const NOTIFY_GROUP_BUDGET_MS = NOTIFY_SEND_TIMEOUT_MS + 5000
const NOTIFY_WRAPUP_BUDGET_MS = 20000
// 下限必须大于“一组 + 收尾”（40 秒），否则每轮都会在跑第一组之前就退出、一封也发不出去；
// 再留一个单封超时，保证至少能完整跑完一组。
const NOTIFY_MIN_RUNTIME_MS = NOTIFY_GROUP_BUDGET_MS + NOTIFY_WRAPUP_BUDGET_MS + NOTIFY_SEND_TIMEOUT_MS
// 上限压在租约上限（900 秒）之内：租约是按预算派生的（见下），预算比租约长的话，
// 本轮最先领取的行会在中途过期、被另一批（例如 5 分钟后的 cron）抢走并可能重复投递。
const NOTIFY_LEASE_LIMIT_SECONDS = 900
const NOTIFY_MAX_RUNTIME_LIMIT_MS = 840000
const NOTIFY_DEFAULT_RUNTIME_MS = 110000
const configuredRuntimeMs = Number(Deno.env.get('NOTIFY_MAX_RUNTIME_MS') ?? '')
const NOTIFY_MAX_RUNTIME_MS = Number.isFinite(configuredRuntimeMs) && configuredRuntimeMs > 0
  ? Math.min(Math.max(configuredRuntimeMs, NOTIFY_MIN_RUNTIME_MS), NOTIFY_MAX_RUNTIME_LIMIT_MS)
  : NOTIFY_DEFAULT_RUNTIME_MS
// 租约 = 预算 + 60 秒余量（至少 5 分钟，最多 900 秒，与 app_claim_notifications 的取值上限一致）。
const NOTIFY_LEASE_SECONDS = Math.min(NOTIFY_LEASE_LIMIT_SECONDS, Math.max(300, Math.ceil(NOTIFY_MAX_RUNTIME_MS / 1000) + 60))
// 邮件服务返回 429（限频）时暂停本轮、按 Retry-After 稍后重试：这是“等一等就好”，不消耗尝试次数，
// 否则中继的每分钟限频会把正常积压误判成永久失败。
const NOTIFY_THROTTLE_MIN_WAIT_SECONDS = 30
const NOTIFY_THROTTLE_MAX_WAIT_SECONDS = 600

// 定时密钥比较：长度不同直接拒绝（长度本身不是秘密），长度相同时逐字符异或，不因为内容不同而提前返回。
function sameSecret(left: string, right: string) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index++) diff ^= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function buildNotifyEmail(event: string, app: Record<string, any>, ownerName: string) {
  const appUrl = (Deno.env.get('APP_URL') ?? '').trim()
  const money = `¥${Number(app.amount ?? 0).toFixed(2)}`
  const rows: [string, string][] = [
    ['申请标题', app.title], ['金额', money], ['部门 / 活动', app.department],
    ['费用类别', app.category], ['申请人', ownerName], ['当前状态', STATUS_LABELS[app.status] ?? app.status],
  ]
  const lines = rows.map(([label, value]) => `<p>${escapeHtml(label)}：${escapeHtml(value)}</p>`).join('')
  const link = appUrl ? `<p>登录平台处理：<a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>` : ''
  return `<div style="font-family:system-ui,sans-serif;color:#243047"><p>${escapeHtml(NOTIFY_EVENTS[event] ?? '有新的申请动态')}</p>${lines}${link}<p style="color:#637189">本邮件由成都七中科学技术协会财务报销平台自动发送，请勿直接回复。</p></div>`
}

const bucket = 'application-files'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, x-app-session, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

class HttpError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
})

const ok = (data: unknown) => json({ data, error: null })
const fail = (message: string, status = 400) => json({ data: null, error: { message } }, status)

function getSessionToken(req: Request) {
  const headerToken = req.headers.get('x-app-session')?.trim()
  if (headerToken) return headerToken
  const authorization = req.headers.get('authorization') ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

// 登录/注册限流的来源地址。与 createAdmin 里的审计 IP 取同一组请求头、用同一条正则校验，
// 但这里不依赖 createAdmin：限流要在建库客户端之前就判定。
function clientIp(req: Request) {
  const source = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'].find((key) => req.headers.get(key))
  if (!source) return ''
  const address = req.headers.get(source)?.split(',')[0].trim() ?? ''
  return /^[0-9a-fA-F:.]{3,64}$/.test(address) ? address : ''
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function issueSession(userId: string, admin: AdminClient) {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await admin.from('app_sessions').insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
  if (error) throw new Error('登录会话创建失败。')
  return { token, expiresAt }
}

async function actorFromRequest(req: Request, admin: AdminClient) {
  const token = getSessionToken(req)
  if (!token) throw new HttpError('请先登录。', 401)
  const tokenHash = await sha256Hex(token)
  const { data: session, error: sessionError } = await admin
    .from('app_sessions')
    .select('user_id,expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (sessionError) throw new Error('登录状态读取失败。')
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    await admin.from('app_sessions').delete().eq('token_hash', tokenHash)
    throw new HttpError('登录已过期，请重新登录。', 401)
  }
  const { data: user, error: userError } = await admin
    .from('app_users')
    .select('id,username,full_name,department,active,email')
    .eq('id', session.user_id)
    .maybeSingle()
  if (userError || !user) throw new HttpError('账号不存在。', 401)
  if (!user.active) throw new HttpError('账号已停用。', 403)
  const { data: roleRows, error: roleError } = await admin.from('user_roles').select('role').eq('user_id', user.id)
  if (roleError) throw new Error('账号权限读取失败。')
  await admin.from('app_sessions').update({ last_seen_at: new Date().toISOString() }).eq('token_hash', tokenHash)
  return { token, user, roles: (roleRows ?? []).map((row) => row.role as string) }
}

function isSuperAdmin(actor: Awaited<ReturnType<typeof actorFromRequest>>) {
  return actor.roles.includes('admin') && actor.user.username.toLowerCase() === 'admin'
}

function hasRole(actor: Awaited<ReturnType<typeof actorFromRequest>>, role: string) {
  // 付款登记（cashier）视同财委（finance），与 private.app_user_has_role 保持一致。
  return actor.roles.includes(role) || (role !== 'admin' && isSuperAdmin(actor)) || (role === 'cashier' && actor.roles.includes('finance'))
}

function requireRole(actor: Awaited<ReturnType<typeof actorFromRequest>>, role: string) {
  if (!hasRole(actor, role)) throw new HttpError('没有对应操作权限。', 403)
}

async function readRequest(req: Request) {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData()
    const fields: Record<string, unknown> = {}
    for (const [key, value] of form.entries()) {
      if (key !== 'file' && typeof value === 'string') fields[key] = value
    }
    fields.file = form.get('file')
    return fields
  }
  return await req.json()
}

function requiredString(value: unknown, message: string) {
  const text = String(value ?? '').trim()
  if (!text) throw new HttpError(message)
  return text
}

const AUDIT_PAGE_SIZES = [10, 20, 50, 100]
const AUDIT_TEXT_LIMITS: Record<string, number> = { username: 80, event: 80, ip: 64 }
const BEIJING_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The single definition of what an audit-log filter means. The paged table and the
 * export both read it, so the export can never disagree with what the operator saw.
 */
export function readAuditFilters(body: Record<string, unknown>, withPage: boolean) {
  const filters: Record<string, string> = {}
  for (const [key, limit] of Object.entries(AUDIT_TEXT_LIMITS)) {
    const value = String(body[key] ?? '').trim()
    if (value.length > limit) throw new HttpError('搜索条件过长。')
    filters[key] = value
  }
  const validDay = (value: string) => BEIJING_DAY.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  const start = String(body.start ?? '').trim(), end = String(body.end ?? '').trim()
  if ((start && !validDay(start)) || (end && !validDay(end)) || (start && end && start > end)) throw new HttpError('请选择有效的日期范围。')
  filters.start = start
  filters.end = end
  const snapshot = body.snapshot == null || body.snapshot === '' ? null : String(body.snapshot)
  if (snapshot !== null && (!/^\d{1,19}$/.test(snapshot) || BigInt(snapshot) > 9223372036854775807n)) throw new HttpError('日志快照无效。')
  if (!withPage) return { filters, page: 1, pageSize: 0, snapshot }
  const rawPage = body.page === undefined || body.page === '' ? 1 : Number(body.page)
  const rawPageSize = body.page_size === undefined || body.page_size === '' ? 20 : Number(body.page_size)
  if (!Number.isInteger(rawPage) || rawPage < 1 || !AUDIT_PAGE_SIZES.includes(rawPageSize)) throw new HttpError('分页参数无效。')
  return { filters, page: rawPage, pageSize: rawPageSize, snapshot }
}

/** Operator-facing description of the active filters, reused in the export header row. */
export function auditFilterSummary(filters: Record<string, string>) {
  const parts: string[] = []
  if (filters.username) parts.push(`用户名 含「${filters.username}」`)
  if (filters.event) parts.push(`操作 含「${filters.event}」`)
  if (filters.ip) parts.push(`IP 含「${filters.ip}」`)
  if (filters.start || filters.end) parts.push(`${filters.start || '最早'} 至 ${filters.end || '现在'}`)
  return parts.join(' · ')
}

async function handle(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') throw new HttpError('请求方式不支持。', 405)
  const body = await readRequest(req) as Record<string, unknown>
  const action = requiredString(body.action, '缺少操作类型。')
  const requestId = crypto.randomUUID()
  let admin = createAdmin(req, requestId, action)
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args)
    if (result.error) throw new HttpError(result.error.message)
    return result.data
  }
  const audit = async (actorId: string | null, event: string, detail: string, metadata: Record<string, unknown> = {}) => {
    const { error } = await admin.from('audit_logs').insert({ actor_id: actorId, event, detail, metadata })
    if (error) throw new Error('操作日志保存失败。')
  }

  // 队列消费：管理员手动点击和定时任务共用这一段逻辑，两处行为完全一致。
  // 每一轮先向数据库原子领取（批次号 + 租约），两个人同时点也不会把同一封邮件寄两次；
  // 中途被超时打断的批次会连同一次尝试计入下一轮，不会永久卡在“发送中”。
  const drainNotifications = async (actorId: string | null) => {
    const apiUrl = (Deno.env.get('EMAIL_API_URL') ?? '').trim()
    const apiKey = (Deno.env.get('EMAIL_API_KEY') ?? '').trim()
    const emailFrom = (Deno.env.get('EMAIL_FROM') ?? '').trim()
    const { data: settingsRow, error: settingsError } = await admin.from('settings').select('email_notify_enabled,email_notify_events').eq('id', 1).single()
    if (settingsError) throw new Error('通知设置读取失败。')
    // 开关优先于密钥：关闭时定时任务不应该因为没配邮件服务而反复失败刷日志。
    if (!settingsRow.email_notify_enabled) return ok({ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, stale: 0, skipped: true, rounds: 0, pending: 0, message: '总开关关闭，未发送邮件。' })
    // 逐类开关由数据库在领取时执行（关掉的类型就地作废）；这里只记一份，用于审计与日志。
    const enabledEvents: string[] = Array.isArray(settingsRow.email_notify_events) ? settingsRow.email_notify_events : []
    if (!apiUrl || !apiKey || !emailFrom) {
      if (actorId === null) return ok({ sent: 0, failed: 0, retried: 0, cancelled: 0, deferred: 0, discarded: 0, stale: 0, misconfigured: true, rounds: 0, pending: 0, message: '邮件服务尚未配置，本轮未发送。' })
      throw new HttpError('邮件服务尚未配置，请项目负责人为 app-api 配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM。', 503)
    }
    let sent = 0
    let failed = 0
    let retried = 0
    let cancelled = 0
    let deferred = 0
    let discarded = 0
    let stale = 0
    // 被复核判 skip 的具体行：收尾退回队列时要把它们从「跳过」挪进「退回」，
    // 否则同一行会被计两次（审计里的封数与队列行数对不上）。
    const staleIds = new Set<number>()
    let recheckFailures = 0
    let rounds = 0
    const startedAt = Date.now()
    const timeLeft = () => NOTIFY_MAX_RUNTIME_MS - (Date.now() - startedAt)
    let stop = false
    let throttleWait = 0
    while (rounds < NOTIFY_ROUNDS && !stop) {
      if (timeLeft() < NOTIFY_GROUP_BUDGET_MS + NOTIFY_WRAPUP_BUDGET_MS) break
      const claimId = crypto.randomUUID()
      const claim = await rpc('app_claim_notifications', { p_claim_id: claimId, p_limit: NOTIFY_BATCH, p_lease_seconds: NOTIFY_LEASE_SECONDS, p_max_age_hours: NOTIFY_MAX_AGE_HOURS, p_max_attempts: NOTIFY_MAX_ATTEMPTS })
      discarded += Number(claim?.discarded ?? 0)
      // 领取时顺带作废的“收件人已经没有该待办身份”的行由数据库判定（private.app_user_has_role），
      // 这里只把它计进管理面板的“已作废”，状态语义与 handler 自己复核出来的作废完全一致。
      cancelled += Number(claim?.cancelled ?? 0)
      const rows: Record<string, any>[] = Array.isArray(claim?.rows) ? claim.rows : []
      if (!rows.length) break
      rounds++
      const [appsResult, recipientsResult] = await Promise.all([
        admin.from('applications').select('id,title,amount,department,category,status,version,owner_id').in('id', [...new Set(rows.map((row) => row.application_id))]),
        admin.from('app_users').select('id,email,full_name,username,active').in('id', [...new Set(rows.map((row) => row.recipient_user_id))]),
      ])
      if (appsResult.error || recipientsResult.error) throw new Error('通知数据读取失败。')
      const ownersResult = await admin.from('app_users').select('id,full_name,username').in('id', [...new Set((appsResult.data ?? []).map((app) => app.owner_id))])
      if (ownersResult.error) throw new Error('通知数据读取失败。')
      const apps = new Map((appsResult.data ?? []).map((app) => [app.id, app]))
      const users = new Map((recipientsResult.data ?? []).map((user) => [user.id, user]))
      const owners = new Map((ownersResult.data ?? []).map((user) => [user.id, user.full_name || user.username]))
      // 写回结果必须同时匹配 id、发送中状态和批次号：租约过期被别的批次领走后就写不进去了。
      // touched 记录本轮真正写回成功的行；收尾时把没动过的行原样退回队列，不让它们卡在“发送中”。
      // 写回失败（PostgREST 出错、网络抖动）不算已处理：该行不进 touched，计数也不加，审计不会虚报。
      // 另外用 `.select('id')` 拿回写结果：0 行命中也可能是“这一行早被别人抢走了”，那同样不算我们处理成功
      // （不这样判断的话，重复投递与计数虚报都看不出来——PostgREST 默认不返回 representation 也不报错）。
      const touched = new Set<number>()
      const settle = async (note: Record<string, any>, fields: Record<string, unknown>) => {
        const { data, error } = await admin.from('notifications').update(fields).eq('id', note.id).eq('status', 'sending').eq('claim_id', claimId).select('id')
        if (error) return false
        if (!Array.isArray(data) || data.length !== 1) return false
        touched.add(note.id)
        return true
      }
      // 时间用尽或遇到限频时把没发送的行退回队列：不记尝试次数，也不等 5 分钟租约到期。
      const release = (note: Record<string, any>, message: string) => settle(note, {
        status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + throttleWait * 1000).toISOString(),
        last_error: note.last_error || message,
      })
      // 投递前最后一次复核（审查 P1 + 终审 P2）：领取之后到真正投递之间还隔着几秒到几十秒——一轮最多 100 封、
      // 每组 5 封并发，后面的行可能等很久。管理员撤角色、关类型，或者工作流把这行作废（例如移除收款码会把
      // 「待付款登记」作废）都发生在这个窗口里，而入库时与领取时的判定都已经过期。
      // 复核交给数据库（身份 private.app_user_has_role + settings.email_notify_events + 申请版本/状态），
      // 客户端不重写规则，并且按“白名单”契约执行：只有数据库明确判定 send 的行才进入投递。
      // 结果缺席（行已被删除、不在本次领取里）与 skip 一律不放行——旧版把“没出现在结果里”当放行，
      // 已被工作流作废的行反而会被寄出（PR #19 终审 P2：缺席不是放行证据）。
      // skip 的行不投递也不改状态：它可能刚被工作流作废、被别的批次接手，写回只会破坏别的路径的记账；
      // cancel 的行是“仍属于本批、但按当前事实不该再发”，就地写 cancelled 并计「已作废」。
      // 复核本身失败（PostgREST 暂时不可用、schema 缓存未刷新）不能让整轮崩掉：把这一组原样退回队列、
      // 记下原因并结束本轮——否则这一个 RPC 出错会让最多 100 行卡在“发送中”，5 轮之后按“连续未完成”
      // 全部转 failed，本来该发的提醒一封都发不出去，而且审计里什么也看不到。
      const recheckGroup = async (group: Record<string, any>[]) => {
        if (!group.length) return group
        let verdicts: unknown
        try {
          verdicts = await rpc('app_notify_verify_rows', { p_claim_id: claimId, p_ids: group.map((note) => note.id) })
        } catch (error) {
          recheckFailures++
          console.error(`notify recheck failed: ${error instanceof Error ? error.message : 'unknown'}`)
          for (const note of group) {
            if (await settle(note, { status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(), next_attempt_at: new Date().toISOString(), last_error: '投递前复核暂时失败，已退回队列' })) deferred++
          }
          return []
        }
        const verdictById = new Map<number, { verdict: string; reason: string }>((Array.isArray(verdicts) ? verdicts : [])
          .map((row: Record<string, any>) => [Number(row.id), { verdict: String(row.verdict ?? ''), reason: String(row.reason ?? '') }]))
        const allowed: Record<string, any>[] = []
        for (const note of group) {
          const verdict = verdictById.get(Number(note.id))
          if (verdict?.verdict !== 'send') {
            if (verdict?.verdict === 'cancel') {
              const reason = verdict.reason || '投递前复核未通过，提醒已作废'
              if (await settle(note, { status: 'cancelled', claim_id: null, last_error: reason.slice(0, 300) })) cancelled++
            } else {
              // 没有判定（行已消失/不在本次领取）或明确 skip：不投递，也不由复核把它改成 cancelled/failed。
              // 收尾退回队列时仍会碰其中"本批持有、只是租约已过期"的那种 skip——那是既有的中断恢复语义；
              // 已作废、已换批次的行在 settle 的 claim_id/status 条件上必然写不中，不会被改动。
              stale++
              staleIds.add(Number(note.id))
            }
            continue
          }
          allowed.push(note)
        }
        return allowed
      }
      const sendOne = async (note: Record<string, any>) => {
        const app = apps.get(note.application_id)
        const recipient = users.get(note.recipient_user_id)
        if (!app) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, claim_id: null, last_error: '申请已不存在' })) failed++
          return
        }
        if (!recipient?.email) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, claim_id: null, last_error: '收件人邮箱已不存在' })) failed++
          return
        }
        if (!recipient.active) {
          if (await settle(note, { status: 'failed', attempts: note.attempts + 1, claim_id: null, last_error: '收件人账号已停用' })) failed++
          return
        }
        // 发送前复核版本：被退回修改后重新提交会升 version，旧版本的提醒指向的是上一次待办。
        // 状态可能绕一圈又回到同一个值（finance_pending → changes_requested → finance_pending），
        // 只比状态会把上一版的旧提醒当成有效待办再寄一次，所以版本不匹配就作废。
        if (typeof app.version === 'number' && app.version !== note.application_version) {
          if (await settle(note, { status: 'cancelled', claim_id: null, last_error: `申请已重新提交（版本 ${note.application_version} → ${app.version}），提醒已作废` })) cancelled++
          return
        }
        // 发送前复核：申请已经离开这个待办状态（被别人处理、被撤回、收款人换了）就不再催，
        // 直接把这封标记为已作废 —— “已作废”不参与去重，之后重新产生待办还能再提醒一次。
        const expectedStatus = NOTIFY_EVENT_STATUS[note.event]
        if (expectedStatus && app.status !== expectedStatus) {
          if (await settle(note, { status: 'cancelled', claim_id: null, last_error: `申请状态已变为「${STATUS_LABELS[app.status] ?? app.status}」，提醒已作废` })) cancelled++
          return
        }
        let errorText = ''
        let throttled = false
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ from: emailFrom, to: recipient.email, subject: `【财务报销平台】${NOTIFY_EVENTS[note.event] ?? '有新的申请动态'}`, html: buildNotifyEmail(note.event, app, owners.get(app.owner_id) ?? '成员') }),
            signal: AbortSignal.timeout(NOTIFY_SEND_TIMEOUT_MS),
          })
          if (response.status === 429) {
            // 限频是“等一等就好”：不计入尝试次数，也不逐封重试，暂停本轮并把剩下的行一起退回。
            throttled = true
            const header = Math.floor(Number(response.headers.get('retry-after') ?? ''))
            const wait = Number.isFinite(header) && header > 0 ? header : 60
            throttleWait = Math.max(throttleWait, Math.min(Math.max(wait, NOTIFY_THROTTLE_MIN_WAIT_SECONDS), NOTIFY_THROTTLE_MAX_WAIT_SECONDS))
          } else if (!response.ok) {
            errorText = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
          }
        } catch (error) {
          errorText = error instanceof Error ? error.message.slice(0, 200) : '邮件服务请求失败'
        }
        if (throttled) {
          if (await settle(note, {
            status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(),
            next_attempt_at: new Date(Date.now() + throttleWait * 1000).toISOString(),
            last_error: `邮件服务限频（HTTP 429），${throttleWait} 秒后自动重试`,
          })) retried++
          return
        }
        const attempts = note.attempts + 1
        if (!errorText) {
          // 终态把批次号一起清掉：和 cancelled/failed/pending 保持一致，sent 行不再留着已经作废的租约批次。
          if (await settle(note, { status: 'sent', attempts, claim_id: null, last_error: '', sent_at: new Date().toISOString() })) sent++
          return
        }
        if (attempts >= NOTIFY_MAX_ATTEMPTS) {
          if (await settle(note, { status: 'failed', attempts, claim_id: null, last_error: errorText.slice(0, 300) })) failed++
          return
        }
        if (await settle(note, { status: 'pending', attempts, last_error: errorText.slice(0, 300), next_attempt_at: new Date(Date.now() + Math.min(2 ** attempts, NOTIFY_BACKOFF_CAP_MINUTES) * 60000).toISOString() })) retried++
      }
      for (let index = 0; index < rows.length; index += NOTIFY_CONCURRENCY) {
        // 只有"剩下的时间够跑完这一组 + 收尾"才继续：否则最后一组会被平台墙钟掐断，
        // 那些行只能等租约到期、白吃一次尝试次数。
        if (timeLeft() < NOTIFY_GROUP_BUDGET_MS + NOTIFY_WRAPUP_BUDGET_MS || throttleWait > 0) { stop = true; break }
        const group = await recheckGroup(rows.slice(index, index + NOTIFY_CONCURRENCY))
        // 复核接口挂了就不要再往下试：本组已退回队列，本轮到此为止，下一轮再重试。
        if (recheckFailures > 0) { stop = true; break }
        if (group.length) {
          // 收件地址只在整批开始时读过一次的话，"本人刚改绑邮箱"这一封会寄到旧地址（复核只判"有没有邮箱"，
          // 判不了地址是否还是这一个）。投递前把这一组收件人重读一次，把地址的窗口压到复核 → fetch 之间。
          // 重读失败不回退到旧快照：这一组原样退回队列，下一轮重判（与复核失败同一套降级策略），
          // 宁可晚一轮也不把申请详情寄到一个可能已经不属于收件人的地址。
          const fresh = await admin.from('app_users').select('id,email,active').in('id', [...new Set(group.map((note) => note.recipient_user_id))])
          if (fresh.error) {
            recheckFailures++
            console.error(`notify recipient refresh failed: ${fresh.error.message}`)
            for (const note of group) {
              if (await settle(note, { status: 'pending', claim_id: null, lease_expires_at: new Date().toISOString(), next_attempt_at: new Date().toISOString(), last_error: '投递前复核暂时失败，已退回队列' })) deferred++
            }
            stop = true
            break
          }
          for (const row of fresh.data ?? []) users.set(row.id, { ...(users.get(row.id) ?? {}), ...row })
          await Promise.all(group.map(sendOne))
        }
      }
      if (stop) {
        // 限频、时间用尽或复核失败：剩下的行（含本批还没轮到的那几个）原样退回队列，不消耗尝试次数。
        // 只有写回成功的才算退回，写回失败的留给租约到期那条路。
        const leftovers = rows.filter((note) => !touched.has(note.id))
        // 文案要说清"为什么停"：复核失败也会走到这里，不能一律写成"时间用尽"（那会让人去查预算）。
        const message = throttleWait > 0
          ? '邮件服务限频，本轮未发送'
          : recheckFailures > 0 ? '投递前复核失败，本轮未继续，已退回队列' : '本轮时间用尽，已退回队列'
        for (let index = 0; index < leftovers.length; index += NOTIFY_CONCURRENCY) {
          const group = leftovers.slice(index, index + NOTIFY_CONCURRENCY)
          const results = await Promise.all(group.map((note) => release(note, message)))
          // 同一行只计一次：复核时已经计进「跳过」、收尾又成功退回队列的，把计数从「跳过」挪到「退回」。
          const movedFromStale = results.filter((released, position) => released && staleIds.has(Number(group[position].id))).length
          stale -= movedFromStale
          deferred += results.filter(Boolean).length
        }
      }
    }
    const { count: pendingLeft, error: pendingError } = await admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'pending')
    if (pendingError) throw new Error('通知队列读取失败。')
    // 审计里写清本轮的预算与开启的提醒类型：配额上限与"管理员关了哪几类"是排查"为什么没收到"的第一手信息。
    // 复核失败必须留下痕迹——否则"什么都没发生"和"复核接口挂了"在日志里长得一样。
    const recheckNote = recheckFailures > 0 ? `；投递前复核失败 ${recheckFailures} 组，相关提醒已退回队列` : ''
    await audit(actorId, '发送邮件提醒', `${actorId ? '管理员' : '定时任务'}处理 ${rounds} 轮（预算 ${Math.round(NOTIFY_MAX_RUNTIME_MS / 1000)} 秒，已开启提醒类型 ${enabledEvents.length} 类）：发送 ${sent} 封，失败 ${failed} 封，稍后重试 ${retried} 封，作废 ${cancelled} 封，本轮退回 ${deferred} 封，丢弃 ${discarded} 封，投递前复核跳过 ${stale} 封（复核当时已不是本批的可发状态：已作废 / 已换批次 / 租约已过期；这些行本批没有投递，可能由后续轮次或下一次消费接管），剩余待发送 ${pendingLeft ?? 0} 封${recheckNote}`)
    return ok({ sent, failed, retried, cancelled, deferred, discarded, stale, recheck_failed: recheckFailures, rounds, pending: pendingLeft ?? 0 })
  }

  // 每轮最多 3 条、每次 HTTP 5 秒，给现有邮件消费保留运行预算。
  const drainQqNotifications = async (actorId: string | null) => {
    const appId = (Deno.env.get('QQ_BOT_APP_ID') ?? '').trim()
    const appSecret = (Deno.env.get('QQ_BOT_APP_SECRET') ?? '').trim()
    if (!appId || !appSecret) return { sent: 0, skipped: true, message: 'QQ机器人服务尚未配置。' }
    const { data: settings, error } = await admin.from('settings').select('qq_notify_enabled').eq('id', 1).single()
    if (error) throw new Error('QQ提醒设置读取失败。')
    if (!settings.qq_notify_enabled) return { sent: 0, skipped: true, message: 'QQ提醒已关闭。' }
    // 领取前取 token；认证失败时不消耗队列的重试次数。
    const apiBase = Deno.env.get('QQ_BOT_SANDBOX') === 'true' ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com'
    const tokenResponse = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }), signal: AbortSignal.timeout(5000),
    })
    const tokenData = await tokenResponse.json().catch(() => ({}))
    if (!tokenResponse.ok || !tokenData.access_token) throw new HttpError(`QQ机器人认证失败（HTTP ${tokenResponse.status}，code ${String(tokenData.code ?? 'unknown')}）。`, 503)
    const claimId = crypto.randomUUID()
    const rows = await rpc('app_claim_qq_notifications', { p_claim_id: claimId })
    let sent = 0, failed = 0, retried = 0, deferred = 0
    let throttle = false
    for (const note of Array.isArray(rows) ? rows : []) {
      const settle = async (fields: Record<string, unknown>) => {
        const result = await admin.from('qq_notifications').update({ ...fields, claim_id: null })
          .eq('id', note.id).eq('status', 'sending').eq('claim_id', claimId).select('id')
        if (result.error) throw new Error('QQ提醒结果保存失败。')
        return result.data?.length === 1
      }
      let allowed = false
      try { allowed = await rpc('app_verify_qq_notification', { p_id: note.id, p_claim_id: claimId }) === true } catch { /* 复核失败不发送 */ }
      if (!allowed || throttle) {
        // 复核不放行时保留 pending，由下一轮取消失效行；不会恢复已作废/换批次的行。
        if (await settle({ status: 'pending', attempts: note.attempts - 1, next_attempt_at: new Date(Date.now() + 600000).toISOString(), last_error: '本轮未投递，等待重新复核' })) deferred++
        continue
      }
      let errorText = ''
      try {
        const appUrl = (Deno.env.get('APP_URL') ?? '').trim()
        const response = await fetch(`${apiBase}/v2/groups/${encodeURIComponent(note.group_openid)}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `QQBot ${tokenData.access_token}` },
          body: JSON.stringify({ msg_type: 0, content: `【财务报销平台】有新的「${note.event}」动态，请相关成员登录平台查看。${appUrl ? `\n${appUrl}` : ''}` }),
          signal: AbortSignal.timeout(5000),
        })
        const result = await response.json().catch(() => ({}))
        if (response.status === 429) {
          throttle = true
          if (await settle({ status: 'pending', attempts: note.attempts - 1, next_attempt_at: new Date(Date.now() + 600000).toISOString(), last_error: 'QQ服务限频，10分钟后重试' })) retried++
          continue
        }
        // HTTP 200 也必须有消息 ID；只记录状态/错误码，避免上游响应泄露密钥。
        if (!response.ok || !result.id || [result.code, result.err_code].some((code) => code != null && Number(code) !== 0)) errorText = `QQ发送失败：HTTP ${response.status}，code ${String(result.code ?? result.err_code ?? 'unknown').slice(0, 40)}（请检查群主动消息权限、OpenID及IP白名单）`
      } catch { errorText = 'QQ服务请求失败或超时' }
      if (!errorText) {
        if (await settle({ status: 'sent', sent_at: new Date().toISOString(), last_error: '' })) sent++
      } else {
        const exhausted = note.attempts >= 5
        if (await settle({ status: exhausted ? 'failed' : 'pending', last_error: errorText, next_attempt_at: new Date(Date.now() + Math.min(2 ** note.attempts, 60) * 60000).toISOString() })) {
          if (exhausted) failed++; else retried++
        }
      }
    }
    await audit(actorId, '发送QQ提醒', `发送 ${sent} 条，失败 ${failed} 条，重试 ${retried} 条，暂缓 ${deferred} 条`)
    return { sent, failed, retried, deferred }
  }

  if (action === 'public_settings') {
    const { data, error } = await admin.from('settings').select('registration_enabled').eq('id', 1).single()
    if (error) throw new Error('注册设置读取失败。')
    return ok(data)
  }

  if (action === 'register') {
    // 注册没有账号维度可言（账号可能还不存在），所以只按来源 IP 限流：阈值比登录的账号维度松（20 次），
    // 同一个出口 IP 下多名同学正常注册不会互相连坐，但足以挡住脚本批量刷号。
    const ip = clientIp(req)
    const gate = await rpc('app_login_gate', { p_username: '', p_ip: ip }) as { blocked?: boolean, retry_after_seconds?: number }
    if (gate?.blocked) throw new HttpError(`注册尝试过于频繁，请在 ${Number(gate.retry_after_seconds ?? 0)} 秒后重试。`, 429)
    const username = requiredString(body.username, '请输入用户名。')
    let result
    try {
      result = await rpc('app_create_user', {
        p_username: username,
        p_password: requiredString(body.password, '请输入密码。'),
        p_full_name: String(body.full_name ?? '').trim(),
        p_department: String(body.department ?? '').trim(),
      })
    } catch (error) {
      // 失败也要记账：否则反复提交非法用户名或重复用户名可以无限高速试探。
      // 注册只按 IP 维度记账（p_scope='ip'）：此时账号可能还不存在，拿用户名当账号维度没有意义。
      // 密码原文既不落日志也不进审计，这里只传布尔值。
      await rpc('app_login_record_attempt', { p_username: username, p_password_correct: false, p_ip: ip, p_scope: 'ip' })
      throw error
    }
    await rpc('app_login_record_attempt', { p_username: username, p_password_correct: true, p_ip: ip, p_scope: 'ip' })
    const session = await issueSession(result.id, admin)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'login') {
    const username = requiredString(body.username, '请输入用户名。')
    const password = requiredString(body.password, '请输入密码。')
    const ip = clientIp(req)

    // 1) 限流检查必须在密码校验之前：命中限流时就完全不执行 crypt()，
    //    这样暴力尝试不能无限高速消耗密码哈希的算力（验收标准第一条）。
    const gate = await rpc('app_login_gate', { p_username: username, p_ip: ip }) as { blocked?: boolean, retry_after_seconds?: number }
    if (gate?.blocked) {
      // 明确告知还要等多久：触发限流本身已经说明这个账号正在被异常对待，
      // 而「账号是否存在」在下面的 401 分支里依然完全不区分。
      throw new HttpError(`登录尝试过于频繁，请在 ${Number(gate.retry_after_seconds ?? 0)} 秒后重试。`, 429)
    }

    // 2) 正常校验。
    const result = await rpc('app_login', { p_username: username, p_password: password })

    if (!result) {
      // 3) 记失败（账号与 IP 两个维度各自原子自增），并写一条不含密码、不透露账号是否存在的审计事件。
      const recorded = await rpc('app_login_record_attempt', { p_username: username, p_password_correct: false, p_ip: ip }) as { throttled?: boolean, retry_after_seconds?: number } | null
      await audit(null, '登录失败', '用户名 @' + username)
      // 跨过阈值的那一次就直接返回限流，而不是「先报密码错、下一次才 429」：
      // 后者会让攻击者从响应差异里判断出账号是否已进入锁定状态。
      if (recorded?.throttled) {
        throw new HttpError(`登录尝试过于频繁，请在 ${Number(recorded.retry_after_seconds ?? 0)} 秒后重试。`, 429)
      }
      throw new HttpError('用户名或密码不正确。', 401)
    }

    // 4) 成功：清零账号维度的失败计数（IP 维度不清零，见迁移里的说明），再发会话。
    await rpc('app_login_record_attempt', { p_username: username, p_password_correct: true, p_ip: ip })
    admin = createAdmin(req, requestId, action, result.id)
    const session = await issueSession(result.id, admin)
    await audit(result.id, '登录账号', '用户 @' + result.username)
    return ok({ user: result, roles: result.roles ?? [], session })
  }

  if (action === 'logout') {
    const actor = await actorFromRequest(req, admin)
    admin = createAdmin(req, requestId, action, actor.user.id)
    await audit(actor.user.id, '退出账号', '用户 @' + actor.user.username)
    await admin.from('app_sessions').delete().eq('token_hash', await sha256Hex(actor.token))
    return ok(null)
  }

  // 定时任务没有用户会话：pg_cron（或控制台 Scheduled Functions）只能调用“消费提醒队列”这一个动作，
  // 并且必须携带与 Edge Function 密钥 CRON_SECRET 完全相同的 x-app-cron 头；其它动作一律要求登录。
  const cronHeader = (req.headers.get('x-app-cron') ?? '').trim()
  if (action === 'send_notifications' && cronHeader) {
    const cronSecret = (Deno.env.get('CRON_SECRET') ?? '').trim()
    if (!cronSecret || !sameSecret(cronHeader, cronSecret)) throw new HttpError('定时密钥不正确。', 401)
    admin = createAdmin(req, requestId, action)
    // QQ 异常单独记账，仍继续消费邮件。
    try { await drainQqNotifications(null) } catch {
      try { await audit(null, '发送QQ提醒失败', 'QQ服务或队列处理失败，请检查服务端配置和队列错误。') }
      catch { console.error('QQ提醒失败日志保存失败') }
    }
    return await drainNotifications(null)
  }

  const actor = await actorFromRequest(req, admin)
  admin = createAdmin(req, requestId, action, actor.user.id)

  if (action === 'me') return ok({ user: actor.user, roles: actor.roles })

  if (action === 'list_applications') {
    const scope = body.scope === 'team' ? 'team' : 'mine'
    if (scope === 'team' && actor.roles.length === 0) throw new HttpError('没有工作台权限。', 403)
    let query = admin.from('applications').select('*').order('updated_at', { ascending: false })
    if (scope === 'mine') query = query.eq('owner_id', actor.user.id)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return ok(data ?? [])
  }

  if (action === 'create_application') {
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new HttpError('请输入有效金额。')
    const payload = {
      owner_id: actor.user.id,
      title: requiredString(body.title, '请输入申请标题。').slice(0, 120),
      purpose: requiredString(body.purpose, '请输入用途说明。').slice(0, 5000),
      amount,
      category: requiredString(body.category, '请输入费用类别。').slice(0, 80),
      department: requiredString(body.department, '请输入部门或活动。').slice(0, 80),
      use_date: requiredString(body.use_date, '请选择使用日期。'),
      status: 'draft',
      version: 0,
    }
    const { data, error } = await admin.from('applications').insert(payload).select().single()
    if (error) throw new Error(error.message)
    return ok(data)
  }

  if (action === 'update_application') {
    const id = requiredString(body.id, '缺少申请编号。')
    const payload = {
      title: requiredString(body.title, '请输入申请标题。').slice(0, 120),
      purpose: requiredString(body.purpose, '请输入用途说明。').slice(0, 5000),
      amount: Number(body.amount),
      category: requiredString(body.category, '请输入费用类别。').slice(0, 80),
      department: requiredString(body.department, '请输入部门或活动。').slice(0, 80),
      use_date: requiredString(body.use_date, '请选择使用日期。'),
    }
    if (!Number.isFinite(payload.amount) || payload.amount <= 0 || payload.amount > 10000000) throw new HttpError('请输入有效金额。')
    const { data, error } = await admin.from('applications').update(payload).eq('id', id).eq('owner_id', actor.user.id).in('status', ['draft', 'changes_requested', 'cancelled']).select().single()
    if (error) throw new Error(error.message)
    return ok(data)
  }

  if (action === 'get_application') {
    const id = requiredString(body.id, '缺少申请编号。')
    const { data: application, error: applicationError } = await admin.from('applications').select('*').eq('id', id).maybeSingle()
    if (applicationError) throw new Error(applicationError.message)
    if (!application || (application.owner_id !== actor.user.id && actor.roles.length === 0)) throw new HttpError('申请不存在或无权查看。', 404)
    const [profileResult, fileResult, actionResult, paymentResult] = await Promise.all([
      admin.from('profiles').select('full_name').eq('id', application.owner_id).maybeSingle(),
      admin.from('application_files').select('*').eq('application_id', id).is('removed_at', null).order('created_at'),
      admin.from('approval_actions').select('*').eq('application_id', id).order('created_at', { ascending: false }),
      admin.from('payments').select('*').eq('application_id', id).maybeSingle(),
    ])
    if (fileResult.error || actionResult.error || paymentResult.error) throw new Error('申请详情读取失败。')
    const visibleFiles = (fileResult.data ?? []).filter((file) => !file.pending ||
      (file.kind === 'qr' && application.owner_id === actor.user.id) ||
      (file.kind === 'receipt' && hasRole(actor, 'cashier')))
    return ok({ application, ownerName: profileResult.data?.full_name ?? '成员', files: visibleFiles, actions: actionResult.data ?? [], payment: paymentResult.data ?? null })
  }

  if (['submit_application', 'approve_application', 'return_application', 'reject_application', 'cancel_application'].includes(action)) {
    const functionName = `app_${action}`
    await rpc(functionName, { p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id, p_note: String(body.note ?? '').trim() })
    return ok(null)
  }

  if (action === 'remove_file') {
    await rpc('app_remove_application_file', {
      p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id,
      p_file_id: requiredString(body.file_id, '缺少文件编号。'),
    })
    return ok(null)
  }

  if (action === 'save_file_draft' || action === 'submit_file_draft') {
    const args = {
      p_application_id: requiredString(body.application_id, '缺少申请编号。'), p_actor_id: actor.user.id,
      p_file_id: requiredString(body.file_id, '请先选择并保存文件。'), p_value: String(body.value ?? '').trim(),
    }
    if (action === 'save_file_draft') await rpc('app_update_workflow_draft', args)
    else await rpc('app_submit_workflow_file', { ...args, p_confirmed: body.confirmed === true })
    return ok(null)
  }

  if (action === 'upload_file') {
    const file = body.file
    if (!(file instanceof File)) throw new HttpError('请选择文件。')
    if (!file.size || file.size > 5 * 1024 * 1024) throw new HttpError('文件不能为空或超过 5 MB。')
    const applicationId = requiredString(body.application_id, '缺少申请编号。')
    const kind = requiredString(body.kind, '缺少文件类型。')
    if (!['attachment', 'qr', 'receipt'].includes(kind)) throw new HttpError('文件类型不支持。')
    if (!['image/png', 'image/jpeg', 'application/pdf'].includes(file.type) || (kind === 'qr' && file.type === 'application/pdf')) throw new HttpError('请选择 PNG、JPG 图片或 PDF 文件。')
    const { data: application, error: applicationError } = await admin.from('applications').select('id,owner_id,status').eq('id', applicationId).maybeSingle()
    if (applicationError || !application) throw new HttpError('申请不存在。', 404)
    if (kind === 'attachment' && (application.owner_id !== actor.user.id || !['draft','changes_requested','cancelled','finance_pending','chair_pending','payment_info_required','payment_pending'].includes(application.status))) throw new HttpError('当前不能修改申请附件。', 403)
    if (kind === 'qr' && (application.owner_id !== actor.user.id || !['payment_info_required','payment_pending'].includes(application.status))) throw new HttpError('当前不能修改收款信息。', 403)
    if (kind === 'receipt' && (!hasRole(actor, 'cashier') || !['payment_pending','paid'].includes(application.status))) throw new HttpError('没有付款登记权限。', 403)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file'
    const storagePath = `${application.owner_id}/${applicationId}/${kind}-${crypto.randomUUID()}-${safeName}`
    const upload = await admin.storage.from(bucket).upload(storagePath, new Uint8Array(await file.arrayBuffer()), { upsert: false, contentType: file.type || 'application/octet-stream' })
    if (upload.error) throw new Error(upload.error.message)
    let fileId
    try {
      fileId = await rpc('app_save_workflow_file', {
        p_application_id: applicationId, p_actor_id: actor.user.id, p_kind: kind,
        p_storage_path: storagePath, p_name: file.name, p_mime: file.type,
        p_value: String(body.value ?? (kind === 'qr' ? body.recipient : body.reference) ?? '').trim(),
      })
    } catch (error) {
      await admin.storage.from(bucket).remove([storagePath])
      throw error
    }
    return ok({ path: storagePath, file_id: fileId })
  }

  if (action === 'file_url') {
    const path = requiredString(body.path, '缺少文件地址。')
    const { data: file, error: fileError } = await admin.from('application_files').select('application_id,owner_id,kind,pending').eq('storage_path', path).is('removed_at', null).maybeSingle()
    if (fileError || !file) throw new HttpError('文件不存在。', 404)
    if (file.owner_id !== actor.user.id && actor.roles.length === 0) throw new HttpError('没有权限。', 403)
    if (file.pending && !((file.kind === 'qr' && file.owner_id === actor.user.id) || (file.kind === 'receipt' && hasRole(actor, 'cashier')))) throw new HttpError('没有草稿文件查看权限。', 403)
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, 300)
    if (error) throw new Error(error.message)
    return ok({ signedUrl: data.signedUrl })
  }

  if (action === 'admin_data') {
    requireRole(actor, 'admin')
    const emailServiceReady = Boolean((Deno.env.get('EMAIL_API_URL') ?? '').trim() && (Deno.env.get('EMAIL_API_KEY') ?? '').trim() && (Deno.env.get('EMAIL_FROM') ?? '').trim())
    const [settingResult, auditResult, pendingResult, sendingResult, sentResult, failedResult, cancelledResult] = await Promise.all([
      admin.from('settings').select('threshold,registration_enabled,email_notify_enabled,email_notify_events,qq_notify_enabled,qq_group_openid,qq_notify_events').eq('id', 1).single(),
      rpc('app_list_audit_logs', { p_actor_id: actor.user.id, p_page_size: 50 }),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'sending'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
      admin.from('notifications').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
    ])
    // 队列统计同样是管理面板的一部分：任何一个查询失败都要报错，不能静默显示 0 封。
    // auditResult 来自 rpc()：失败时 helper 直接抛 HttpError，恒无 .error；保留在条件里只为让"任一项失败即整体报错"一眼可读。
    if (settingResult.error || auditResult.error || pendingResult.error || sendingResult.error || sentResult.error || failedResult.error || cancelledResult.error) throw new Error('管理数据读取失败。')
    const failuresResult = await admin.from('notifications')
      .select('id,event,application_id,recipient_user_id,attempts,last_error,created_at')
      .eq('status', 'failed').order('id', { ascending: false }).limit(5)
    if (failuresResult.error) throw new Error('通知队列读取失败。')
    const failureRows = failuresResult.data ?? []
    const recipientsResult = failureRows.length ? await admin.from('app_users').select('id,username').in('id', [...new Set(failureRows.map((row) => row.recipient_user_id))]) : { data: [], error: null }
    if (recipientsResult.error) throw new Error('用户信息读取失败。')
    const failureNames = new Map((recipientsResult.data ?? []).map((user) => [user.id, user.username]))
    // 失败明细只回传事件、尝试次数、原因和账号名，不回传邮箱地址。
    const failures = failureRows.map((row) => ({ id: row.id, event: row.event, attempts: row.attempts, last_error: row.last_error, username: failureNames.get(row.recipient_user_id) ?? '成员', created_at: row.created_at }))
    const qqResult = await admin.from('qq_notifications').select('id,event,status,attempts,last_error').in('status', ['pending','sending','failed']).order('id', { ascending: false }).limit(10)
    if (qqResult.error) throw new Error('QQ提醒队列读取失败。')
    return ok({
      qq_notify_enabled: settingResult.data.qq_notify_enabled,
      qq_group_openid: settingResult.data.qq_group_openid,
      qq_notify_events: settingResult.data.qq_notify_events,
      qq_service_configured: Boolean(Deno.env.get('QQ_BOT_APP_ID') && Deno.env.get('QQ_BOT_APP_SECRET')),
      qq_queue: qqResult.data,
      threshold: settingResult.data.threshold,
      registration_enabled: settingResult.data.registration_enabled,
      email_notify_enabled: settingResult.data.email_notify_enabled,
      email_notify_events: Array.isArray(settingResult.data.email_notify_events) ? settingResult.data.email_notify_events : [],
      email_service_configured: emailServiceReady,
      notifications: { pending: pendingResult.count ?? 0, sending: sendingResult.count ?? 0, sent: sentResult.count ?? 0, failed: failedResult.count ?? 0, cancelled: cancelledResult.count ?? 0 },
      failures,
      // 日志走与列表、导出同一个共享投影：普通管理员只拿到受限字段，权限判定不在 API 里重写一份。
      audit: auditResult.logs,
      scope: auditResult.scope,
    })
  }

  if (action === 'admin_members') {
    requireRole(actor, 'admin')
    const result = await rpc('app_list_members', {
      p_actor_id: actor.user.id, p_query: String(body.query ?? '').trim(),
      p_role: String(body.role ?? ''), p_active: String(body.active ?? ''),
      p_page: Number(body.page ?? 1), p_page_size: Number(body.page_size ?? 10),
    })
    // 只回传“是否已绑定”，邮箱地址本身不进入管理列表。
    const ids = (result?.profiles ?? []).map((row) => row.id)
    if (ids.length) {
      const { data: emailRows, error: emailError } = await admin.from('app_users').select('id,email').in('id', ids)
      if (emailError) throw new Error('用户信息读取失败。')
      const bound = new Set((emailRows ?? []).filter((row) => row.email).map((row) => row.id))
      result.profiles = result.profiles.map((row) => ({ ...row, has_email: bound.has(row.id) }))
    }
    return ok(result)
  }

  // Issue #7: search, filter and page the audit log on the server instead of
  // shipping every row to the browser.
  if (action === 'admin_audit') {
    requireRole(actor, 'admin')
    const { filters, page, pageSize, snapshot } = readAuditFilters(body, true)
    const [paged, events] = await Promise.all([
      rpc('app_list_audit_logs', {
        p_actor_id: actor.user.id, p_username: filters.username, p_event: filters.event,
        p_ip: filters.ip, p_start: filters.start, p_end: filters.end,
        p_page: page, p_page_size: pageSize, p_snapshot: snapshot,
      }),
      rpc('app_audit_log_events', { p_actor_id: actor.user.id }),
    ])
    return ok({ ...(paged as Record<string, unknown>), events: Array.isArray(events) ? events : [], filters })
  }

  if (action === 'update_registration') {
    requireRole(actor, 'admin')
    if (typeof body.enabled !== 'boolean') throw new HttpError('请选择是否允许注册。')
    await rpc('app_update_registration', { p_actor_id: actor.user.id, p_enabled: body.enabled })
    return ok(null)
  }

  if (action === 'admin_create_user') {
    requireRole(actor, 'admin')
    const result = await rpc('app_admin_create_user', {
      p_actor_id: actor.user.id, p_username: requiredString(body.username, '请输入用户名。'),
      p_password: requiredString(body.password, '请输入初始密码。'), p_full_name: requiredString(body.full_name, '请输入姓名。'),
      p_department: String(body.department ?? '').trim(), p_roles: Array.isArray(body.roles) ? body.roles : [],
      p_email: String(body.email ?? '').trim(),
    })
    return ok(result)
  }

  if (action === 'export_audit') {
    requireRole(actor, 'admin')
    const { filters, snapshot: requestedSnapshot } = readAuditFilters(body, false)
    const rows: Record<string, unknown>[] = []
    let snapshot = requestedSnapshot, scope = ''
    for (let page = 1; ; page++) {
      const batch = await rpc('app_list_audit_logs', {
        p_actor_id: actor.user.id, p_username: filters.username, p_event: filters.event,
        p_ip: filters.ip, p_start: filters.start, p_end: filters.end,
        p_page: page, p_page_size: 1000, p_snapshot: snapshot,
      })
      if (batch.total > 100000) throw new HttpError('数据较多，请缩小筛选范围后导出。')
      snapshot = batch.snapshot
      scope = batch.scope
      rows.push(...batch.logs)
      if (rows.length >= batch.total) break
    }
    await audit(actor.user.id, '导出操作日志', `${auditFilterSummary(filters) || '全部'} · ${rows.length} 条`, { filters, count: rows.length })
    return ok({ rows, start: filters.start, end: filters.end, filters, snapshot, scope, generated_at: new Date().toISOString() })
  }

  if (action === 'export_financial') {
    requireRole(actor, 'admin')
    const { filters } = readAuditFilters(body, false)
    const { start, end } = filters
    const rows: Record<string, any>[] = []
    for (let offset = 0; ; offset += 1000) {
      let query = admin.from('payments').select('*,applications(*)').order('created_at').order('application_id').range(offset, offset + 999)
      if (start) query = query.gte('created_at', start + 'T00:00:00+08:00')
      if (end) query = query.lt('created_at', new Date(Date.parse(end + 'T00:00:00+08:00') + 86400000).toISOString())
      const { data, error } = await query
      if (error) throw new Error('导出数据读取失败。')
      rows.push(...(data ?? []))
      if ((data ?? []).length < 1000) break
      if (rows.length >= 100000) throw new HttpError('数据较多，请缩小日期范围后导出。')
    }
    const { data: users, error } = await admin.from('app_users').select('id,username,full_name')
    if (error) throw new Error('用户信息读取失败。')
    const userMap = new Map((users ?? []).map((u) => [u.id, u]))
    const result = rows.map((row) => ({ ...row, applicant: userMap.get(row.applications?.owner_id)?.full_name || '', username: userMap.get(row.applications?.owner_id)?.username || '', operator: userMap.get(row.actor_id)?.username || '' }))
    await audit(actor.user.id, '导出财报', `${start || '全部'} 至 ${end || '现在'} · ${result.length} 条`, { start, end, count: result.length })
    return ok({ rows: result, start, end, generated_at: new Date().toISOString() })
  }

  if (action === 'set_member_roles') {
    requireRole(actor, 'admin')
    await rpc('app_set_member_roles', { p_actor_id: actor.user.id, p_user_id: requiredString(body.user_id, '缺少成员编号。'), p_roles: Array.isArray(body.roles) ? body.roles : [], p_active: Boolean(body.active) })
    return ok(null)
  }

  if (action === 'update_threshold') {
    requireRole(actor, 'admin')
    await rpc('app_update_approval_threshold', { p_actor_id: actor.user.id, p_threshold: Number(body.threshold) })
    return ok(null)
  }

  if (action === 'bind_email') {
    // 收件人只能是当前登录账号自己；请求体里的任何用户编号都不参与绑定，数据库层也会再校验一次。
    await rpc('app_bind_email', { p_actor_id: actor.user.id, p_user_id: actor.user.id, p_email: String(body.email ?? '').trim() })
    return ok(null)
  }

  if (action === 'update_qq_notify') {
    requireRole(actor, 'admin')
    if (typeof body.enabled !== 'boolean' || !Array.isArray(body.events) || body.events.length > 7) throw new HttpError('QQ提醒设置无效。')
    await rpc('app_update_qq_notify', { p_actor_id: actor.user.id, p_enabled: body.enabled, p_group_openid: String(body.group_openid ?? '').trim(), p_events: body.events.map(String) })
    return ok(null)
  }
  if (action === 'reset_qq_notifications') {
    requireRole(actor, 'admin')
    return ok({ reset: await rpc('app_reset_qq_notifications', { p_actor_id: actor.user.id }) })
  }
  if (action === 'send_qq_notifications') {
    requireRole(actor, 'admin')
    return ok(await drainQqNotifications(actor.user.id))
  }

  if (action === 'update_email_notify') {
    requireRole(actor, 'admin')
    if (typeof body.enabled !== 'boolean') throw new HttpError('请选择是否启用邮件通知。')
    // 提醒类型必须是数组：缺字段时宁可报错，也不要静默把已勾选的类型清空。
    // 合法枚举与顺序由数据库规范化并校验（app_update_email_notify），前端传什么顺序都不影响判定。
    if (!Array.isArray(body.events)) throw new HttpError('请选择要发送的提醒类型。')
    const events = body.events.map((item) => String(item))
    if (events.length > 7) throw new HttpError('提醒类型无效。')
    await rpc('app_update_email_notify', { p_actor_id: actor.user.id, p_enabled: body.enabled, p_events: events })
    return ok(null)
  }

  if (action === 'send_notifications') {
    // 管理员手动消费队列；定时任务走上面的 x-app-cron 入口，两个入口共用同一个 drainNotifications。
    requireRole(actor, 'admin')
    return await drainNotifications(actor.user.id)
  }

  if (action === 'reset_notifications') {
    // 配好邮件服务后，尝试次数用满的提醒可以由管理员重新排队（失败原因保留在队列里）。
    requireRole(actor, 'admin')
    const reset = await rpc('app_reset_failed_notifications', { p_actor_id: actor.user.id })
    return ok({ reset: Number(reset ?? 0) })
  }
  if (action === 'change_password') {
    await rpc('app_change_password', { p_user_id: actor.user.id, p_current_password: requiredString(body.current_password, '请输入当前密码。'), p_new_password: requiredString(body.new_password, '请输入新密码。') })
    return ok(null)
  }

  throw new HttpError('未知操作。', 404)
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status)
    console.error(error)
    return fail(error instanceof Error ? error.message : '服务暂时不可用。', 500)
  }
})

