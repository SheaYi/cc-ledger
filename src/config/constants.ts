/** 全局常量与枚举字典（对齐 docs/02 第六节、docs/08） */

export const APP_NAME = 'CC记账';

// ---------- 记录类型（6 种，固定） ----------
export const RECORD_TYPES = [
  'expense',
  'income',
  'transfer',
  'receivable',
  'payable',
  'adjustment',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  receivable: '应收款项',
  payable: '应付款项',
  adjustment: '余额调整',
};

/** 需要分类的记录类型 */
export const RECORD_TYPES_WITH_CATEGORY: readonly RecordType[] = [
  'expense',
  'income',
  'receivable',
  'payable',
];

/** 需要目标账户的记录类型（转账的转入方；应收/应付的债权债务账户由后端按 kind 解析） */
export const RECORD_TYPES_WITH_TO_ACCOUNT: readonly RecordType[] = ['transfer'];

// ---------- 账单主账户流向（docs/12 §7.1、docs/13 §14.1 定案） ----------
/**
 * `direction` 的语义 = **本笔账单对「主账户」的影响方向**，
 * 不是「只给 adjustment 用的增/减」。它补齐的是 docs/03 §1.3 影响矩阵里那列「场景」
 * ——在数据模型里此前没有任何对应物。
 */
export const TX_DIRECTIONS = ['increase', 'decrease', 'none', 'write_off'] as const;
export type TxDirection = (typeof TX_DIRECTIONS)[number];

export const TX_DIRECTION_LABEL: Record<TxDirection, string> = {
  increase: '增加',
  decrease: '减少',
  none: '不影响',
  write_off: '核销',
};

/** 每种记录类型的合法 direction —— 与 DDL 的 ck_direction_by_type 一一对应 */
export const DIRECTION_BY_RECORD_TYPE: Record<RecordType, readonly TxDirection[]> = {
  expense: ['decrease'],
  income: ['increase'],
  transfer: ['decrease'],
  adjustment: ['increase', 'decrease'],
  /**
   * decrease = 借出（产生）／ increase = 收回（结算）／ write_off = 坏账核销（终态）
   *
   * `write_off` 是 docs/12 §六 D10 补的第三阶段：确认这笔钱收不回来。
   * 它的账务处理是**纯台账冲销** —— 主账户不动、现金不动、**不进损益**
   * （钱在借出那一刻就已经离开净资产了，核销只是不再预期收回；
   *  按小企业会计准则走的是资产减值备抵，这里不进损益是个人记账的简化口径）。
   */
  receivable: ['decrease', 'increase', 'write_off'],
  /** none = 登记欠款（产生，主账户不动）／ decrease = 还款（结算）／ write_off = 债务免除 */
  payable: ['none', 'decrease', 'write_off'],
};

/** 新建时的默认方向（= 各类型的「产生」阶段） */
export const DEFAULT_DIRECTION: Record<RecordType, TxDirection> = {
  expense: 'decrease',
  income: 'increase',
  transfer: 'decrease',
  adjustment: 'decrease',
  receivable: 'decrease',
  payable: 'none',
};

/**
 * 各类型「阶段」的用户可读名。
 * 用于扩展数据与列表展示，不参与金额计算。
 */
export const DIRECTION_STAGE_LABEL: Partial<
  Record<RecordType, Partial<Record<TxDirection, string>>>
> = {
  receivable: { decrease: '借出', increase: '收回', write_off: '坏账核销' },
  payable: { none: '登记欠款', decrease: '还款', write_off: '债务免除' },
  adjustment: { increase: '调增', decrease: '调减' },
  transfer: { decrease: '转出' },
};

/**
 * 「结算类」阶段：会冲减债权 / 债务台账的阶段。
 * 其中 `increase`/`decrease` 是**结算**（现金对冲），`write_off` 是**核销**（现金不动）。
 * 「产生类」阶段（借出 / 登记欠款）才会增加台账。
 */
export const SETTLE_DIRECTIONS: readonly TxDirection[] = ['increase', 'decrease', 'write_off'];
/** 会增加债权 / 债务台账的阶段 */
export const ORIGIN_DIRECTIONS: Partial<Record<RecordType, readonly TxDirection[]>> = {
  receivable: ['decrease'],
  payable: ['none'],
};

