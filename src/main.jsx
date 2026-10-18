import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { apiRequest } from './api.js';
import { normalizeEmail, validateEmail } from './notify-rules.js';
import { ApplicationForm, ApplicationDetail } from './workflow.jsx';
import { AdminPanel } from './admin.jsx';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const SESSION_KEY = 'yuxing_app_session';

const STATUS = {
  draft: '草稿', finance_pending: '待财委审批', chair_pending: '待主席审批',
  changes_requested: '退回修改', rejected: '已拒绝', payment_info_required: '待补充收款码',
  payment_pending: '待付款', paid: '已付款', cancelled: '已撤回'
};

const money = (value) => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (value) => value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '—';
function Brand() { return <><img className="sta-logo" src="/sta-logo.jpg" alt="成都七中科学技术协会 Logo" /><span className="sta-brand"><strong>成都七中科学技术协会</strong><span>财务报销平台</span></span></>; }

function ErrorText({ error }) { return error ? <div className="error-text" role="alert">{error}</div> : null; }
function StatusBadge({ status }) { return <span className={`status ${status}`}>{STATUS[status] || status}</span>; }
function Button({ children, kind = '', ...props }) { return <button className={`button ${kind}`} {...props}>{children}</button>; }
function Spinner() { return <span className="spinner" aria-label="加载中" />; }

function AccountPanel({ identity, onProfileUpdate }) {
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [email, setEmail] = useState(identity.profile?.email || '');
  const [emailBusy, setEmailBusy] = useState(false); const [emailError, setEmailError] = useState(''); const [emailNotice, setEmailNotice] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiRequest('change_password', { current_password: passwords.current, new_password: passwords.next });
      if (result.error) throw new Error(result.error.message);
      setPasswords({ current: '', next: '' }); setNotice('密码已更新。其他设备上的登录已退出，当前设备保持登录。');
    } catch (err) {
      const message = err.message || '密码没有更新，请重试。';
      setError(/登录已过期|请先登录/.test(message) ? `${message} 其他设备上的登录可能已被撤销，请重新登录。` : message);
    }
    finally { setBusy(false); }
  };
  const bindEmail = async (event) => {
    event.preventDefault(); if (emailBusy) return;
    const value = email.trim();
    if (value) { const invalid = validateEmail(value); if (invalid) { setEmailError(invalid); return; } }
    setEmailBusy(true); setEmailError(''); setEmailNotice('');
    try {
      const result = await apiRequest('bind_email', { email: value });
      if (result.error) throw new Error(result.error.message);
      // 服务端会把地址去空格转小写，本地也按同样规范显示，避免输入与保存结果不一致。
      const stored = value ? normalizeEmail(value) : '';
      setEmail(stored); onProfileUpdate({ email: stored || null });
      setEmailNotice(value ? '邮箱已更新，申请动态会发送到这个地址。' : '已清除邮箱，将不再收到邮件提醒。');
    } catch (err) { setEmailError(err.message || '邮箱没有保存，请重试。'); }
    finally { setEmailBusy(false); }
  };
  return <><div className="heading-row"><div><p className="eyebrow">账户</p><h1>账户设置</h1></div></div>
    <section className="panel detail-panel account-panel"><h2>邮箱提醒</h2><p className="muted">是否收到邮件提醒由管理员在设置里配置：待办类（轮到你审批、你的申请被退回待修改、要你补充收款信息）默认开启；结果类（申请被拒绝、已完成打款）默认关闭，管理员需要时会打开。</p><p className="hint">地址由本人填写，系统不验证邮箱归属，也不会提示退信：填错就只是收不到提醒，请填常用邮箱（QQ、微信或学校邮箱到达率最好）。提醒内容会包含申请人、部门与金额，只有需要你处理的人才会收到。</p>
      <form className="stack-form" onSubmit={bindEmail}><fieldset disabled={emailBusy}><label>邮箱地址<input type="email" maxLength="254" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="例如 you@example.com" /></label><ErrorText error={emailError} />{emailNotice && <div className="notice" role="status">{emailNotice}</div>}<Button kind="secondary">保存邮箱</Button></fieldset></form></section>
    <section className="panel detail-panel account-panel"><h2>修改密码</h2><p className="muted">更新后，本次登录保持有效，其他设备上的登录会立即退出，下次登录请使用新密码。</p><form className="stack-form" onSubmit={submit}><fieldset disabled={busy}><label>当前密码<input required type="password" autoComplete="current-password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} /></label><label>新密码<input required minLength="10" maxLength="72" type="password" autoComplete="new-password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} /></label><ErrorText error={error} />{notice && <div className="notice" role="status">{notice}</div>}<Button kind="secondary">更新密码</Button></fieldset></form></section>
  </>;
}


