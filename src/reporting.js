export const ROLE_LABEL = { finance: '财委', chair: '主席', admin: '管理员' };
const FIELD_LABEL = { title: '标题', purpose: '用途说明', amount: '金额', category: '费用类别', department: '部门 / 活动', use_date: '使用日期', recipient: '收款人', reference: '流水号' };
export function formatDateTime(value) {
  if (!value) return '—';
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  return parts;
}
/** One human-readable line for the same filter object the server applies to list and export. */
export function auditFilterSummary(filters = {}) {
  const parts = [];
  if (filters.username) parts.push(`用户名 含「${filters.username}」`);
  if (filters.event) parts.push(`操作 含「${filters.event}」`);
  if (filters.ip) parts.push(`IP 含「${filters.ip}」`);
  if (filters.start || filters.end) parts.push(`${filters.start || '最早'} 至 ${filters.end || '现在'}`);
  if (filters.include_system) parts.push('含系统日志');
  return parts.join(' · ');
}
export function auditDetail(row) {
  const changes = row.metadata?.changes;
  const details = Object.entries(changes || {}).map(([field, value]) => {
    const label = FIELD_LABEL[field] || field;
    if (value && typeof value === 'object') return `${label}：${value.原值 ?? '空'} → ${value.新值 ?? '空'}`;
    return `${label}：${value ?? '空'}`;
  });
  return [row.event === '更新审批门槛' ? `新门槛：¥${row.detail}` : row.detail, ...details].filter(Boolean).join('；');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function unpackTemplate(bytes) {
  const files = new Map(); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const method = view.getUint16(p + 8, true), length = view.getUint32(p + 18, true), nameLength = view.getUint16(p + 26, true), extra = view.getUint16(p + 28, true);
    if (method !== 0 || (view.getUint16(p + 6, true) & 8)) throw new Error('导出模板格式不支持。');
    const name = decoder.decode(bytes.slice(p + 30, p + 30 + nameLength)); const start = p + 30 + nameLength + extra;
    if (start + length > bytes.length) throw new Error('导出模板不完整。');
    files.set(name, bytes.slice(start, start + length)); p = start + length;
  }
  if (!files.has('xl/worksheets/sheet1.xml')) throw new Error('导出模板加载失败。');
  return files;
}
export function packWorkbook(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path); const bytes = typeof content === 'string' ? encoder.encode(content) : content; const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length); const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
    l.setUint32(14, crc, true); l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, name.length, true); local.set(name, 30);
    chunks.push(local, bytes);
    const entry = new Uint8Array(46 + name.length); const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); entry.set(name, 46);
    central.push(entry); offset += local.length + bytes.length;
  }
  const centralLength = central.reduce((sum, item) => sum + item.length, 0); const end = new Uint8Array(22); const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.size, true); e.setUint16(10, files.size, true); e.setUint32(12, centralLength, true); e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralLength + 22); let p = 0;
  for (const chunk of [...chunks, ...central, end]) { result.set(chunk, p); p += chunk.length; }
  return result;
}
const column = (index) => String.fromCharCode(65 + index);
// Store data as typed OpenXML cells. User text is never parsed as a formula.
function cell(address, value, style = '', formula = '') {
  const s = style ? ` s="${style}"` : '';
  if (formula) return `<c r="${address}"${s}><f>${xml(formula.replace(/^=/, ''))}</f>${Number.isFinite(value) ? `<v>${value}</v>` : ''}</c>`;
  if (value === null || value === undefined || value === '') return `<c r="${address}"${s}/>`;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('导出包含无效金额。'); return `<c r="${address}"${s}><v>${value}</v></c>`; }
  return `<c r="${address}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(String(value).slice(0, 30000))}</t></is></c>`;
}
const excelTime = (value) => (Date.parse(value) + 8 * 3600000) / 86400000 + 25569;
const cents = (value) => Math.round(Number(value) * 100);
export function financialRows(data, openingBalance = '') {
  const known = openingBalance !== '' && openingBalance !== null;
  let balance = known ? cents(openingBalance) : null;
  if (known && (!Number.isFinite(balance) || Math.abs(balance) > 1e14)) throw new Error('请输入有效期初余额。');
  const rows = [];
  if (known) rows.push({ values: [null, '期初余额', '1期初余额', '支付宝', null, null, balance / 100], opening: true });
  for (const payment of data.rows) {
    const app = payment.applications || {};
    if (app.status !== 'paid') continue;
    const amount = cents(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('付款金额无效，导出已停止。');
    if (known) balance -= amount;
    rows.push({ values: [excelTime(payment.created_at), `${app.title || '报销'}（${payment.applicant || payment.username || '申请人'}） · 流水 ${payment.reference}`, app.category || '报销', '支付宝', null, amount / 100, known ? balance / 100 : null] });
  }
  return { rows, known, closing: balance === null ? null : balance / 100 };
}
export function fillExportTemplate(templateBytes, kind, data, openingBalance = '') {
  const files = unpackTemplate(templateBytes);
  const normalizeNamespace = (s) => s.replace(/<(\/?)x:/g, '<$1').replace('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
  let sheet = normalizeNamespace(decoder.decode(files.get('xl/worksheets/sheet1.xml')));
  const body = sheet.match(/<sheetData[^>]*>([\s\S]*?)<\/sheetData>/)?.[1];
  if (!body) throw new Error('导出模板缺少数据区。');
  const templateRows = [...body.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];
  const rowSix = templateRows.find((r) => r[1] === '6')?.[0] || '';
  const styles = new Map([...rowSix.matchAll(/<c\b([^>]*)>/g)].map((match) => [match[1].match(/r="([A-Z]+)6"/)?.[1], match[1].match(/s="(\d+)"/)?.[1] || '']));
  let header = templateRows.filter((r) => Number(r[1]) <= 5).map((r) => r[0]).join('');
  // Replace entire cells rather than shared-string entries to keep the template immutable.
  const replaceCell = (address, value) => {
    const pattern = new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`);
    header = header.replace(pattern, (old) => cell(address, value, old.match(/s="(\d+)"/)?.[1]));
  };
  // For the audit log the date range belongs to the shared filter object, so the
  // export header states that range once instead of once per source.
  const start = data.filters ? data.filters.start || '' : data.start;
  const end = data.filters ? data.filters.end || '' : data.end;
  const auditScope = data.filters ? auditFilterSummary({ ...data.filters, start: '', end: '' }) : '';
  replaceCell('A2', `${start || '全部日期'} 至 ${end || '现在'}${auditScope ? ` · ${auditScope}` : ''} · 导出时间 ${formatDateTime(data.generated_at)}`);
  const financial = kind === 'financial' ? financialRows(data, openingBalance) : null;
  replaceCell('A3', financial ? financial.known ? '单位：元。仅含已付款报销；余额按输入期初余额减本期报销支出计算，不含其他收支。' : '单位：元。仅含已付款报销；未记录收入及期初余额，收入和余额留空。' : 'IP 来自请求代理信息；历史记录没有采集的 IP 显示为未记录。');
  const entries = financial ? financial.rows : data.rows.map((r) => ({ values: [excelTime(r.created_at), r.username || '系统', r.ip_address || '未记录', r.event, auditDetail(r), String(r.id)] }));
  const rows = [];
  const n = Math.max(2, entries.length); // Keep the summary rows present even for an empty report.
  const last = 5 + entries.length;
  const spent = financial ? financial.rows.reduce((sum, r) => sum + cents(r.values[5] || 0), 0) / 100 : 0;
  for (let i = 0; i < n; i++) {
    const r = i + 6; const item = entries[i]; let cells = '';
    if (item) cells += item.values.map((value, j) => {
      const formula = financial?.known && j === 6 && !item.opening ? `G${r - 1}+E${r}-F${r}` : '';
      return cell(`${column(j)}${r}`, value, styles.get(column(j)), formula);
    }).join('');
    if (financial && i < 2) {
      cells += cell(`I${r}`, i ? '总计' : '支付宝', styles.get('I'));
      cells += cell(`J${r}`, null, styles.get('J'));
      cells += cell(`K${r}`, spent, styles.get('K'), i ? 'K6' : entries.length ? `SUM(F6:F${last})` : '0');
      cells += cell(`L${r}`, financial.closing, styles.get('L'), financial.known ? i ? 'L6' : `G${last}` : '');
    }
    const height = kind === 'audit' ? Math.min(140, Math.max(34, Math.ceil(String(item?.values[4] || '').length / 70) * 17)) : 42;
    rows.push(`<row r="${r}" ht="${height}" customHeight="1">${cells}</row>`);
  }
  sheet = sheet.replace(/<sheetData[^>]*>[\s\S]*?<\/sheetData>/, `<sheetData>${header}${rows.join('')}</sheetData>`);
  sheet = sheet.replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${financial ? 'L' : 'F'}${5 + n}"/>`);
  files.set('xl/worksheets/sheet1.xml', encoder.encode(sheet));
  // Recalculate formulas in Excel, while providing verified cached balances and sums.
  const workbook = normalizeNamespace(decoder.decode(files.get('xl/workbook.xml'))).replace(/<calcPr\b[^>]*\/>/, '<calcPr fullCalcOnLoad="1" forceFullCalc="1"/>');
  files.set('xl/workbook.xml', encoder.encode(workbook));
  return packWorkbook(files);
}
export async function downloadExport(kind, data, openingBalance) {
  const response = await fetch(`/export-templates/${kind}.xlsx`);
  if (!response.ok) throw new Error('导出模板加载失败，请刷新后重试。');
  const bytes = fillExportTemplate(new Uint8Array(await response.arrayBuffer()), kind, data, openingBalance);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${kind === 'financial' ? '财报' : '操作日志'}_${formatDateTime(data.generated_at).replace(/[^0-9]/g, '')}.xlsx`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