// ---------- 账户类型（12 种） ----------
export const ACCOUNT_TYPES = [
  'cash',
  'debit_card',
  'credit_card',
  'third_party',
  'prepaid',
  'investment',
  'fixed_deposit',
  'loan',
  'receivable',
  'payable',
  'fee',
  'other',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountKind = 'asset' | 'liability' | 'virtual';

export const ACCOUNT_TYPE_META: Record<
  AccountType,
  { label: string; kind: AccountKind; groupKey: string }
> = {
  cash: { label: '现金', kind: 'asset', groupKey: 'grp_cash' },
  debit_card: { label: '储蓄卡/借记卡', kind: 'asset', groupKey: 'grp_bank' },
  credit_card: { label: '信用卡', kind: 'liability', groupKey: 'grp_credit' },
  third_party: { label: '微信/支付宝/云闪付', kind: 'asset', groupKey: 'grp_thirdparty' },
  prepaid: { label: '储值卡/交通卡', kind: 'asset', groupKey: 'grp_thirdparty' },
  investment: { label: '基金/股票/理财', kind: 'asset', groupKey: 'grp_invest' },
  fixed_deposit: { label: '定期/大额存单', kind: 'asset', groupKey: 'grp_invest' },
  loan: { label: '房贷/车贷/借款', kind: 'liability', groupKey: 'grp_invest' },
  receivable: { label: '债权（借出）', kind: 'virtual', groupKey: 'grp_virtual' },
  payable: { label: '债务（欠款）', kind: 'virtual', groupKey: 'grp_virtual' },
  fee: { label: '手续费/财务费用', kind: 'virtual', groupKey: 'grp_virtual' },
  other: { label: '其他', kind: 'asset', groupKey: 'grp_cash' },
};

/**
 * 系统虚拟账户（每个账本自动创建，不可删除）
 *
 * ⚠️ `icon` 必须给全：虚拟账户是种子插入的，用户不会去编辑它们，
 * 而 `accounts.icon` 是可空列 —— 漏写就是账户列表里三个**空白图标槽**
 * （`entityIcon('')` 返回空串，不报错、不占位，只是图标位置空着）。
 * 图标名取自前端 `public/assets/lucide-data.js` 的 LUCIDE 键，须与
 * `public/assets/ui.js` 的 `ACCOUNT_TYPE_ICON` 同名，两边同源才不会画不出来。
 */
export const SYSTEM_VIRTUAL_ACCOUNTS = [
  { key: 'acc_sys_receivable', name: '债权（借出）', type: 'receivable' as AccountType, icon: 'hand-coins' },
  { key: 'acc_sys_payable', name: '债务（欠款）', type: 'payable' as AccountType, icon: 'heart-handshake' },
  { key: 'acc_sys_fee', name: '手续费/财务费用', type: 'fee' as AccountType, icon: 'circle-percent' },
] as const;

/**
 * 虚拟账户的「期初日期」。
 *
 * 余额公式（docs/03 §2.1）只累计 `tx_date ≥ opening_date` 的流水。虚拟账户是
 * **台账/对方科目**（债权、债务、手续费累计），期初余额恒为 0，它应当从账本起点
 * 开始累计全部流水 —— 若沿用建账当天为期初日，则**建账当天记的账不会进入债权账户**
 * （曾被 `>` 严格大于排除），应收/应付/手续费一律显示为 0。
 * 故这里取一个足够早的固定日期。
 */
export const LEDGER_EPOCH = '1970-01-01';

/**
 * 余额口径变更日：`opening_date < tx_date` → `opening_date ≤ tx_date`（docs/14）。
 *
 * 存在的唯一目的是**披露**：`reconciliation_records.system_balance` 存的是
 * **生成那一刻**按当时口径算出的**快照**，改口径不会回头重算它。所以同一账户
 * 在变更日前后的两次对账，`systemBalance` **不可直接比较**，界面必须标出来。
 *
 * 判据用记录的 `createdAt`（不是 `reconcileDate`）—— 决定口径的是"什么时候算的"。
 */
export const BALANCE_BOUNDARY_CHANGE_DATE = '2026-10-14';

// ---------- 角色 ----------
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

// ---------- 用户 / 账本状态 ----------
export const USER_STATUSES = ['active', 'disabled'] as const;
export const LEDGER_TYPES = ['personal', 'shared'] as const;
export const LEDGER_STATUS_ARCHIVED = 'archived';

// ---------- 标签色盘（8 色循环） ----------
export const TAG_COLORS = [
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#34C759',
  '#007AFF',
  '#AF52DE',
  '#8E8E93',
  '#636366',
] as const;

// ---------- 记账方向（adjustment 专用） ----------
export const ADJUSTMENT_DIRECTIONS = ['increase', 'decrease'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

// ---------- 对账差异原因码 ----------
export const RECONCILE_REASONS = [
  'unrecorded_expense',
  'unrecorded_income',
  'bank_fee',
  'interest',
  'fx_diff',
  'history_missing',
  'entry_error',
  'other',
] as const;
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export const RECONCILE_REASON_LABEL: Record<ReconcileReason, string> = {
  unrecorded_expense: '未记账消费',
  unrecorded_income: '未记账收入',
  bank_fee: '银行手续费',
  interest: '利息',
  fx_diff: '汇率差异',
  history_missing: '历史遗漏',
  entry_error: '录入错误',
  other: '其他',
};

// ---------- 业务限制 ----------
export const LIMITS = {
  MERCHANT_MAX_LEN: 50,
  COUNTERPARTY_MAX_LEN: 50,
  NAME_MAX_LEN: 50,
  NOTE_MAX_LEN: 500,
  /**
   * 单笔名义金额上限（分）= ¥99,999,999.99。
   * 依据 docs/13 §13.3 场景 3：个人/家庭场景足够宽裕，且远小于 2^53，
   * 避免整数分转字符串时的精度风险。DDL 有 ck_amount_max 兜底。
   */
  AMOUNT_MAX_CENTS: 9_999_999_999,
  USERNAME_MIN: 3,
  USERNAME_MAX: 32,
  PASSWORD_MIN: 8,
  AVATAR_MAX_BYTES: 2 * 1024 * 1024,
  ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
  IMPORT_MAX_ROWS: 20000,
  IMPORT_MAX_BYTES: 20 * 1024 * 1024,
  TRASH_RETENTION_DAYS: 30,
} as const;