function AuthScreen() {
  const [registration, setRegistration] = useState(null);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: '', password: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { let mounted = true; apiRequest('public_settings').then((result) => { if (mounted) setRegistration(!result.error && result.data?.registration_enabled === true); }); return () => { mounted = false; }; }, []);
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiRequest(mode === 'login' ? 'login' : 'register', { username: form.username.trim(), password: form.password, full_name: form.name.trim() });
      if (result.error) throw new Error(result.error.message);
      localStorage.setItem(SESSION_KEY, result.data.session.token);
      setNotice(mode === 'login' ? '登录成功，正在进入…' : '账号已创建，正在进入…');
      window.location.reload();
    } catch (err) { setError(err.message || '登录没有完成。'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <section className="auth-card">
      <div className="auth-brand"><Brand /></div>
      <h1>{mode === 'login' ? '欢迎回来' : '创建账号'}</h1>
      <p className="auth-lead">{mode === 'login' ? '登录后查看申请进展。' : '注册后即可提交第一笔申请。'}</p>
      <div className="tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button>{registration === true && <button className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); }}>注册</button>}</div>
      {registration === false && <p className="hint">暂不开放注册，请联系管理员创建账号。</p>}
      <form onSubmit={submit} className="stack-form">
        {mode === 'signup' && <label>姓名<input required maxLength="80" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="你的姓名" /></label>}
        <label>用户名<input required minLength="3" maxLength="40" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,39}" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="例如：zhangsan" /></label>
        <label>密码<input required type="password" minLength="10" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 10 个字符" /></label>
        <ErrorText error={error} />{notice && <div className="notice">{notice}</div>}
        <Button disabled={busy}>{busy ? <Spinner /> : mode === 'login' ? '登录' : '创建账号'}</Button>
      </form>
    </section>
  </main>;
}

function App() {
  const [session, setSession] = useState(undefined);
  const [identity, setIdentity] = useState(null);
  const [identityError, setIdentityError] = useState('');
  useEffect(() => {
    let mounted = true;
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) { setSession(null); return () => { mounted = false; }; }
    apiRequest('me').then((result) => {
      if (!mounted) return;
      if (result.error) { localStorage.removeItem(SESSION_KEY); setSession(null); return; }
      setSession({ token, user: result.data.user });
      setIdentity({ profile: result.data.user, roles: result.data.roles || [] });
    });
    return () => { mounted = false; };
  }, []);
  if (!supabaseUrl || !supabaseKey) return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><Brand /></div><h1>连接暂不可用</h1><p className="auth-lead">请稍后重试。</p></section></main>;
  if (session === undefined || (session && !identity && !identityError)) return <main className="loading-page"><Spinner /></main>;
  if (!session) return <AuthScreen />;
  if (identityError) return <main className="auth-page"><section className="auth-card"><h1>账号信息加载失败</h1><ErrorText error={identityError} /><Button onClick={() => window.location.reload()}>重新加载</Button></section></main>;
  return <Workspace session={session} identity={identity} onProfileUpdate={(patch) => setIdentity((current) => current ? { ...current, profile: { ...current.profile, ...patch } } : current)} />;
}

