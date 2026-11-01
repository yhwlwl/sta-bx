export const amountInCents = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

export function filterPublicRecords(records, { category = '', department = '' } = {}) {
  return records.filter((record) => (!category || record.category === category) && (!department || record.department === department));
}

export function summarizePublicRecords(records) {
  const totalCents = records.reduce((sum, record) => sum + amountInCents(record.amount), 0);
  const months = new Map();
  const categories = new Map();
  for (const record of records) {
    const month = String(record.payment_date || '').slice(0, 7);
    if (month) {
      const current = months.get(month) || { month, count: 0, totalCents: 0 };
      current.count += 1;
      current.totalCents += amountInCents(record.amount);
      months.set(month, current);
    }
    const category = String(record.category || '未分类');
    const current = categories.get(category) || { category, count: 0, totalCents: 0 };
    current.count += 1;
    current.totalCents += amountInCents(record.amount);
    categories.set(category, current);
  }
  return {
    totalCents,
    count: records.length,
    averageCents: records.length ? Math.round(totalCents / records.length) : 0,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...categories.values()].sort((a, b) => b.totalCents - a.totalCents || a.category.localeCompare(b.category)),
  };
}
