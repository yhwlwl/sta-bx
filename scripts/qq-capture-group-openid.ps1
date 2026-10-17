# 抓取 QQ 群 OpenID（group_openid），用于 STA-BX「设置 → QQ 群提醒」。
#
# 官方没有"列出机器人所在群"的接口，group_openid 只能从群事件里读到。
# 本脚本用 WebSocket 网关订阅 GROUP_AND_C2C_EVENT(intents = 1<<25)，收到群事件时打印 group_openid。
# 只依赖 Windows 自带 PowerShell（5.1 亦可），不需要 Node / npm。
#
# 用法（在仓库根目录）：
#   $env:QQ_BOT_APP_ID='你的AppID'
#   $env:QQ_BOT_APP_SECRET='你的AppSecret'
#   powershell -ExecutionPolicy Bypass -File scripts\qq-capture-group-openid.ps1
#
# 然后在群里 @ 机器人一次；如果机器人还没进群，先把它拉进群（会产生 GROUP_ADD_ROBOT）。
# AppSecret 只在本机内存里用于换 token，不要提交到仓库或贴进聊天。

[CmdletBinding()]
param(
  [string]$AppId = $env:QQ_BOT_APP_ID,
  [string]$AppSecret = $env:QQ_BOT_APP_SECRET,
  [int]$TimeoutSeconds = 300,
  [string]$OutFile = '',
  # 抓「成员在群里的 member_openid」（用于 @ 到人），而不是 group_openid
  [switch]$Member
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

if (-not $AppId -or -not $AppSecret) {
  Write-Host '缺少 AppID / AppSecret。请先设置环境变量：' -ForegroundColor Red
  Write-Host '  $env:QQ_BOT_APP_ID=''xxx''; $env:QQ_BOT_APP_SECRET=''yyy'''
  exit 1
}

# ---- 1. 换 access_token -------------------------------------------------
# 官方在失败时也返回 HTTP 200，错误码在 body 的 code 里，所以必须两个都判断。
Write-Host '[1/3] 获取 access_token ...' -ForegroundColor Cyan
$token = $null
try {
  $resp = Invoke-WebRequest -Method Post -Uri 'https://api.bot.qq.com/app/getAppAccessToken' `
    -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20 `
    -Body (@{ appId = $AppId; clientSecret = $AppSecret } | ConvertTo-Json -Compress)
  # PS 5.1 在响应头没有 charset 时按 ISO-8859-1 解码，中文 message 会乱码 → 自己按 UTF-8 解
  $stream = $resp.RawContentStream
  if ($stream -and $stream.CanSeek) { $stream.Position = 0 } else { $stream = $null }
  $json = if ($stream) { [Text.Encoding]::UTF8.GetString($stream.ToArray()) } else { $resp.Content }
  $token = $json | ConvertFrom-Json
} catch {
  Write-Host "请求失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
if (-not $token.access_token) {
  Write-Host "认证失败：code=$($token.code) message=$($token.message)" -ForegroundColor Red
  Write-Host '  100016 = AppID/Secret 不匹配；100007 = AppID 无效或机器人被封禁/删除。' -ForegroundColor Yellow
  exit 1
}
Write-Host "      OK（有效期 $($token.expires_in) 秒）" -ForegroundColor Green

# ---- 2. 取网关地址 ------------------------------------------------------
Write-Host '[2/3] 获取 WSS 接入点 ...' -ForegroundColor Cyan
try {
  $gw = Invoke-RestMethod -Method Get -Uri 'https://api.bot.qq.com/gateway' `
    -Headers @{ Authorization = "QQBot $($token.access_token)" } -TimeoutSec 20
} catch {
  Write-Host "获取网关失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
if (-not $gw.url) { Write-Host '网关地址为空。' -ForegroundColor Red; exit 1 }
Write-Host "      $($gw.url)" -ForegroundColor DarkGray

# ---- 3. 连网关、鉴权、等群事件 ------------------------------------------
$INTENTS = 1 -shl 25                      # GROUP_AND_C2C_EVENT = 33554432
$GROUP_EVENTS = @(
  'GROUP_ADD_ROBOT', 'GROUP_AT_MESSAGE_CREATE',
  'GROUP_MSG_RECEIVE', 'GROUP_MSG_REJECT', 'GROUP_DEL_ROBOT'
)

function Send-Payload($socket, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 6))
  $socket.SendAsync([ArraySegment[byte]]::new($bytes),
    [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
    [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
}

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
Write-Host '[3/3] 连接网关 ...' -ForegroundColor Cyan
if (-not $ws.ConnectAsync([Uri]$gw.url, [Threading.CancellationToken]::None).Wait(15000)) {
  Write-Host '连接超时。' -ForegroundColor Red; exit 1
}
Write-Host '      已连接，等待 Hello ...' -ForegroundColor Green

$buffer = New-Object byte[] 16384
$pending = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$heartbeatMs = 30000
$lastHeartbeat = Get-Date
$identified = $false
$lastSeq = $null
$recv = $null

while ((Get-Date) -lt $deadline -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {

  # 关键：接收永不取消。Task.Wait(500) 超时只是"等 500ms 后返回 false"，任务本身继续挂起。
  # 用 CancellationToken 取消挂起的 ReceiveAsync 会让 .NET Framework 直接 Abort() 整个 socket。
  if ($null -eq $recv) {
    $recv = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None)
  }
  $done = $false
  try { $done = $recv.Wait(500) } catch { $done = $true }
  if (-not $done) {
    if ($identified -and ((Get-Date) - $lastHeartbeat).TotalMilliseconds -ge $heartbeatMs) {
      Send-Payload $ws @{ op = 1; d = $lastSeq }
      $lastHeartbeat = Get-Date
    }
    continue
  }
  if ($recv.IsFaulted) {
    Write-Host "接收失败：$($recv.Exception.InnerException.Message)" -ForegroundColor Red
    break
  }
  if ($recv.IsCanceled) { Write-Host '接收被取消。' -ForegroundColor Yellow; break }

  $frame = $recv.Result
  $recv = $null
  if ($frame.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
    Write-Host "服务端关闭连接（$($ws.CloseStatus)：$($ws.CloseStatusDescription)）。" -ForegroundColor Yellow
    break
  }
  [void]$pending.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $frame.Count))
  if (-not $frame.EndOfMessage) { continue }

  $raw = $pending.ToString(); [void]$pending.Clear()
  if (-not $raw.Trim()) { continue }
  try { $msg = $raw | ConvertFrom-Json } catch { continue }
  if ($null -ne $msg.s) { $lastSeq = $msg.s }

  switch ($msg.op) {
    10 {                                  # Hello → Identify
      if ($msg.d.heartbeat_interval) { $heartbeatMs = [int]$msg.d.heartbeat_interval }
      Send-Payload $ws @{
        op = 2
        d  = @{
          token      = "QQBot $($token.access_token)"
          intents    = $INTENTS
          shard      = @(0, 1)
          properties = @{ '$os' = 'windows'; '$browser' = 'pwsh'; '$device' = 'pwsh' }
        }
      }
    }
    0 {                                   # Dispatch
      if ($msg.t -eq 'READY') {
        $identified = $true
        Write-Host "      鉴权成功：$($msg.d.user.username)" -ForegroundColor Green
        Write-Host '      现在去群里 @ 机器人一次（或把它拉进群）...' -ForegroundColor Yellow
      } elseif ($GROUP_EVENTS -contains $msg.t) {
        $gid = $msg.d.group_openid
        if ($gid) {
          Write-Host ''
          Write-Host '=========================================================' -ForegroundColor Green
          Write-Host "  事件：$($msg.t)"
          Write-Host "  group_openid：$gid" -ForegroundColor White
          if ($msg.d.author.username) { Write-Host "  触发者：$($msg.d.author.username)" -ForegroundColor DarkGray }
          # 同一条事件里还有触发者在本群的 member_openid：这是 QQ 唯一认可的 @ 目标，
          # 把它和平台账号登记到「设置 → QQ 群提醒 → 成员绑定」，提醒就能 @ 到人。
          $mid = $msg.d.author.member_openid
          if ($mid) { Write-Host "  member_openid：$mid" -ForegroundColor White }
          Write-Host '=========================================================' -ForegroundColor Green
          $saved = if ($Member -and $mid) { $mid } else { $gid }
          if ($OutFile) {
            Set-Content -Path $OutFile -Value $saved -Encoding ascii
            Write-Host "已写入 $OutFile" -ForegroundColor Green
          }
          try { $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [Threading.CancellationToken]::None).Wait(3000) | Out-Null } catch {}
          exit 0
        }
      }
    }
    11 { }                                # Heartbeat ACK
    7  { Write-Host '服务端要求重连（op 7），请重跑脚本。' -ForegroundColor Yellow; break }
    9  { Write-Host 'Invalid Session（op 9）：token 或 intents 被拒。' -ForegroundColor Red; break }
  }
}

try { $ws.Dispose() } catch {}
Write-Host ''
Write-Host "超时（$TimeoutSeconds 秒）未收到群事件。" -ForegroundColor Yellow
Write-Host '排查顺序：① 机器人是否已在目标群 ② 是否在群里 @ 过它 ③ 控制台是否已开通"群消息"权限' -ForegroundColor Yellow
Write-Host '若 Identify 阶段被关闭（op 9 / 4013 / 4014）：说明该机器人没有事件订阅权限。' -ForegroundColor Yellow
exit 2
