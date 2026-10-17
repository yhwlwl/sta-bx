import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { ROLE_LABEL, formatDateTime, auditDetail, auditFilterSummary, downloadExport } from './reporting.js';
import { NOTIFY_QUEUE, NOTIFY_EVENTS, NOTIFY_DEFAULT_EVENTS, NOTIFY_EVENT_GROUPS, normalizeNotifyEvents } from './notify-rules.js';

const Button = ({ kind = '', children, ...props }) => <button className={`button ${kind}`} {...props}>{children}</button>;
const ErrorText = ({ children }) => children ? <div className="error-text" role="alert">{children}</div> : null;
const NO_AUDIT_FILTERS = { username: '', event: '', ip: '', start: '', end: '' };
const AUDIT_TEXT_KEYS = ['username', 'event', 'ip'];
const auditFiltersActive = (filters) => Object.values(filters).some(Boolean);

/** Page through a server-side result set with a fixed insertion boundary and deterministic ordering decided by the server. */
function Pager({ page, total, pageSize, loading, onPage, onPageSize, unit, sizeLabel, sizes = [10, 20, 50] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  return <div className="member-pagination">
    <label>每页<select aria-label={sizeLabel} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>{sizes.map((size) => <option key={size} value={size}>{size} {unit}</option>)}</select></label>
    <div><Button kind="secondary" disabled={loading || current <= 1} onClick={() => onPage(current - 1)}>上一页</Button><span>{current} / {pages}</span><Button kind="secondary" disabled={loading || current >= pages} onClick={() => onPage(current + 1)}>下一页</Button></div>
  </div>;
}

export function MemberRow({ profile, roles, busy, onSave, self = false }) {
  const protectedAccount = profile.username?.toLowerCase() === 'admin';
  const signature = [...roles].sort().join(',');
  const [selected, setSelected] = useState(new Set(roles)); const [active, setActive] = useState(profile.active);
  useEffect(() => { setSelected(new Set(signature.split(',').filter(Boolean))); setActive(profile.active); }, [profile.id, profile.active, signature]);
  return <div className="member-row"><div><strong>{profile.full_name || profile.username}</strong><p className="muted">@{profile.username} · {profile.department || '未填写部门'}{profile.has_email ? '' : ' · 未绑定邮箱'}{self ? ' · 当前账号' : ''}</p></div>
    {self || protectedAccount ? <span className="muted">{protectedAccount ? '超级管理员 · 权限已锁定' : '管理员'}</span> : <fieldset disabled={busy} className="member-roles">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={selected.has(role)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(role) : next.delete(role); setSelected(next); }} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />启用</label><Button kind="secondary" type="button" onClick={() => onSave(profile.id, [...selected], active)}>保存</Button></fieldset>}
  </div>;
}
const emptyUser = () => ({ username: '', password: '', full_name: '', department: '', email: '', roles: [] });
export function MemberDirectory({ identity, busy, revision, onSave }) {
  const [filters, setFilters] = useState({ query: '', role: '', active: '' });
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10);
  const [result, setResult] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true; setLoading(true); setError('');
    const timer = setTimeout(async () => {
      const response = await apiRequest('admin_members', { ...filters, page, page_size: pageSize });
      if (!mounted) return;
      if (response.error) { setError(response.error.message); setResult(null); } else {
        setResult(response.data);
      }
      setLoading(false);
    }, filters.query ? 250 : 0);
    return () => { mounted = false; clearTimeout(timer); };
  }, [filters.query, filters.role, filters.active, page, pageSize, revision]);
  const change = (key, value) => { setFilters((current) => ({ ...current, [key]: value })); setPage(1); };
  return <section className="panel detail-panel admin-section member-directory"><div className="heading-row"><h2>用户与权限</h2><span className="muted">{result ? `${result.total} 位用户` : ''}</span></div>
    <div className="toolbar member-toolbar"><input type="search" aria-label="搜索用户" placeholder="搜索用户名、姓名或部门" value={filters.query} maxLength="80" onChange={(e) => change('query', e.target.value)} />
      <select aria-label="用户角色筛选" value={filters.role} onChange={(e) => change('role', e.target.value)}><option value="">全部角色</option><option value="ordinary">普通用户</option>{Object.entries(ROLE_LABEL).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>
      <select aria-label="账号状态筛选" value={filters.active} onChange={(e) => change('active', e.target.value)}><option value="">全部状态</option><option value="active">已启用</option><option value="inactive">已停用</option></select>
      {(filters.query || filters.role || filters.active) && <Button kind="quiet" type="button" onClick={() => { setFilters({ query: '', role: '', active: '' }); setPage(1); }}>重置</Button>}
    </div><ErrorText>{error}</ErrorText>
    <div aria-busy={loading}>{loading ? <div className="panel-empty">加载中…</div> : result?.profiles.length ? result.profiles.map((profile) => <MemberRow key={profile.id} profile={profile} roles={new Set(profile.roles)} self={profile.id === identity.profile.id} busy={busy} onSave={onSave} />) : <div className="panel-empty">没有符合条件的用户</div>}</div>
    <Pager page={page} total={result?.total || 0} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} unit="位" sizeLabel="每页用户数" sizes={[10, 20, 50]} />
  </section>;
}

