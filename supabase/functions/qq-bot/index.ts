// QQ 机器人的回调入口：接收群消息事件，响应 /check 指令。
//
// 这个函数必须能匿名访问（verify_jwt=false），因为 QQ 服务器不会带 Supabase 的 JWT。
// 安全性靠 QQ 官方的 Ed25519 签名：每次请求带 X-Signature-Ed25519 / X-Signature-Timestamp，
// 用 BotSecret 补齐 32 字节当 seed 复核 timestamp+body，签不上就直接 401。
//
// 回复走"被动消息"（带 msg_id + msg_seq），不消耗主动消息额度，也就不会撞 40034105。

import { createClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
const secretKey = secretKeys
  ? JSON.parse(secretKeys).default
  : (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
const appId = (Deno.env.get('QQ_BOT_APP_ID') ?? '').trim()
const appSecret = (Deno.env.get('QQ_BOT_APP_SECRET') ?? '').trim()
const cronSecret = (Deno.env.get('CRON_SECRET') ?? '').trim()
const apiBase = Deno.env.get('QQ_BOT_SANDBOX') === 'true'
  ? 'https://sandbox.api.sgroup.qq.com'
  : 'https://api.bot.qq.com'

const admin = createClient(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

const encoder = new TextEncoder()

/** 官方算法：seed = BotSecret 反复自我拼接，补齐到 32 字节后截断。 */
export function botSeed(secret: string): Uint8Array {
  if (!secret) throw new Error('QQ_BOT_APP_SECRET 未配置')
  let seed = secret
  while (encoder.encode(seed).length < 32) seed += secret
  return encoder.encode(seed).slice(0, 32)
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

// WebCrypto 把裸 32 字节的 Ed25519 当公钥，私钥必须包成 PKCS#8。
// 这段前缀是 RFC 8410 里 Ed25519 私钥的 DER 头，后面接 seed 就是合法的 pkcs8。
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

function pkcs8(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(PKCS8_PREFIX.length + seed.length)
  out.set(PKCS8_PREFIX)
  out.set(seed, PKCS8_PREFIX.length)
  return out
}

/** Ed25519 是确定性签名：同 key 同消息必然同签名，所以"重算再比对"就是验签。 */
export async function signHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8(botSeed(secret)), { name: 'Ed25519' }, false, ['sign'])
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, encoder.encode(message))
  return toHex(new Uint8Array(signature))
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifySignature(secret: string, timestamp: string, body: string, signature: string) {
  if (!secret || !timestamp || !signature) return false
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) return false
  return sameText((await signHex(secret, timestamp + body)).toLowerCase(), signature.toLowerCase())
}

/** 把群消息里的指令归一化：去掉开头的 /（也接受全角），压缩空白，转小写。 */
export function parseCommand(content: string): string {
  return content.replace(/^[\s/／]+/, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

const HELP = '可用指令：\n/check 待办汇总\n/check resend 补发提醒'

let tokenCache: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value
  const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const body = await response.json().catch(() => ({}))
  const value = String(body?.access_token ?? '')
  if (!value) throw new Error(`获取 access_token 失败：${response.status} ${JSON.stringify(body).slice(0, 200)}`)
  const ttl = Number(body?.expires_in ?? 7200)
  tokenCache = { value, expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 7200) * 1000 }
  return value
}

/** 被动回复：带 msg_id/msg_seq，跟着用户那条消息走，不占主动推送额度。 */
async function reply(groupOpenid: string, msgId: string, content: string) {
  const token = await accessToken()
  const response = await fetch(`${apiBase}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: 1 }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body?.id) {
    throw new Error(`回复失败：${response.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
  return String(body.id)
}

/** /check resend 只负责把队列排好，真正的发送复用定时任务那条路径，免得两套逻辑跑偏。 */
async function triggerDrain(): Promise<boolean> {
  if (!cronSecret) return false
  const response = await fetch(`${supabaseUrl}/functions/v1/app-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: secretKey, 'x-app-cron': cronSecret },
    body: JSON.stringify({ action: 'send_notifications' }),
  })
  return response.ok
}

async function audit(event: string, detail: string) {
  try {
    await admin.from('audit_logs').insert({ actor_id: null, event, detail })
  } catch {
    console.error('群指令日志写入失败')
  }
}

/** 每个进到本函数的请求都留痕：签名对不对、哪个群、最后做了什么。 */
async function trace(entry: {
  op?: number, eventType?: string, groupOpenid?: string,
  signatureOk: boolean, outcome: string, detail?: string,
}) {
  try {
    await admin.from('qq_webhook_log').insert({
      op: entry.op ?? null,
      event_type: entry.eventType ?? '',
      group_openid: entry.groupOpenid ?? '',
      signature_ok: entry.signatureOk,
      outcome: entry.outcome,
      detail: (entry.detail ?? '').slice(0, 500),
    })
  } catch {
    console.error('回调日志写入失败')
  }
}

async function handleEvent(d: Record<string, unknown>) {
  const groupOpenid = String(d?.group_openid ?? '')
  const msgId = String(d?.id ?? '')
  const content = String(d?.content ?? '')
  if (!groupOpenid || !msgId) return

  // 提醒目标群始终允许；另外可在设置里加白名单群（指令和提醒是两件事）。
  const { data: settings } = await admin
    .from('settings').select('qq_group_openid,qq_command_groups').eq('id', 1).maybeSingle()
  const extra = Array.isArray(settings?.qq_command_groups) ? settings!.qq_command_groups as string[] : []
  const allowed = [settings?.qq_group_openid ?? '', ...extra].filter(Boolean)
  if (!allowed.includes(groupOpenid)) {
    await trace({
      eventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid, signatureOk: true,
      outcome: '群不匹配，已忽略', detail: `收到=${groupOpenid} 允许=${allowed.join(',') || '(无)'}`,
    })
    return
  }

  const command = parseCommand(content)
  let text = HELP

  if (command === 'check' || command === '检查') {
    const { data, error } = await admin.rpc('app_qq_check_report')
    text = error ? '待办检查失败，请稍后再试。' : String(data ?? '')
  } else if (command === 'check resend' || command === 'check 补发') {
    const { data, error } = await admin.rpc('app_qq_resend')
    if (error) {
      text = '补发失败，请稍后再试。'
    } else if (!data?.ok) {
      text = `无法补发：${data?.reason ?? '未知原因'}`
    } else {
      const drained = await triggerDrain()
      text = `【补发提醒】\n新排队 ${data.enqueued ?? 0} 条，恢复失败 ${data.failed ?? 0} 条，当前待发 ${data.pending ?? 0} 条`
        + (drained ? '\n已开始发送。' : '\n队列已排好，但触发发送失败，请稍后重试。')
    }
  }

  try {
    await reply(groupOpenid, msgId, text)
    await audit('QQ群指令', `${command || '(空)'} · ${groupOpenid.slice(0, 8)}…`)
    await trace({
      eventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid, signatureOk: true,
      outcome: '已回复', detail: `指令=${command || '(空)'}`,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('群指令处理失败', reason)
    await audit('QQ群指令失败', reason.slice(0, 300))
    await trace({
      eventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid, signatureOk: true,
      outcome: '回复失败', detail: reason,
    })
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('ok', { status: 200 })

  const raw = await request.text()
  if (raw.length > 256 * 1024) return new Response('payload too large', { status: 413 })

  const signature = request.headers.get('x-signature-ed25519') ?? ''
  const timestamp = request.headers.get('x-signature-timestamp') ?? ''
  if (!(await verifySignature(appSecret, timestamp, raw, signature))) {
    EdgeRuntime.waitUntil(trace({ signatureOk: false, outcome: '签名校验失败', detail: raw }))
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch {
    EdgeRuntime.waitUntil(trace({ signatureOk: true, outcome: '请求体不是 JSON', detail: raw }))
    return new Response('bad json', { status: 400 })
  }

  // op 13：开放平台验证回调地址，必须把 plain_token 签回去。
  if (payload.op === 13) {
    const d = payload.d as Record<string, unknown> | undefined
    const plainToken = String(d?.plain_token ?? '')
    const eventTs = String(d?.event_ts ?? '')
    const sign = await signHex(appSecret, eventTs + plainToken)
    EdgeRuntime.waitUntil(trace({ op: 13, signatureOk: true, outcome: '回调地址验证', detail: raw }))
    return new Response(JSON.stringify({ plain_token: plainToken, signature: sign }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  // 群 @ 机器人的消息。必须尽快回 200，真正的处理放到后台，否则 QQ 会重推。
  if (payload.t === 'GROUP_AT_MESSAGE_CREATE') {
    const d = payload.d as Record<string, unknown> | undefined
    if (d) EdgeRuntime.waitUntil(handleEvent(d))
  }
  return new Response(JSON.stringify({ op: 12, d: {} }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
})