function Workspace({ session, identity, onProfileUpdate }) {
  const [view, setView] = useState('dashboard');
  const [selectedId, setSelectedId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const roles = identity.roles || [];
  const open = (next, id = null) => { setSelectedId(id); setView(next); };
  const refresh = () => setRefreshKey((value) => value + 1);
  const logout = async () => { await apiRequest('logout'); localStorage.removeItem(SESSION_KEY); window.location.reload(); };
  return <div className="app-shell">
    <header className="topbar"><button className="brand-button" onClick={() => open('dashboard')}><Brand /></button>
      <nav><button className={view === 'dashboard' ? 'current' : ''} onClick={() => open('dashboard')}>我的申请</button>{roles.length > 0 && <button className={view === 'team' ? 'current' : ''} onClick={() => open('team')}>工作台</button>}{roles.includes('admin') && <button className={view === 'admin' ? 'current' : ''} onClick={() => open('admin')}>设置</button>}<button className={view === 'account' ? 'current' : ''} onClick={() => open('account')}>账户设置</button></nav>
      <div className="user-menu"><span>{identity.profile?.full_name || session.user.username}</span><button className="logout" onClick={logout}>退出</button></div>
    </header>
    <main className="content">{view === 'dashboard' || view === 'team' ? <Dashboard identity={identity} team={view === 'team'} onOpen={open} refreshKey={refreshKey} /> : view === 'new' ? <ApplicationForm identity={identity} onDone={(id) => { refresh(); open('detail', id); }} onCancel={() => open('dashboard')} /> : view === 'detail' ? <ApplicationDetail id={selectedId} identity={identity} onBack={() => open('dashboard')} onRefresh={refresh} /> : view === 'account' ? <AccountPanel identity={identity} onProfileUpdate={onProfileUpdate} /> : <AdminPanel identity={identity} />}</main>
    <footer>成都七中科学技术协会 财务报销平台 · 本网站由 网络部 搭建运营 · 版本号 1.0.0</footer>
  </div>;
}

function Dashboard({ identity, team, onOpen, refreshKey }) {
  const [applications, setApplications] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [filter, setFilter] = useState(''); const [query, setQuery] = useState('');
  useEffect(() => {
    let mounted = true; setLoading(true);
    (async () => {
      const result = await apiRequest('list_applications', { scope: team ? 'team' : 'mine' });
      if (mounted) { setApplications(result.data || []); setError(result.error?.message || ''); setLoading(false); }
    })(); return () => { mounted = false; };
  }, [identity.profile.id, team, refreshKey]);
  const visible = applications.filter((item) => (!filter || item.status === filter) && (!query || `${item.title} ${item.department}`.toLowerCase().includes(query.toLowerCase())));
  const active = applications.filter((item) => !['rejected', 'cancelled'].includes(item.status));
  const paid = applications.filter((item) => item.status === 'paid');
  return <>
    <div className="heading-row"><div><p className="eyebrow">资金管理</p><h1>{team ? '工作台' : '我的申请'}</h1></div><Button onClick={() => onOpen('new')}>＋ 新建申请</Button></div>
    <div className="stat-grid"><div className="stat-card highlight"><span>申请总额</span><strong>{money(active.reduce((sum, item) => sum + Number(item.amount), 0))}</strong></div><div className="stat-card"><span>进行中</span><strong>{active.filter((item) => !['paid', 'draft'].includes(item.status)).length}<small> 笔</small></strong></div><div className="stat-card"><span>已付款</span><strong>{money(paid.reduce((sum, item) => sum + Number(item.amount), 0))}</strong></div></div>
    <section className="panel list-panel"><div className="toolbar"><input aria-label="搜索" placeholder="搜索标题或部门" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="状态筛选" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">全部状态</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {loading ? <div className="panel-empty"><Spinner /></div> : error ? <div className="panel-empty"><ErrorText error={error} /></div> : visible.length === 0 ? <div className="panel-empty"><div className="empty-mark">＋</div><h2>这里还没有申请</h2><p>准备好了，就创建第一笔。</p><Button kind="secondary" onClick={() => onOpen('new')}>新建申请</Button></div> : <div className="table-scroll"><table><thead><tr><th>申请</th>{team && <th>申请人</th>}<th>金额</th><th>状态</th><th>更新日期</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} onClick={() => onOpen('detail', item.id)}><td><button className="link-button">{item.title}</button><span className="subtext">{item.department} · {item.category}</span></td>{team && <td>{item.owner_id === identity.profile.id ? '我' : item.owner_id.slice(0, 8)}</td>}<td className="numeric">{money(item.amount)}</td><td><StatusBadge status={item.status} /></td><td className="muted">{dateText(item.updated_at)}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}



function Root() { return <App />; }
createRoot(document.getElementById('root')).render(<Root />);