const AUDIT_OBJECT_LABEL = { api_action: '接口动作', ip_source: 'IP 来源', application_id: '申请编号', title: '申请标题', amount: '金额', status: '申请状态', file_id: '文件编号', file_name: '文件名', file_kind: '文件类型', draft_value: '草稿内容', decision: '审批结果', note: '审批意见', target_user_id: '用户编号', target_username: '目标用户', active: '账号状态', roles: '角色', changes: '字段变更', 原值: '原值', 新值: '新值', recipient: '收款人', reference: '流水号' };
const objectEntries = (metadata) => Object.entries(metadata || {}).filter(([key]) => key !== 'changes');
const objectText = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(objectText).join('、') : '—';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${AUDIT_OBJECT_LABEL[key] || key} ${objectText(item)}`).join(' · ');
  return String(value);
};

/** The complete log entry: full text, field changes and linked objects, no truncation. */
function AuditDetailDialog({ row, scope, onClose }) {
  const changes = row.metadata?.changes || {};
  const objects = objectEntries(row.metadata);
  return <div className="dialog-backdrop" role="presentation" onClick={onClose}>
    <div className="dialog-panel audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title" onClick={(e) => e.stopPropagation()}>
      <div className="heading-row"><h2 id="audit-dialog-title">日志详情</h2><Button kind="quiet" type="button" onClick={onClose}>关闭</Button></div>
      <dl className="audit-detail-list">
        <dt>编号</dt><dd className="audit-code">{String(row.id)}</dd>
        <dt>时间</dt><dd>{formatDateTime(row.created_at)}{' '}<span className="muted">北京时间</span></dd>
        <dt>用户名</dt><dd>@{row.username || '系统'}</dd>
        <dt>IP 地址</dt><dd className="audit-code">{row.ip_address || '未记录'}</dd>
        <dt>操作</dt><dd>{row.event}</dd>
        <dt>具体内容</dt><dd className="prose">{auditDetail(row) || '—'}</dd>
      </dl>
      {Object.keys(changes).length > 0 && <><h3>字段变更</h3><ul className="audit-change-list">{Object.entries(changes).map(([field, value]) => <li key={field}>{objectText({ [field]: value })}</li>)}</ul></>}
      {objects.length > 0 ? <><h3>关联对象</h3><dl className="audit-detail-list">{objects.map(([key, value]) => <React.Fragment key={key}><dt>{AUDIT_OBJECT_LABEL[key] || key}</dt><dd className={key.endsWith('_id') ? 'audit-code' : ''}>{objectText(value)}</dd></React.Fragment>)}</dl></>
        : <p className="hint">这条日志没有关联对象。</p>}
      {scope === 'limited' ? <p className="hint">当前身份只能查看操作内容；完整 IP、请求来源和关联对象仅超级管理员可见。</p> : null}
    </div>
  </div>;
}

/** Server-side audit log search: filters, time-descending paging and a per-row detail view. */
export function AuditDirectory({ identity, revision, filters, onFiltersChange, filtersRevision = 0, onSnapshotChange }) {
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [detailed, setDetailed] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const snapshotRef = useRef({ key: '', snapshot: null });
  const superAdmin = identity.profile.username?.toLowerCase() === 'admin';
  const textFilter = AUDIT_TEXT_KEYS.some((key) => filters[key]);
  useEffect(() => {
    let mounted = true; setLoading(true); setError(''); setDetailed(null);
    const key = JSON.stringify([filters, filtersRevision, refresh]);
    if (snapshotRef.current.key !== key) snapshotRef.current = { key, snapshot: null };
    const timer = setTimeout(async () => {
      const response = await apiRequest('admin_audit', { ...filters, page, page_size: pageSize, snapshot: snapshotRef.current.snapshot });
      if (!mounted) return;
      if (response.error) { setError(response.error.message); setResult(null); } else {
        snapshotRef.current.snapshot = response.data.snapshot;
        onSnapshotChange(response.data.snapshot);
        setResult(response.data);
      }
      setLoading(false);
    }, textFilter ? 250 : 0);
    return () => { mounted = false; clearTimeout(timer); };
  }, [filters.username, filters.event, filters.ip, filters.start, filters.end, page, pageSize, revision, filtersRevision, refresh]);
  const change = (key, value) => { onFiltersChange({ ...filters, [key]: value }); setPage(1); };
  const rows = result?.logs || [];
  return <section className="panel detail-panel admin-section audit-directory">
    <div className="heading-row"><h2>操作日志</h2><Button kind="quiet" type="button" onClick={() => { snapshotRef.current = { key: '', snapshot: null }; setPage(1); onSnapshotChange(null); setRefresh((value) => value + 1); }}>刷新日志</Button><span className="muted">{result ? `${result.total} 条记录${result.scope === 'limited' ? ' · 当前身份仅可查看操作内容' : ''}` : ''}</span></div>
    <div className="toolbar audit-toolbar">
      <input type="search" aria-label="搜索用户名" placeholder="用户名" value={filters.username} maxLength="80" onChange={(e) => change('username', e.target.value)} />
      <input type="search" aria-label="搜索操作名称" placeholder="操作名称" value={filters.event} maxLength="80" onChange={(e) => change('event', e.target.value)} />
      {superAdmin && <input type="search" aria-label="搜索 IP 地址" placeholder="IP 地址" value={filters.ip} maxLength="64" onChange={(e) => change('ip', e.target.value)} />}
      <label className="audit-date">开始日期<input type="date" value={filters.start} onChange={(e) => change('start', e.target.value)} /></label>
      <label className="audit-date">结束日期<input type="date" value={filters.end} onChange={(e) => change('end', e.target.value)} /></label>
      {auditFiltersActive(filters) && <Button kind="quiet" type="button" onClick={() => { onFiltersChange({ ...NO_AUDIT_FILTERS }); setPage(1); }}>重置</Button>}
    </div><ErrorText>{error}</ErrorText>
    <div aria-busy={loading}>{loading ? <div className="panel-empty">加载中…</div> : rows.length ? <div className="table-scroll audit-table"><table><thead><tr><th>时间</th><th>用户名</th><th>IP 地址</th><th>操作</th><th>具体内容</th><th><span className="sr-only">详情</span></th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}><td className="audit-time">{formatDateTime(row.created_at)}</td><td>@{row.username}</td><td className="audit-ip">{row.ip_address || '未记录'}</td><td>{row.event}</td><td className="audit-detail">{auditDetail(row) || '—'}</td><td><Button kind="quiet" type="button" onClick={() => setDetailed(row)}>查看</Button></td></tr>)}</tbody></table></div>
      : <div className="panel-empty">没有符合条件的日志</div>}</div>
    <Pager page={result?.page || page} total={result?.total || 0} pageSize={pageSize} loading={loading} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} unit="条" sizeLabel="每页日志数" sizes={[10, 20, 50, 100]} />
    {detailed && <AuditDetailDialog row={detailed} scope={result?.scope} onClose={() => setDetailed(null)} />}
  </section>;
}

export function AdminPanel({ identity }) {
  const [data, setData] = useState(null); const [threshold, setThreshold] = useState('100'); const [registration, setRegistration] = useState(true);
  const [qqNotify, setQqNotify] = useState(false);
  const [qqGroup, setQqGroup] = useState('');
  const [qqEvents, setQqEvents] = useState([...NOTIFY_DEFAULT_EVENTS]);
  // 群消息要 @ 到人，就必须知道对方在这个群里的 member_openid（QQ 只认这个，不认 QQ 号）。
  // 它只能从群事件里读出来，所以由管理员手工登记：平台用户名 + member_openid。
  const [bindUser, setBindUser] = useState('');
  const [bindOpenid, setBindOpenid] = useState('');
  const [emailNotify, setEmailNotify] = useState(false);
  const [emailEvents, setEmailEvents] = useState([...NOTIFY_DEFAULT_EVENTS]);
  const [newUser, setNewUser] = useState(emptyUser);
  const [auditFilters, setAuditFilters] = useState({ ...NO_AUDIT_FILTERS });
  // The audit export and the audit list read the same filter object, so they can never disagree.
  const [auditFiltersRevision, setAuditFiltersRevision] = useState(0);
  const [auditSnapshot, setAuditSnapshot] = useState(null);
  const changeAuditFilters = (next) => { setAuditFilters(next); setAuditSnapshot(null); };
  const refreshAudit = () => { setAuditSnapshot(null); setAuditFiltersRevision((value) => value + 1); };
  const [period, setPeriod] = useState({ start: '', end: '', opening: '' }); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const lock = useRef(false);
  const load = async () => {
    const result = await apiRequest('admin_data'); if (result.error) throw new Error(result.error.message);
    setQqNotify(result.data.qq_notify_enabled === true); setQqGroup(result.data.qq_group_openid || ''); setQqEvents(normalizeNotifyEvents(result.data.qq_notify_events));
    setData(result.data); setThreshold(String(result.data.threshold)); setRegistration(result.data.registration_enabled); setEmailNotify(result.data.email_notify_enabled === true); setEmailEvents(normalizeNotifyEvents(result.data.email_notify_events));
  };
  useEffect(() => { if (identity.roles.includes('admin')) load().catch((err) => setError(err.message)); }, []);
  const run = async (task, message) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await task(); await load(); setNotice(message); } catch (err) { setError(err.message || '操作没有完成，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  };
  const request = async (action, payload) => { const result = await apiRequest(action, payload); if (result.error) throw new Error(result.error.message); return result.data; };
  const validPeriod = () => {
    if (period.start && period.end && period.start > period.end) throw new Error('结束日期不能早于开始日期。');
    if (period.opening !== '' && (!Number.isFinite(Number(period.opening)) || Math.abs(Number(period.opening)) > 1e12)) throw new Error('请输入有效的期初余额。');
  };
  const exportReport = (kind) => run(async () => {
    if (kind === 'financial') validPeriod();
    const result = await request(kind === 'financial' ? 'export_financial' : 'export_audit', kind === 'financial' ? { start: period.start, end: period.end } : { ...auditFilters, snapshot: auditSnapshot });
    await downloadExport(kind, result, period.opening);
  }, '文件已生成，下载已开始。');
  // Plain date-range export, kept for the period-based report work in the same panel.
  const exportPeriodAudit = () => run(async () => {
    if (period.start && period.end && period.start > period.end) throw new Error('结束日期不能早于开始日期。');
    await downloadExport('audit', await request('export_audit', { start: period.start, end: period.end }));
  }, '文件已生成，下载已开始。');
  if (!identity.roles.includes('admin')) return <div className="panel-empty"><h2>没有权限</h2></div>;
  // 后端未随前端一起部署时字段会缺失（包括新增的“已作废”），逐字段兜底，避免整页白屏或显示 undefined。
  const queue = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, ...(data?.notifications ?? {}) };
  const failures = data?.failures ?? [];
  return <><div className="heading-row"><div><p className="eyebrow">组织管理</p><h1>设置</h1></div></div>
    <ErrorText>{error}</ErrorText>{notice && <div className="notice" role="status">{notice}</div>}
    {!data ? <div className="panel-empty">加载中…</div> : <>
      <div className="settings-grid admin-settings">
        <section className="panel detail-panel"><h2>注册设置</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_registration', { enabled: registration }), '注册设置已保存。'); }}><fieldset disabled={busy}><label className="check-row registration-switch"><input type="checkbox" role="switch" checked={registration} onChange={(e) => setRegistration(e.target.checked)} />允许新用户注册</label><p className="hint">关闭后，已有用户仍可登录，管理员仍可添加用户。</p><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>QQ 群提醒</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_qq_notify', { enabled: qqNotify, group_openid: qqGroup, events: qqEvents }), 'QQ提醒设置已保存。'); }}><fieldset disabled={busy}>
          <label className="check-row"><input type="checkbox" role="switch" checked={qqNotify} onChange={(e) => setQqNotify(e.target.checked)} />启用 QQ 群提醒</label>
          <label>目标群 OpenID<input value={qqGroup} maxLength={128} onChange={(e) => setQqGroup(e.target.value)} placeholder="机器人事件中的 group_openid，不是数字群号" /></label>
          <p className="hint">每次申请状态变化向该群发一条提醒，与邮件独立。群消息只包含提醒类型和平台入口，详情需登录查看。机器人必须加入目标群并获得主动消息权限；AppID 和 AppSecret 在服务端配置。关闭期间的状态变化不补发。</p>
          <div className="notify-event-groups">{NOTIFY_EVENT_GROUPS.map((group) => <div className="notify-event-group" key={group.title}><span className="notify-event-title">{group.title}</span>{group.events.map((event) => <label className="check-row" key={event}><input type="checkbox" checked={qqEvents.includes(event)} onChange={(e) => setQqEvents(normalizeNotifyEvents(e.target.checked ? [...qqEvents, event] : qqEvents.filter((item) => item !== event)))} />{event}</label>)}</div>)}</div>
          {data.qq_service_configured === false && <p className="hint warn">服务端尚未配置 QQ_BOT_APP_ID 与 QQ_BOT_APP_SECRET。</p>}
          <p className="hint">共用现有定时任务。每轮最多发送 3 条；24 小时内最多尝试 5 次。以下显示最近 10 条待发或失败记录。</p>
          <ul className="queue-failures">{(data.qq_queue || []).map((item) => <li key={item.id}>{item.event} · {({ pending: '待发送', sending: '发送中', failed: '失败' })[item.status]} · 尝试 {item.attempts} 次 · {item.last_error}</li>)}</ul>
          <p className="hint">群消息首行会 @ 该待办的负责人。QQ 只认成员在本群的 member_openid（不是 QQ 号、也不是用户名），它只能从群事件里读出来：让成员在群里 @ 一次机器人，用 scripts/qq-capture-group-openid.ps1 读出他的 member_openid 后登记在下面。没登记的人不会导致发送失败，只是退化成「负责人：姓名」。</p>
          <div className="form-grid"><label>平台用户名<input value={bindUser} maxLength={40} onChange={(e) => setBindUser(e.target.value)} placeholder="如 zhangsan" /></label><label>member_openid<input value={bindOpenid} maxLength={128} onChange={(e) => setBindOpenid(e.target.value)} placeholder="该成员 @ 机器人时事件里的 author.member_openid" /></label></div>
          <div className="form-actions"><Button type="button" kind="secondary" onClick={() => run(async () => { await request('set_qq_binding', { username: bindUser.trim(), member_openid: bindOpenid.trim() }); setBindUser(''); setBindOpenid(''); setData(await request('admin_data', {})); }, '成员绑定已保存。')}>登记绑定</Button></div>
          <ul className="queue-failures">{(data.qq_bindings || []).map((item) => <li key={item.user_id}>@{item.username} · {item.full_name || '成员'} · {item.member_openid} · <Button type="button" kind="quiet" onClick={() => run(async () => { await request('delete_qq_binding', { username: item.username }); setData(await request('admin_data', {})); }, '已解除该成员的绑定。')}>解除</Button></li>)}</ul>
          <div className="form-actions"><Button kind="secondary">保存设置</Button><Button type="button" onClick={() => run(async () => { const result = await request('send_qq_notifications', {}); if (result?.skipped) throw new Error(result.message); }, 'QQ队列已处理，结果见队列及操作日志。')}>立即发送 QQ 提醒</Button><Button type="button" kind="secondary" onClick={() => run(() => request('reset_qq_notifications', {}), '有效的失败QQ提醒已重新排队。')}>失败项重新排队</Button></div>
        </fieldset></form></section>
        <section className="panel detail-panel"><h2>邮件通知</h2><form onSubmit={(e) => { e.preventDefault(); run(() => request('update_email_notify', { enabled: emailNotify, events: emailEvents }), '邮件通知设置已保存。'); }}><fieldset disabled={busy}><label className="check-row registration-switch"><input type="checkbox" role="switch" checked={emailNotify} onChange={(e) => setEmailNotify(e.target.checked)} />启用邮件提醒</label><p className="hint">总开关之外按类型勾选：待办类发给对应身份成员（审批、付款登记）或申请人本人（退回修改、待补充收款码，后者即"已通过审批，请补充收款信息"）；结果类（拒绝申请、已付款）只发给申请人本人，默认不勾选，需要时打开。取消勾选的类型不再生成新提醒，已经积压但尚未发出的也会在下一次消费时作废。关闭总开关时不生成新提醒，超过 {NOTIFY_QUEUE.maxAgeHours} 小时仍未发送的提醒会被丢弃。邮件服务密钥由项目负责人在服务端配置，收件人只包含申请中可见的信息。</p><div className="notify-event-groups">{NOTIFY_EVENT_GROUPS.map((group) => <div className="notify-event-group" key={group.title}><span className="notify-event-title">{group.title}<small>{group.hint}</small></span>{group.events.map((event) => <label className="check-row" key={event}><input type="checkbox" checked={emailEvents.includes(event)} onChange={(e) => setEmailEvents(normalizeNotifyEvents(e.target.checked ? [...emailEvents, event] : emailEvents.filter((item) => item !== event)))} />{event}</label>)}</div>)}</div><p className="muted">已勾选 {emailEvents.length} / {NOTIFY_EVENTS.length} 类提醒；保存后立即生效，改动会写入操作日志。</p><p className="hint">队列由定时任务定期消费；没有配置定时任务时，请点“立即发送”。「已作废」表示提醒发出前申请状态已经变化（或收款信息被更换、收件人身份被撤销、该类提醒被关闭），这些提醒不会再发，也不占用去重名额。</p>{data.email_service_configured === false && <p className="hint warn">服务端尚未配置 EMAIL_API_URL、EMAIL_API_KEY 与 EMAIL_FROM，队列暂时发不出去。</p>}<p className="muted">队列：待发送 {queue.pending} 封 · 发送中 {queue.sending} 封 · 已发送 {queue.sent} 封 · 失败 {queue.failed} 封 · 已作废 {queue.cancelled} 封</p>{failures.length > 0 && <ul className="queue-failures">{failures.map((item) => <li key={item.id}>@{item.username} · {item.event} · 尝试 {item.attempts} 次 · {item.last_error}</li>)}</ul>}<div className="form-actions"><Button kind="secondary">保存设置</Button><Button type="button" onClick={() => run(() => request('send_notifications', {}), '队列已处理，数量见上方统计。')}>立即发送</Button>{failures.length > 0 && <Button type="button" kind="secondary" onClick={() => run(() => request('reset_notifications', {}), '失败提醒已重新排队。')}>失败项重新排队</Button>}</div></fieldset></form></section>
        <section className="panel detail-panel"><h2>金额设置</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(() => request('update_threshold', { threshold: Number(threshold) }), '金额设置已保存。'); }}><fieldset disabled={busy}><label>主席处理起始金额（元）<input required type="number" min="0.01" max="10000000" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label><Button kind="secondary">保存设置</Button></fieldset></form></section>
        <section className="panel detail-panel"><h2>添加用户</h2><form className="stack-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await request('admin_create_user', newUser); setNewUser(emptyUser()); }, '用户已添加，可使用初始密码登录。'); }}><fieldset disabled={busy}>
          <div className="form-grid"><label>用户名<input required minLength="3" maxLength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autoComplete="off" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></label><label>姓名<input required maxLength="80" value={newUser.full_name} onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} /></label></div>
          <label>部门 / 活动<input maxLength="80" value={newUser.department} onChange={(e) => setNewUser({ ...newUser, department: e.target.value })} /></label><label>邮箱（可选，用于接收待办提醒）<input type="email" maxLength="254" autoComplete="off" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder="例如 you@example.com" /></label><label>初始密码<input required type="password" minLength="10" maxLength="72" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="10–72 个字符" /></label>
          <div className="role-choices">{Object.entries(ROLE_LABEL).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={newUser.roles.includes(role)} onChange={(e) => setNewUser({ ...newUser, roles: e.target.checked ? [...newUser.roles, role] : newUser.roles.filter((r) => r !== role) })} />{label}</label>)}</div><p className="hint">不选择角色时，为普通用户。</p><Button>添加用户</Button>
        </fieldset></form></section>
        <section className="panel detail-panel"><h2>数据导出</h2><fieldset disabled={busy}><div className="form-grid"><label>开始日期<input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></label><label>结束日期<input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></label></div><label>期初余额（元，可不填）<input type="number" step="0.01" value={period.opening} onChange={(e) => setPeriod({ ...period, opening: e.target.value })} /></label><p className="hint">财报仅含已付款报销。不填写期初余额时，收入及余额留空。</p><div className="export-actions"><Button type="button" onClick={() => exportReport('financial')}>导出财报</Button><Button type="button" kind="secondary" onClick={() => exportPeriodAudit()}>按日期导出操作日志</Button></div></fieldset>
          <div className="audit-export-row"><p className="hint">按上面的「操作日志」筛选条件导出：{auditFiltersActive(auditFilters) ? auditFilterSummary(auditFilters) : '全部分类、全部时间'}</p><div className="export-actions"><Button type="button" kind="secondary" disabled={busy || auditSnapshot === null} onClick={() => exportReport('audit')}>导出筛选后的操作日志</Button><Button type="button" kind="quiet" onClick={() => { changeAuditFilters({ ...NO_AUDIT_FILTERS }); refreshAudit(); }}>清空筛选</Button></div></div>
        </section>
      </div>
      <MemberDirectory identity={identity} busy={busy} revision={data} onSave={(user_id, roles, active) => run(() => request('set_member_roles', { user_id, roles, active }), '用户设置已保存。')} />
      <AuditDirectory identity={identity} revision={data} filters={auditFilters} onFiltersChange={changeAuditFilters} filtersRevision={auditFiltersRevision} onSnapshotChange={setAuditSnapshot} />
    </>}
  </>;
}
