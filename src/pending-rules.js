import { hasRole } from './workflow-rules.js';

// 工作台待办分组（Issue #9）。key / status 必须与迁移里 private.app_pending_bucket 的状态映射、
// 以及 app-api 顶部的 PENDING_BUCKETS 保持一致（tests/pending-reminders.test.mjs 逐项比对）。
// scope=team 是"以处理身份处理别人的申请"，scope=mine 是"申请人自己名下的待办"。
export const PENDING_BUCKETS = [
  { key: 'finance', label: '待财委审批', status: 'finance_pending', role: 'finance', scope: 'team' },
  { key: 'chair', label: '待主席审批', status: 'chair_pending', role: 'chair', scope: 'team' },
  { key: 'payment', label: '待付款登记', status: 'payment_pending', role: 'cashier', scope: 'team' },
  { key: 'returned', label: '退回修改', status: 'changes_requested', role: null, scope: 'mine' },
  { key: 'qr', label: '待补充收款码', status: 'payment_info_required', role: null, scope: 'mine' },
];
export const PENDING_BUCKET_KEYS = PENDING_BUCKETS.map((bucket) => bucket.key);
export const bucketOf = (key) => PENDING_BUCKETS.find((bucket) => bucket.key === key) || null;
export const bucketLabel = (key) => bucketOf(key)?.label || key;
// 当前身份能看到的分组：处理身份走 hasRole（财委即付款登记、内置 admin 跨身份、普通 admin 不算），
// 自己的待办对每个人都成立。所以普通管理员不会因为 admin 角色拿到流程待办。
export const visibleBuckets = (identity) => PENDING_BUCKETS.filter((bucket) => bucket.scope === 'mine' || hasRole(identity, bucket.role));
export const visibleBucketKeys = (identity) => visibleBuckets(identity).map((bucket) => bucket.key);
// 汇总用的是待办清单本身，所以角标数量与列表条数永远来自同一份数据。
// 只有服务端明确回传 unread:false 才算已读；字段缺失按未读处理（宁可多提醒一次）。
export function summarizePending(items) {
  const rows = Array.isArray(items) ? items : [];
  const buckets = PENDING_BUCKETS.map((bucket) => {
    const matched = rows.filter((item) => item?.bucket === bucket.key);
    return { ...bucket, pending: matched.length, unread: matched.filter((item) => item.unread !== false).length };
  });
  const unreadOf = (scope) => buckets.filter((bucket) => bucket.scope === scope).reduce((sum, bucket) => sum + bucket.unread, 0);
  const unreadTeam = unreadOf('team');
  const unreadMine = unreadOf('mine');
  return { buckets, unreadTeam, unreadMine, unreadTotal: unreadTeam + unreadMine, total: rows.length };
}
// bucket 为空时返回全部待办（工作台的"全部"视图）。
export const pendingItemsOf = (items, bucket) => (Array.isArray(items) ? items : []).filter((item) => !bucket || item?.bucket === bucket);
