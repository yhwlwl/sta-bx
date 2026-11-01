import { amountInCents, filterPublicRecords } from './public-report.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORMULA_PREFIX = /^[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]*[=+\-@]/u;

function validDate(value) {
  if (!DATE_PATTERN.test(String(value ?? ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function spreadsheetText(value) {
  const text = String(value ?? '');
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const safe = typeof value === 'string' ? spreadsheetText(value) : value;
  return `"${String(safe ?? '').replace(/"/g, '""')}"`;
}

function formatGeneratedAt(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(value);
}

function safePublicRows(records) {
  if (!Array.isArray(records)) throw new Error('公开财报数据格式无效。');
  return records.map((record) => {
    if (!validDate(record?.payment_date)) throw new Error('付款日期无效，已停止导出。');
    const cents = amountInCents(record?.amount);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('付款金额无效，已停止导出。');
    const applicantName = String(record?.applicant_name ?? '');
    if (Array.from(applicantName).length > 80) throw new Error('报销人姓名无效，已停止导出。');
    return {
      payment_date: String(record.payment_date),
      applicant_name: applicantName,
      category: String(record.category ?? ''),
      department: String(record.department ?? ''),
      amount: cents / 100,
    };
  });
}

/** Build a UTF-8 CSV from the public page's exact filter snapshot and public fields only. */
export function buildPublicReportCsv({ start, end, category = '', department = '', records, generatedAt = new Date() }) {
  if (!validDate(start) || !validDate(end) || start > end) {
    throw new Error('统计周期无效，已停止导出。');
  }
  const visible = filterPublicRecords(safePublicRows(records), { category, department });
  const lines = [
    ['统计周期', `${start} 至 ${end}`],
    ['费用类别', category || '全部类别'],
    ['部门 / 活动', department || '全部部门 / 活动'],
    ['生成时间（北京时间）', formatGeneratedAt(generatedAt)],
    ['说明', '仅含已付款记录'],
    ['付款日期', '报销人', '费用类别', '部门 / 活动', '金额（元）'],
  ];
  if (visible.length === 0) lines.push(['暂无数据', '', '', '', '']);
  else for (const row of visible) lines.push([row.payment_date, row.applicant_name || '未填写', row.category || '未分类', row.department || '未填写', row.amount.toFixed(2)]);
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function publicReportSnapshotKey(records) {
  return JSON.stringify(safePublicRows(records)
    .map((row) => [row.payment_date, row.applicant_name, row.category, row.department, amountInCents(row.amount)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
