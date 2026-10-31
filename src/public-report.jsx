import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { filterPublicRecords, summarizePublicRecords } from './public-report.js';
import { buildPublicReportCsv, publicReportSnapshotKey } from './public-report-export.js';

const money = (cents) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayText = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const currentMonth = () => {
  const now = new Date();
  return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, end: dayText(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
};
const semesterRange = (year, term) => term === 'spring'
  ? { start: `${year}-02-01`, end: `${year}-07-31` }
  : { start: `${year}-08-01`, end: `${year + 1}-01-31` };
const currentSemester = () => {
  const now = new Date();
  return semesterRange(now.getMonth() >= 1 && now.getMonth() <= 6 ? now.getFullYear() : now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(), now.getMonth() >= 1 && now.getMonth() <= 6 ? 'spring' : 'fall');
};

function dateRangeForPreset(value) {
  if (value === 'month') return currentMonth();
  if (value === 'current-semester') return currentSemester();
  const [term, year] = value.split(':');
  return semesterRange(Number(year), term);
}

export function PublicReport() {
  const initial = currentMonth();
  const [dates, setDates] = useState(initial);
  const [preset, setPreset] = useState('month');
  const [records, setRecords] = useState([]);
  const [enabled, setEnabled] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('');
  const [department, setDepartment] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const [printGeneratedAt, setPrintGeneratedAt] = useState('');
  const mountedRef = useRef(true);
  const exportInFlightRef = useRef(false);
  const snapshotRevisionRef = useRef(0);
  const actionSnapshotRef = useRef(null);
  const invalidateSnapshot = () => { snapshotRevisionRef.current += 1; };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    invalidateSnapshot();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dates.start) || !/^\d{4}-\d{2}-\d{2}$/.test(dates.end) || dates.start > dates.end) {
      invalidateSnapshot();
      setLoading(false); setRecords([]); setEnabled(true); setError('请选择有效的开始和结束日期。');
      return () => { active = false; };
    }
    setLoading(true); setError(''); setRecords([]); setEnabled(null);
    apiRequest('public_financial_report', dates).then((result) => {
      if (!active) return;
      invalidateSnapshot();
      if (result.error) throw new Error(result.error.message || '公开财报暂时无法加载。');
      setEnabled(result.data?.enabled === true);
      setRecords(result.data?.enabled === true && Array.isArray(result.data.records) ? result.data.records : []);
    }).catch((err) => {
      if (!active) return;
      invalidateSnapshot();
      setError(err.message || '公开财报暂时无法加载。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dates.start, dates.end]);

  const categories = useMemo(() => [...new Set(records.map((record) => record.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [records]);
  const departments = useMemo(() => [...new Set(records.map((record) => record.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [records]);
  const visible = useMemo(() => filterPublicRecords(records, { category, department }), [records, category, department]);
  const summary = useMemo(() => summarizePublicRecords(visible), [visible]);
  const maxMonth = Math.max(1, ...summary.months.map((item) => item.totalCents));
  const maxCategory = Math.max(1, ...summary.categories.map((item) => item.totalCents));
  const selection = { start: dates.start, end: dates.end, category, department };
  const validRange = dates.start && dates.end && dates.start <= dates.end;
  actionSnapshotRef.current = {
    selection, records: visible, loading, error, enabled, validRange,
    revision: snapshotRevisionRef.current,
  };
  const filterLabel = (value, all) => value || all;

  const runPublicAction = async (action) => {
    const pageSnapshot = actionSnapshotRef.current;
    if (exportInFlightRef.current || !pageSnapshot || !pageSnapshot.validRange || pageSnapshot.loading || pageSnapshot.error || pageSnapshot.enabled !== true) return;
    exportInFlightRef.current = true;
    setExportBusy(true); setExportNotice(''); setPrintGeneratedAt('');
    const captured = { ...pageSnapshot.selection };
    const capturedKey = JSON.stringify(captured);
    const capturedRevision = pageSnapshot.revision;
    const displayedKey = publicReportSnapshotKey(pageSnapshot.records);
    try {
      const result = await apiRequest('public_financial_report', { start: captured.start, end: captured.end });
      if (!mountedRef.current) return;
      if (result.error) throw new Error(result.error.message || '无法重新确认公开财报状态。');
      if (result.data?.enabled !== true) {
        invalidateSnapshot();
        setEnabled(false); setRecords([]);
        setExportNotice('公开财报已关闭，未生成文件。');
        return;
      }
      if (snapshotRevisionRef.current !== capturedRevision
        || JSON.stringify(actionSnapshotRef.current?.selection) !== capturedKey
        || actionSnapshotRef.current?.loading) {
        setExportNotice('筛选条件已变化，未生成文件。请确认当前结果后重新操作。');
        return;
      }
      if (!Array.isArray(result.data.records)) throw new Error('公开财报数据格式无效，未生成文件。');
      const latestVisible = filterPublicRecords(result.data.records, captured);
      if (publicReportSnapshotKey(latestVisible) !== displayedKey) {
        invalidateSnapshot();
        setRecords(result.data.records); setEnabled(true);
        setExportNotice('财报数据已有更新，页面已刷新。请确认结果后重新操作。');
        return;
      }
      const generatedAt = new Date();
      if (action === 'download') {
        const csv = buildPublicReportCsv({ ...captured, records: visible, generatedAt });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `财报_${captured.start}_${captured.end}.csv`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        setExportNotice('已下载当前筛选结果的 CSV 财报。');
      } else {
        setPrintGeneratedAt(new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).format(generatedAt));
        window.requestAnimationFrame(() => {
          if (mountedRef.current
            && snapshotRevisionRef.current === capturedRevision
            && JSON.stringify(actionSnapshotRef.current?.selection) === capturedKey
            && !actionSnapshotRef.current?.loading) window.print();
        });
      }
    } catch (err) {
      if (mountedRef.current) setExportNotice(err.message || '操作失败，未生成文件。');
    } finally {
      exportInFlightRef.current = false;
      if (mountedRef.current) setExportBusy(false);
    }
  };

  const setPresetRange = (value) => {
    invalidateSnapshot();
    setPreset(value);
    setPrintGeneratedAt(''); setExportNotice('');
    if (value === 'custom') return;
    setDates(dateRangeForPreset(value)); setCategory(''); setDepartment('');
  };
  const editDate = (key, value) => { invalidateSnapshot(); setPreset('custom'); setDates((current) => ({ ...current, [key]: value })); setCategory(''); setDepartment(''); setPrintGeneratedAt(''); setExportNotice(''); };

  return <main className="public-report-page">
    <header className="public-report-header">
      <a className="public-report-brand" href="/" aria-label="返回财务报销平台登录页"><img src="/sta-logo.jpg" alt="" /><span><strong>成都七中科学技术协会</strong><small>公开财报</small></span></a>
      <a className="public-login-link" href="/">平台登录</a>
    </header>
    <div className="public-report-content">
      <div className="heading-row"><div><p className="eyebrow">经费公开</p><h1>财务支出统计</h1><p className="muted">仅统计所选付款日期范围内已付款的报销记录；金额和日期按财务付款记录计算。</p></div></div>
      <section className="panel detail-panel public-report-filters" aria-label="财报筛选">
        <label>时间范围<select value={preset} onChange={(event) => setPresetRange(event.target.value)}>
          <option value="month">本月</option>
          <option value="current-semester">本学期（春季 2/1–7/31；秋季 8/1–次年 1/31）</option>
          <option value={`spring:${new Date().getFullYear()}`}>春季学期（2/1–7/31）</option>
          <option value={`fall:${new Date().getFullYear()}`}>秋季学期（8/1–次年 1/31）</option>
          <option value="custom">自定义日期</option>
        </select></label>
        <label>开始日期<input type="date" value={dates.start} max={dates.end || undefined} onChange={(event) => editDate('start', event.target.value)} /></label>
        <label>结束日期<input type="date" value={dates.end} min={dates.start || undefined} onChange={(event) => editDate('end', event.target.value)} /></label>
        <label>费用类别<select value={category} onChange={(event) => { invalidateSnapshot(); setCategory(event.target.value); setPrintGeneratedAt(''); setExportNotice(''); }}><option value="">全部类别</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>部门 / 活动<select value={department} onChange={(event) => { invalidateSnapshot(); setDepartment(event.target.value); setPrintGeneratedAt(''); setExportNotice(''); }}><option value="">全部部门 / 活动</option>{departments.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </section>
      {!validRange && <div className="error-text" role="alert">请选择有效的开始和结束日期。</div>}
      <p className="public-range-note">当前范围：{dates.start || '—'} 至 {dates.end || '—'}（最多五年）</p>

      {loading ? <section className="panel panel-empty" role="status">正在加载财报…</section>
        : error ? <section className="panel panel-empty"><div className="error-text" role="alert">{error}</div></section>
          : enabled === false ? <section className="panel panel-empty"><h2>公开财报暂未开放</h2><p>管理员关闭了公开展示，请稍后再访问。</p></section>
            : enabled !== true ? <section className="panel panel-empty"><p>财报状态暂不可用，请稍后重试。</p></section>
              : <>
                <div className="stat-grid public-report-stats"><div className="stat-card highlight"><span>总支出</span><strong>{money(summary.totalCents)}</strong></div><div className="stat-card"><span>报销笔数</span><strong>{summary.count}<small> 笔</small></strong></div><div className="stat-card"><span>平均单笔金额</span><strong>{money(summary.averageCents)}</strong></div></div>
                <div className="public-report-chart-grid">
                  <section className="panel detail-panel"><h2>按月支出趋势</h2>{summary.months.length ? <div className="report-bars">{summary.months.map((item) => <div className="report-bar-row" key={item.month}><span>{item.month}</span><div className="report-bar-track"><div className="report-bar-fill" style={{ width: `${Math.max(2, item.totalCents / maxMonth * 100)}%` }} /></div><strong>{money(item.totalCents)}</strong></div>)}</div> : <p className="muted">所选筛选条件下暂无月度数据。</p>}</section>
                  <section className="panel detail-panel"><h2>按类别汇总</h2>{summary.categories.length ? <div className="report-bars">{summary.categories.map((item) => <div className="report-bar-row category-bar-row" key={item.category}><span title={item.category}>{item.category}</span><div className="report-bar-track"><div className="report-bar-fill category-fill" style={{ width: `${Math.max(2, item.totalCents / maxCategory * 100)}%` }} /></div><strong>{money(item.totalCents)}</strong></div>)}</div> : <p className="muted">所选筛选条件下暂无类别数据。</p>}</section>
                </div>
                <section className="panel list-panel public-report-list">
                  <div className="public-report-list-heading"><div><h2>付款明细</h2><p className="muted">{visible.length} 笔已付款记录</p></div>
                    <div className="public-report-actions"><button className="button secondary" type="button" disabled={exportBusy || loading || Boolean(error) || enabled !== true || !validRange} onClick={() => runPublicAction('print')}>{exportBusy ? '核对中…' : '打印 / 保存 PDF'}</button><button className="button" type="button" disabled={exportBusy || loading || Boolean(error) || enabled !== true || !validRange} onClick={() => runPublicAction('download')}>{exportBusy ? '核对中…' : '下载 CSV'}</button></div>
                  </div>
                  {exportNotice && <p className="public-export-notice" role="status">{exportNotice}</p>}
                  <div className="public-print-meta"><p><strong>统计周期：</strong>{dates.start} 至 {dates.end}</p><p><strong>费用类别：</strong>{filterLabel(category, '全部类别')}　<strong>部门 / 活动：</strong>{filterLabel(department, '全部部门 / 活动')}</p><p><strong>生成时间：</strong>{printGeneratedAt || '打印前重新核对' }（北京时间）</p><p><strong>说明：</strong>仅含已付款记录</p></div>
                  <div className="public-print-summary"><p>总支出：{money(summary.totalCents)}　报销笔数：{summary.count} 笔　平均单笔金额：{money(summary.averageCents)}</p></div>
                  {visible.length === 0 ? <div className="panel-empty"><h2>暂无符合条件的记录</h2><p>调整时间、类别或部门筛选条件后再查看。</p></div> : <div className="table-scroll"><table><thead><tr><th>付款日期</th><th>报销人</th><th>费用类别</th><th>部门 / 活动</th><th className="numeric">金额</th></tr></thead><tbody>{visible.map((record, index) => <tr key={`${record.payment_date}-${record.category}-${record.department}-${record.applicant_name}-${index}`}><td>{record.payment_date}</td><td>{record.applicant_name || '未填写'}</td><td>{record.category || '未分类'}</td><td>{record.department || '未填写'}</td><td className="numeric">{money(Math.round(Number(record.amount) * 100))}</td></tr>)}</tbody></table></div>}
                </section>
                <p className="public-privacy-note">报销人显示当前账号资料中的姓名；姓名未填写时显示“未填写”，资料更新后历史记录中的姓名也会更新。部门 / 活动和费用类别为申请时填写的内容。若发现内容不适合公开，请联系管理员。</p>
              </>}
      <footer className="public-report-footer">成都七中科学技术协会 · 财务报销平台</footer>
    </div>
  </main>;
}
