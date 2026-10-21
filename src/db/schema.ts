/**
 * CC记账 · 数据模型（21 张表）
 * 严格对齐 docs/02-数据模型设计.md
 *
 * 约定：
 *  - 金额字段一律 INTEGER，单位「分」
 *  - 时间字段 TEXT（ISO-8601 带时区），日期字段 TEXT（YYYY-MM-DD）
 *  - 布尔字段 INTEGER 0/1
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  primaryKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteTableExtraConfig,
} from 'drizzle-orm/sqlite-core';

/**
 * drizzle-orm 0.36 的表级 extraConfig 仅接受「对象式」。
 * 该 helper 保留「数组式」的可读写法，语义完全等价（键名不影响生成结果，
 * 索引/约束名称由 index()/check() 的显式名称决定）。
 */
function extras(
  ...items: SQLiteTableExtraConfig[string][]
): SQLiteTableExtraConfig {
  return Object.fromEntries(items.map((item, i) => [`e${i}`, item]));
}

/* =====================================================================
 * 一、全局表
 * ===================================================================== */

/** 用户 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    nickname: text('nickname').notNull(),
    avatarPath: text('avatar_path'),
    status: text('status').notNull().default('active'),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    lastLoginAt: text('last_login_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_users_username').on(t.username),
    uniqueIndex('idx_users_email').on(t.email),
    uniqueIndex('idx_users_phone').on(t.phone),
  )
);

/** 刷新令牌（只存哈希，可吊销） */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    deviceInfo: text('device_info'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_rt_token_hash').on(t.tokenHash),
    index('idx_rt_user').on(t.userId, t.revokedAt),
    index('idx_rt_expire').on(t.expiresAt),
  )
);

/** 账本 —— 数据隔离单元 */
export const ledgers = sqliteTable(
  'ledgers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().default('personal'),
    currency: text('currency').notNull().default('CNY'),
    ownerId: text('owner_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    /**
     * 账本图标（lucide 名字）。
     *
     * ⚠️ 可空，且与 `accounts.icon` 同理：**空不是错误**，表示「用户没挑过」。
     * 前端按账本类型回退默认图标，而不是把空值渲染成问号图。
     */
    icon: text('icon'),
    /** 账本备注（这本账是记什么的）。可空，≤ 140 字由应用层校。 */
    note: text('note'),
    currentLedger: integer('current_ledger', { mode: 'boolean' }).notNull().default(false),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(index('idx_ledgers_owner').on(t.ownerId, t.archivedAt)),
);

/** 账本成员 */
export const ledgerMembers = sqliteTable(
  'ledger_members',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    nicknameOverride: text('nickname_override'),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_lm_ledger_user').on(t.ledgerId, t.userId),
    index('idx_lm_user').on(t.userId),
  )
);

/** 账本邀请码 */
export const ledgerInvitations = sqliteTable(
  'ledger_invitations',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    inviterId: text('inviter_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    code: text('code').notNull(),
    role: text('role').notNull().default('member'),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(uniqueIndex('idx_inv_code').on(t.code)),
);

/** 操作审计日志 */
export const ledgerLogs = sqliteTable(
  'ledger_logs',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    summary: text('summary'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_logs_ledger').on(t.ledgerId, t.createdAt),
    index('idx_logs_entity').on(t.entityType, t.entityId),
  )
);

/* =====================================================================
 * 二、账本内主数据表
 * ===================================================================== */

/** 账户分组 */
export const accountGroups = sqliteTable(
  'account_groups',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  // 部分唯一索引：只约束「未停用」的分组，停用即释放名字，允许重建同名分组
  (t) =>
    extras(
      uniqueIndex('idx_ag_ledger_name')
        .on(t.ledgerId, t.name)
        .where(sql`${t.archivedAt} IS NULL`),
    ),
);

/** 账户（含 3 个系统虚拟账户） */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references((): AnySQLiteColumn => accountGroups.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    kind: text('kind').notNull(),
    openingBalance: integer('opening_balance').notNull().default(0),
    openingDate: text('opening_date').notNull(),
    creditLimit: integer('credit_limit'),
    billingDay: integer('billing_day'),
    dueDay: integer('due_day'),
    includeInTotal: integer('include_in_total', { mode: 'boolean' }).notNull().default(true),
    icon: text('icon'),
    note: text('note'),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    lastReconciledAt: text('last_reconciled_at'),
    lastReconciledBalance: integer('last_reconciled_balance'),
    /**
     * 对账后可选锁定：早于该日期的账单禁止 UPDATE / DELETE（docs/03 §3.3）。
     * 注：docs/02 的 accounts DDL 未列此列，但 docs/03 的账务规约要求它存在，
     * 以业务规约为准（纯新增列，对既有数据无影响）。
     */
    lockedBeforeDate: text('locked_before_date'),
    /**
     * 对账排期（`docs/15` R-05）。**按账户设而不是全局设**，因为「现金每周对、
     * 信用卡按账单日对」是**账户性质**决定的，不是用户偏好。
     * - reconcileCycle: 'weekly' | 'monthly' | null（null = 不提醒）
     * - reconcileAnchorDay: 周结时是星期（0=周日）；月结/账单日时是「几号」
     * - reconcileRemindDays: 逾期多少天开始进待办。留 0 或 NULL 时用默认 3。
     */
    reconcileCycle: text('reconcile_cycle'),
    reconcileAnchorDay: integer('reconcile_anchor_day'),
    reconcileRemindDays: integer('reconcile_remind_days'),
    archivedAt: text('archived_at'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_acc_ledger_name').on(t.ledgerId, t.name),
    index('idx_acc_ledger').on(t.ledgerId, t.archivedAt),
    index('idx_acc_group').on(t.groupId),
  )
);

/** 分类（记录类型 → 主类别 → 子类别） */
export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => categories.id, {
      onDelete: 'restrict',
    }),
    level: integer('level').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    /**
     * 现金流三分类（`docs/15` S-17，《企业会计准则第31号——现金流量表》）。
     * operating=经营 / investing=投资 / financing=筹资 / null=未归类。
     * 未归类按**经营**处理（绝大多数日常收支如此），但统计侧要披露覆盖率 ——
     * 静默假定会让「现金流表看起来完整」而实际有一部分是猜的。
     *
     * 为什么标在**分类**上而不是交易上：分类是用户能理解、能维护的层级，
     * 一笔交易通常唯一归属一个分类。反过来给每笔交易打标既无必要也不可维护。
     */
    cashFlow: text('cash_flow'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_cat_unique').on(t.ledgerId, t.recordType, t.parentId, t.name),
    index('idx_cat_tree').on(t.ledgerId, t.recordType, t.level, t.sortOrder),
    index('idx_cat_parent').on(t.parentId),
  )
);

/** 标签 */
export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#8E8E93'),
    sortOrder: integer('sort_order').notNull().default(0),
    useCount: integer('use_count').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(uniqueIndex('idx_tag_ledger_name').on(t.ledgerId, t.name)),
);

/* =====================================================================
 * 三、核心业务表
 * ===================================================================== */

/** 账单（核心表） */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    /**
     * 本笔账单对「主账户」的影响方向 —— docs/12 §7.1 / docs/13 §14.1 定案。
     *
     * 它不是「只给 adjustment 用的增/减」，而是 docs/03 §1.3 影响矩阵里
     * 那列「场景」在数据模型中的落地（此前无任何对应物，导致 receivable/payable
     * 的「产生 / 结算」两阶段无法区分，见 docs/12 §五 D5）。
     *
     *   expense    → decrease
     *   income     → increase
     *   transfer   → decrease
     *   receivable → decrease=借出(产生) / increase=收回(结算)
     *   payable    → none=登记欠款(产生) / decrease=还款(结算)
     *   adjustment → increase=调增 / decrease=调减
     *
     * 与 `account_delta` 互为独立信源：后者是「算出来的」，本列是「传进来的」，
     * 两者符号不一致即视为数据被污染（双源交叉校验）。
     */
    direction: text('direction').notNull(),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id),
    toAccountId: text('to_account_id').references((): AnySQLiteColumn => accounts.id),
    categoryId: text('category_id').references((): AnySQLiteColumn => categories.id),
    parentCategoryId: text('parent_category_id').references((): AnySQLiteColumn => categories.id),

    amount: integer('amount').notNull(),
    fee: integer('fee').notNull().default(0),
    discount: integer('discount').notNull().default(0),
    actualAmount: integer('actual_amount').notNull(),
    accountDelta: integer('account_delta').notNull(),
    toAccountDelta: integer('to_account_delta'),

    name: text('name'),
    merchant: text('merchant'),
    counterparty: text('counterparty'),
    note: text('note'),

    txDate: text('tx_date').notNull(),
    txTime: text('tx_time'),
    occurredAt: text('occurred_at').notNull(),

    templateId: text('template_id').references((): AnySQLiteColumn => templates.id, { onDelete: 'set null' }),
    recurringRuleId: text('recurring_rule_id').references((): AnySQLiteColumn => recurringRules.id, {
      onDelete: 'set null',
    }),
    installmentPlanId: text('installment_plan_id').references((): AnySQLiteColumn => installmentPlans.id, {
      onDelete: 'set null',
    }),
    installmentIndex: integer('installment_index'),
    adjustmentReason: text('adjustment_reason'),
    importHash: text('import_hash'),

    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    updatedBy: text('updated_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    clientRequestId: text('client_request_id'),
  },
  (t) => extras(
    check('ck_amount_positive', sql`${t.amount} > 0`),
    check('ck_amount_max', sql`${t.amount} <= 9999999999`),
    check('ck_fee_non_negative', sql`${t.fee} >= 0`),
    check('ck_discount_non_negative', sql`${t.discount} >= 0`),
    check('ck_name_len', sql`${t.name} IS NULL OR LENGTH(TRIM(${t.name})) <= 50`),
    check(
      'ck_merchant_len',
      sql`${t.merchant} IS NULL OR LENGTH(TRIM(${t.merchant})) <= 50`,
    ),
    check(
      'ck_counterparty_len',
      sql`${t.counterparty} IS NULL OR LENGTH(TRIM(${t.counterparty})) <= 50`,
    ),
    check('ck_note_len', sql`${t.note} IS NULL OR LENGTH(${t.note}) <= 500`),
    check('ck_direction_values', sql`${t.direction} IN ('increase','decrease','none','write_off')`),
    check(
      'ck_direction_by_type',
      sql`(${t.recordType} = 'expense'    AND ${t.direction} = 'decrease') OR
          (${t.recordType} = 'income'     AND ${t.direction} = 'increase') OR
          (${t.recordType} = 'transfer'   AND ${t.direction} = 'decrease') OR
          (${t.recordType} = 'adjustment' AND ${t.direction} IN ('increase','decrease')) OR
          (${t.recordType} = 'receivable' AND ${t.direction} IN ('decrease','increase','write_off')) OR
          (${t.recordType} = 'payable'    AND ${t.direction} IN ('none','decrease','write_off'))`,
    ),
    uniqueIndex('idx_tx_client_req').on(t.clientRequestId),
    index('idx_tx_ledger_date').on(t.ledgerId, t.occurredAt),
    index('idx_tx_account').on(t.ledgerId, t.accountId, t.occurredAt),
    index('idx_tx_to_account').on(t.ledgerId, t.toAccountId, t.occurredAt),
    index('idx_tx_category').on(t.ledgerId, t.parentCategoryId, t.occurredAt),
    index('idx_tx_type_date').on(t.ledgerId, t.recordType, t.occurredAt),
    index('idx_tx_merchant')
      .on(t.ledgerId, t.merchant)
      .where(sql`${t.merchant} IS NOT NULL`),
    index('idx_tx_counterparty')
      .on(t.ledgerId, t.counterparty)
      .where(sql`${t.counterparty} IS NOT NULL`),
    index('idx_tx_recurring').on(t.recurringRuleId, t.occurredAt),
    index('idx_tx_installment').on(t.installmentPlanId, t.installmentIndex),
    index('idx_tx_import_hash').on(t.ledgerId, t.importHash),
    index('idx_tx_deleted').on(t.deletedAt),
  )
);

/**
 * 结清关联：结算 / 核销笔 → 它所冲抵的「产生」笔（docs/12 §六 D9）。
 *
 * **为什么必须建这张表而不是在 `transactions` 上加一个 `settles_tx_id`**：
 * 一笔结清可以同时冲抵多笔产生（「一次把李四的两笔债都还了」），
 * 一笔产生也可以被多次部分结清（800 先还 300、再还 500）。多对多 + 每次金额
 * 都必须留痕，否则「这笔还款还的是哪一笔、还剩多少」在事后无法回答。
 *
 * 权威口径仍是两个虚拟台账（债权 / 债务）的余额 —— 它是 `Σ产生 − Σ结算/核销`
 * 的总额；本表负责把总额**归属**回逐笔，界面上「未结清」逐笔列的就是它。
 *
 * 允许为空引用：`settles` 为空的结算 / 核销笔是合法的（用户不必被迫记账时
 * 就得先想清楚「还的是哪一笔」），只是它的金额不归属到任何一笔，
 * 视图里单列为「未归属冲销」，保证「逐笔未结清之和 + 未归属 = 台账余额」恒等。
 */
export const transactionSettlements = sqliteTable(
  'transaction_settlements',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    /** 结算 / 核销笔：receivable·收回 / 坏账核销、payable·还款 / 债务免除 */
    settleTxId: text('settle_tx_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    /** 被冲抵的产生笔：receivable·借出、payable·登记欠款 */
    originalTxId: text('original_tx_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    /** 本次冲抵金额（分），> 0。同一 settleTxId 的多条之和不得超过该笔 amount */
    amount: integer('amount').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    check('ck_settle_amount_positive', sql`${t.amount} > 0`),
    check('ck_settle_amount_max', sql`${t.amount} <= 9999999999`),
    check('ck_settle_not_self', sql`${t.settleTxId} <> ${t.originalTxId}`),
    uniqueIndex('idx_settle_pk').on(t.settleTxId, t.originalTxId),
    index('idx_settle_original').on(t.originalTxId),
    index('idx_settle_ledger').on(t.ledgerId),
  )
);

/** 账单-标签关联 */
export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: text('transaction_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references((): AnySQLiteColumn => tags.id, { onDelete: 'cascade' }),
  },
  (t) => extras(
    uniqueIndex('idx_tt_pk').on(t.transactionId, t.tagId),
    index('idx_tt_tag').on(t.tagId),
  )
);

/** 账单附件 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id').notNull(),
    transactionId: text('transaction_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    uploaderId: text('uploader_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(index('idx_att_tx').on(t.transactionId)),
);

/* =====================================================================
 * 四、高级功能表
 * ===================================================================== */

/** 模板 */
export const templates = sqliteTable(
  'templates',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    payloadJson: text('payload_json').notNull(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    /**
     * 锁定置顶（`docs/05 §10.6`「模板可锁定（置顶不参与排序）」）。
     * 排序 = `pinned DESC, use_count DESC, last_used_at DESC, sort_order, id` ——
     * 末两项纯粹为了**确定性**：并列时若无 ORDER BY，SQLite 行序会变。
     */
    pinned: integer('pinned', { mode: 'boolean' }).default(false),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_tpl_ledger_name').on(t.ledgerId, t.name),
    index('idx_tpl_rank').on(t.ledgerId, t.useCount, t.lastUsedAt),
  )
);

/** 周期账单规则 */
export const recurringRules = sqliteTable(
  'recurring_rules',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    recordType: text('record_type').notNull().default('expense'),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id),
    toAccountId: text('to_account_id').references((): AnySQLiteColumn => accounts.id),
    categoryId: text('category_id').references((): AnySQLiteColumn => categories.id),
    merchant: text('merchant'),
    counterparty: text('counterparty'),

    frequency: text('frequency').notNull(),
    intervalCount: integer('interval_count').notNull().default(1),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    dayOfMonth: integer('day_of_month'),
    weekDay: integer('week_day'),
    month: integer('month'),
    maxMonthEnd: integer('max_month_end', { mode: 'boolean' }).notNull().default(true),

    amount: integer('amount').notNull(),
    fee: integer('fee').notNull().default(0),
    discount: integer('discount').notNull().default(0),
    title: text('title'),
    note: text('note'),
    tagIdsJson: text('tag_ids_json'),

    generateAheadDays: integer('generate_ahead_days').notNull().default(1),
    autoCreate: integer('auto_create', { mode: 'boolean' }).notNull().default(true),

    lastGeneratedDate: text('last_generated_date'),
    /**
     * 被「跳过单期」标记掉的应生成日期（JSON 数组，docs/05 §11.3）。
     *
     * 为什么必须有这一列：生成逻辑靠 `last_generated_date` 往前走，
     * 单靠它**表达不了「这一期被跳过了」** —— 跳过的那天仍会落在区间内被重新生成。
     * 存成日期数组而不是布尔位，是因为「跳过一次」天然是按期号说的。
     */
    skippedDates: text('skipped_dates'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_recr_gen').on(t.status, t.lastGeneratedDate),
    index('idx_recr_ledger').on(t.ledgerId),
  )
);

/** 分期计划 */
export const installmentPlans = sqliteTable(
  'installment_plans',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    totalAmount: integer('total_amount').notNull(),
    totalFee: integer('total_fee').notNull().default(0),
    installmentCount: integer('installment_count').notNull(),
    frequency: text('frequency').notNull().default('monthly'),
    firstDate: text('first_date').notNull(),
    feeMode: text('fee_mode').notNull().default('once'),
    perPeriodFee: integer('per_period_fee').notNull().default(0),
    feeHandling: text('fee_handling').notNull().default('first_period'),

    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id),
    debtAccountId: text('debt_account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id),
    recordType: text('record_type').notNull().default('expense'),
    categoryId: text('category_id').references((): AnySQLiteColumn => categories.id),
    merchant: text('merchant'),
    note: text('note'),

    status: text('status').notNull().default('active'),
    startTransactionId: text('start_transaction_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(index('idx_plan_ledger').on(t.ledgerId, t.status)),
);

/** 分期每期明细 */
export const installmentSchedules = sqliteTable(
  'installment_schedules',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references((): AnySQLiteColumn => installmentPlans.id, { onDelete: 'cascade' }),
    ledgerId: text('ledger_id').notNull(),
    seq: integer('seq').notNull(),
    dueDate: text('due_date').notNull(),
    principal: integer('principal').notNull(),
    fee: integer('fee').notNull().default(0),
    totalDue: integer('total_due').notNull(),
    status: text('status').notNull().default('pending'),
    paidAt: text('paid_at'),
    repayTxId: text('repay_tx_id').references((): AnySQLiteColumn => transactions.id, { onDelete: 'set null' }),
  },
  (t) => extras(
    uniqueIndex('idx_sched_plan_seq').on(t.planId, t.seq),
    index('idx_sched_plan').on(t.planId, t.status),
    index('idx_sched_due').on(t.ledgerId, t.dueDate, t.status),
  )
);

/** 对账记录 */
export const reconciliationRecords = sqliteTable(
  'reconciliation_records',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id),
    reconcileDate: text('reconcile_date').notNull(),
    systemBalance: integer('system_balance').notNull(),
    actualBalance: integer('actual_balance').notNull(),
    diffAmount: integer('diff_amount').notNull(),
    adjustmentTxId: text('adjustment_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    reasonCode: text('reason_code'),
    reasonNote: text('reason_note'),
    /**
     * 用户确认的差异归因（R-02），JSON 数组，形如
     * `[{"kind":"missing_entry","amount":"280.00","note":"地铁卡充值"}]`。
     *
     * 为什么存 JSON 而不是四个独立列：归因是**多选**（一个差额可能同时由
     * 「漏记 280 + 手续费 20」构成），且 `kind` 的取值还会随产品演进增减
     * （下一步可能加「他人代付」）。固定列会把这两种变化都变成迁移。
     * 需要按 kind 聚合时用 `json_each` 即可，而「复查一次对账的结论」
     * 这个真实场景从来不需要聚合。
     */
    attributionJson: text('attribution_json'),
    operatorId: text('operator_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(index('idx_recon_account').on(t.accountId, t.reconcileDate)),
);

/** 预算 */
export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').references((): AnySQLiteColumn => categories.id),
    periodType: text('period_type').notNull().default('monthly'),
    year: integer('year').notNull(),
    month: integer('month'),
    amount: integer('amount').notNull(),
    rollover: integer('rollover', { mode: 'boolean' }).notNull().default(false),
    alertRatio: integer('alert_ratio').notNull().default(80),
    /**
     * B-07 多周期：自然月只填 year/month（历史数据零改动）；
     * 周预算与自定义账期填 periodStart/periodEnd，month 存起始月。
     *
     * 为什么不重构成一张 periods 表：那会让所有既有的 `WHERE year=? AND month=?`
     * 查询都要改，而它们已经在预算进度、结转、预警里铺开了。
     * 加两列是「按起始月归期」的自然延伸 —— 一个账期只属于一个月份。
     */
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    /** 用户自定义显示名，如「9月第3周」「发薪日账期」 */
    periodLabel: text('period_label'),
    /** B-05：关掉后这条预算不产生任何预警（用户可单独静音某一类） */
    /**
     * ⚠️ 迁移里这一列是**可空**的，不是 NOT NULL DEFAULT。
     * SQLite 的 `ALTER TABLE ADD COLUMN x NOT NULL DEFAULT v` 对已有行不填默认值，
     * 而新行必须显式给值 —— 于是加列后老数据是 NULL、新 INSERT 报
     * NOT NULL constraint failed（本项目在 accounts.reconcile_remind_days 上真踩过）。
     * 默认值在**这一层**给：既有行读到 undefined 时由业务代码 `?? true` 兜底，
     * 新写入的行则由 drizzle 自动填 true。
     */
    alertEnabled: integer('alert_enabled', { mode: 'boolean' }).default(true),
    /**
     * B-12 预算的定位维度：
     *   category → 用 categoryId（历史数据，默认值）
     *   tag      → 用 scopeId 存 tagId
     *   project  → 用 scopeId 存项目 id，projectLabel 存项目名
     *
     * 为什么不用「多一张 tag_budgets 表」：三种预算的**执行逻辑完全相同**
     * （算已花、算剩余、判超支），只有「花在哪」不同。拆表就会让
     * budgetProgress 这类聚合函数要写三遍 —— 而口径出现三份实现，
     * 迟早会出现「分类预算算对了、标签预算算错了」而没人发现。
     */
    scope: text('scope').default('category'),
    scopeId: text('scope_id'),
    projectLabel: text('project_label'),
    /** B-13：'ledger'=全账本可见；'private'=仅 ownerId 可见（协作者的私有额度） */
    visibility: text('visibility').default('ledger'),
    ownerId: text('owner_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    /**
     * 旧索引（只按年月）：自然月账期的唯一性靠它。
     * ⚠️ 它**挡不住周预算** —— 同月 4 条周预算 year/month 完全相同。
     */
    uniqueIndex('idx_budget_unique')
      .on(t.ledgerId, t.categoryId, t.periodType, t.year, t.month)
      // 部分索引：只约束自然月/年度账期。周与自定义账期靠起止日区分，
      // 同一 (ledger, category, year, month) 可以有 4 条周预算。
      .where(sql`${t.periodType} in ('monthly', 'yearly')`),
    /**
     * scope 维度 + **含 period_start/period_end**（B-07 之后新增）。
     *
     * ⚠️ 不含起止日就会挡掉同月的第 2~4 条周预算 —— 本次开发真的踩了：
     * 插入直接 `UNIQUE constraint failed` → 500，而报错完全不提「周预算」。
     *
     * ⚠️ 加了起止日之后，自然月预算的这两列都是 NULL，而 SQLite 的 UNIQUE
     * 里 **NULL ≠ NULL** —— 于是自然月的唯一性在索引层**失效**。
     * 这不是漏洞，是有意的分工：那部分由 `createBudget` 的应用层判重兜住
     * （它显式查一次并正确处理 `isNull` 分支）。两层各管一段。
     */
    uniqueIndex('idx_budget_scope_unique').on(
      t.ledgerId, t.scope, t.scopeId, t.periodType, t.year, t.month, t.periodStart, t.periodEnd,
    ),
    index('idx_budget_ledger').on(t.ledgerId, t.year, t.month),
  )
);

/**
 * 预算调拨记录（`docs/05 §16` 的 B-06，对标 YNAB 的 move money）。
 *
 * ## 为什么要单独一张表，而不是只写审计日志
 *
 * 审计日志（`ledger_logs`）记的是「谁在什么时候改了什么」，格式是 JSON 快照。
 * 但调拨有一个审计日志表达不了的语义：**它是一次原子的、成对的双边调整**。
 * 用户三个月后问「餐饮那 300 块哪来的」，要回答的是：
 * 「3 月从餐饮划了 300 给旅行」—— 需要能**按时间顺序把调拨串成一条链**，
 * 并算出每个分类的「初始设定 vs 累计调入调出」。
 *
 * 所以这里既留了 `fromCategoryId` / `toCategoryId` / `amount` 三列（可查询、可求和），
 * 也仍然写一条审计日志（保证「操作留痕」在审计流里可见）。
 *
 * ⚠️ 调拨**不产生账单**。预算不是钱 —— 调拨改的是「计划」，实际余额一分不动。
 * 早期考虑过复用 `transactions`，那是错的：那会让用户的收支统计凭空多出一笔。
 */
export const budgetTransfers = sqliteTable(
  'budget_transfers',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    fromCategoryId: text('from_category_id')
      .notNull()
      .references((): AnySQLiteColumn => categories.id),
    toCategoryId: text('to_category_id')
      .notNull()
      .references((): AnySQLiteColumn => categories.id),
    /** 正整数（分）。调拨金额恒为正，方向由 from/to 表达 */
    amount: integer('amount').notNull(),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_bt_period').on(t.ledgerId, t.year, t.month),
    index('idx_bt_from').on(t.ledgerId, t.fromCategoryId),
    index('idx_bt_to').on(t.ledgerId, t.toCategoryId),
  )
);

/** 自动分类规则 */
export const categoryRules = sqliteTable(
  'category_rules',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(0),
    matchField: text('match_field').notNull(),
    matchOp: text('match_op').notNull(),
    matchValue: text('match_value').notNull(),
    recordType: text('record_type').notNull(),
    targetCategoryId: text('target_category_id')
      .notNull()
      .references((): AnySQLiteColumn => categories.id),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
  },
  (t) => extras(index('idx_rule_match').on(t.ledgerId, t.enabled, t.priority)),
);

/** 期间关闭 */
export const periodClosures = sqliteTable(
  'period_closures',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    closedAt: text('closed_at').notNull(),
    closedBy: text('closed_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    note: text('note'),
  },
  (t) => extras(uniqueIndex('idx_pc_unique').on(t.ledgerId, t.year, t.month)),
);

/* ======================================================================
 * 以下为 `docs/15`（对标 FRD）51 条需求所需的新增表（迁移 0009~0011）
 * 每张表的注释回答同一个问题：**为什么这样建模，而不是另一种**。
 * ====================================================================== */

/** 银行流水批次（`docs/15` R-06 流水导入 / R-14 银行同步的落地形态） */
export const bankStatements = sqliteTable(
  'bank_statements',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id, { onDelete: 'cascade' }),
    source: text('source').notNull().default('manual'),
    statementMonth: text('statement_month').notNull(),
    filename: text('filename'),
    rowCount: integer('row_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_stmt_account').on(t.accountId, t.statementMonth),
    index('idx_stmt_ledger').on(t.ledgerId),
  ),
);

/**
 * 银行流水明细行（`docs/15` R-07/R-08）。
 *
 * ⚠️ **这张表永不进业务库**。匹配确认后由 `POST /transactions` 落业务表，
 * 这里只做「暂存 + 匹配工作台」。理由见 0009 迁移的头部说明。
 */
export const bankStatementLines = sqliteTable(
  'bank_statement_lines',
  {
    id: text('id').primaryKey(),
    statementId: text('statement_id')
      .notNull()
      .references((): AnySQLiteColumn => bankStatements.id, { onDelete: 'cascade' }),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id, { onDelete: 'cascade' }),
    txDate: text('tx_date').notNull(),
    /**
     * debit=银行扣钱（对客户是支出）/ credit=银行进钱。
     *
     * ⚠️ 与 `transactions.direction` 是**两套独立符号约定**，绝不能混用：
     * 银行站在客户对立面，它的 debit 表示客户的钱少了。
     * 两边同名不同义 —— 混用会让所有导入的收支方向翻转而不报错。
     */
    direction: text('direction').notNull(),
    amount: integer('amount').notNull(),
    merchant: text('merchant'),
    description: text('description'),
    balanceAfter: integer('balance_after'),
    /** unmatched 未找到候选 · suspected 疑似（需人工确认）· matched 已配对 · ignored 用户排除 */
    matchState: text('match_state').notNull().default('unmatched'),
    matchedTxId: text('matched_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    matchScore: integer('match_score'),
    /** 人类可读的匹配依据，如「金额唯一 + 日期 ±1 天」—— 用户要能自己判断可信度 */
    matchReason: text('match_reason'),
    excludedReason: text('excluded_reason'),
    rowNo: integer('row_no').notNull(),
    rawJson: text('raw_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_line_statement').on(t.statementId),
    index('idx_line_match').on(t.accountId, t.matchState),
    index('idx_line_date').on(t.ledgerId, t.txDate),
    check('bank_line_direction', sql`${t.direction} IN ('debit','credit')`),
    check(
      'bank_line_match_state',
      sql`${t.matchState} IN ('unmatched','suspected','matched','ignored')`,
    ),
  ),
);

/**
 * 未达账项（`docs/15` R-09，个人版银行存款余额调节表）。
 *
 * 会计上的标准做法：账面余额 ± 未达账项 = 银行对账单余额。
 * 分类不是自创的，是《会计基础工作规范》的标准两类：
 *   side='positive' 银行已记我未记（在途存款）→ 调增账面
 *   side='negative' 我已记银行未记（未兑现支票）→ 调减账面
 */
export const reconAdjustingItems = sqliteTable(
  'recon_adjusting_items',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references((): AnySQLiteColumn => accounts.id, { onDelete: 'cascade' }),
    side: text('side').notNull(),
    itemDate: text('item_date').notNull(),
    amount: integer('amount').notNull(),
    /** in_transit 在途 · deposit_in_transit 在途存款 · outstanding_check 未兑现支票 · bank_error 银行串户 · our_error 我方记账错 */
    kind: text('kind').notNull(),
    note: text('note'),
    relatedTxId: text('related_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    /** NULL = 仍未达（下一期调节表里还在）；有值 = 已达账 */
    clearedAt: text('cleared_at'),
    clearedTxId: text('cleared_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_adj_account').on(t.accountId, t.clearedAt),
    index('idx_adj_ledger').on(t.ledgerId, t.itemDate),
    check('recon_adj_side', sql`${t.side} IN ('positive','negative')`),
  ),
);

/**
 * 重复扣费 / 订阅识别（`docs/15` R-12 / S-16 / X-07）。
 *
 * 自动识别出的候选**不落库**（每次算就行），但用户确认或忽略之后必须记下来 ——
 * 否则每次刷新都弹同一个提醒，那不是提醒，是骚扰。
 */
export const recurringDetections = sqliteTable(
  'recurring_detections',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').references((): AnySQLiteColumn => accounts.id, {
      onDelete: 'set null',
    }),
    /** sha1(merchant|分|periodType) —— 同一订阅在不同月份的账单认得出是同一个 */
    fingerprint: text('fingerprint').notNull(),
    merchant: text('merchant').notNull(),
    periodType: text('period_type').notNull(),
    amount: integer('amount').notNull(),
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
    occurrenceCount: integer('occurrence_count').notNull(),
    lastTxId: text('last_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('candidate'),
    userLabel: text('user_label'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_rd_fingerprint').on(t.ledgerId, t.fingerprint),
    index('idx_rd_ledger').on(t.ledgerId, t.status),
    check(
      'rd_status',
      sql`${t.status} IN ('candidate','confirmed','ignored')`,
    ),
  ),
);

/** B-05 预警去重（同一账期同一档位只提醒一次） */
export const budgetAlerts = sqliteTable(
  'budget_alerts',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    budgetId: text('budget_id')
      .notNull()
      .references((): AnySQLiteColumn => budgets.id, { onDelete: 'cascade' }),
    periodKey: text('period_key').notNull(),
    level: text('level').notNull(),
    triggeredAt: text('triggered_at').notNull(),
    notifiedAt: text('notified_at'),
  },
  (t) => extras(
    uniqueIndex('idx_ba_dedupe').on(t.budgetId, t.periodKey, t.level),
    index('idx_ba_ledger').on(t.ledgerId, t.triggeredAt),
  ),
);

/**
 * B-05 免打扰与全局默认阈值。
 * 挂**账本**而不是用户：同一账本的协作者（B-13）应共享同一套打扰设置，
 * 否则 A 静音了 B 还在被吵 —— 那不是「个性化」，那是通知失效。
 */
export const budgetPrefs = sqliteTable('budget_prefs', {
  ledgerId: text('ledger_id')
    .primaryKey()
    .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
  defaultAlertRatio: integer('default_alert_ratio').notNull().default(80),
  dndEnabled: integer('dnd_enabled', { mode: 'boolean' }).notNull().default(false),
  dndFrom: text('dnd_from'),
  dndTo: text('dnd_to'),
  notifyOnCreate: integer('notify_on_create', { mode: 'boolean' }).notNull().default(true),
  /**
   * 预测的最小样本天数。用 1 天消费外推整月是统计胡来（今天买台家电就外推 30 倍），
   * 样本不足时宁可不给预测 —— 「还不知道」不能写成「确认没问题」。
   */
  predictionMinDays: integer('prediction_min_days').notNull().default(3),
  updatedAt: text('updated_at').notNull(),
});

/** B-08 周期结转记录（清零 / 信封滚存 / 划入储蓄） */
export const budgetRollovers = sqliteTable(
  'budget_rollovers',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    fromBudgetId: text('from_budget_id').references((): AnySQLiteColumn => budgets.id, {
      onDelete: 'cascade',
    }),
    toBudgetId: text('to_budget_id').references((): AnySQLiteColumn => budgets.id, {
      onDelete: 'cascade',
    }),
    fromPeriod: text('from_period').notNull(),
    toPeriod: text('to_period').notNull(),
    mode: text('mode').notNull(),
    amount: integer('amount').notNull(),
    /** 结转时的结余快照。存它是为了让「上个月剩的 300 块去哪了」可复查 */
    remainingAtClose: integer('remaining_at_close').notNull(),
    note: text('note'),
    reversedAt: text('reversed_at'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_rollover_ledger').on(t.ledgerId, t.fromPeriod),
    index('idx_rollover_target').on(t.toBudgetId),
    check('rollover_mode', sql`${t.mode} IN ('clear','carry','to_savings')`),
  ),
);

/**
 * B-09 专项预算池（sinking funds / 存钱罐）。
 *
 * 为什么不复用 budgets：年缴类支出（车险 6000/月缴）每月存 500，年底一次性付。
 * 它与分类预算的本质差别是**当期没有支出** —— 放进 budgets 会被
 * 「已花 0、剩余 6000」显示成「这个月一分钱没花」，而实际每月都在存钱。
 */
export const budgetPools = sqliteTable(
  'budget_pools',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetAmount: integer('target_amount').notNull(),
    /** 目标日期决定预提期数：「还剩几个月」由它算出 */
    targetDate: text('target_date').notNull(),
    savedAmount: integer('saved_amount').notNull().default(0),
    savingsAccountId: text('savings_account_id').references((): AnySQLiteColumn => accounts.id, {
      onDelete: 'set null',
    }),
    expenseCategoryId: text('expense_category_id').references(
      (): AnySQLiteColumn => categories.id,
      { onDelete: 'set null' },
    ),
    status: text('status').notNull().default('active'),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(
    index('idx_pool_ledger').on(t.ledgerId, t.status),
    check('pool_status', sql`${t.status} IN ('active','fulfilled','archived')`),
  ),
);

/**
 * 专项池的每一笔存取。
 * 为什么要流水而不只留余额：年底复盘「我今年为车险存了多少钱」必须能从流水算出来；
 * 只存余额就只能看到当下有多少，看不到中途动过没有。
 */
export const budgetPoolEntries = sqliteTable(
  'budget_pool_entries',
  {
    id: text('id').primaryKey(),
    poolId: text('pool_id')
      .notNull()
      .references((): AnySQLiteColumn => budgetPools.id, { onDelete: 'cascade' }),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    amount: integer('amount').notNull(),
    occurredOn: text('occurred_on').notNull(),
    relatedTxId: text('related_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_pool_entry').on(t.poolId, t.occurredOn),
    check(
      'pool_entry_kind',
      sql`${t.kind} IN ('contribute','spend','adjust','refund')`,
    ),
  ),
);

/** B-11 预算模板（推荐值是算出来的，采纳过的方案要存才能复用） */
export const budgetTemplates = sqliteTable(
  'budget_templates',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    note: text('note'),
    itemsJson: text('items_json').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(index('idx_btpl_ledger').on(t.ledgerId)),
);

/** B-06 预算变更留痕（调拨有独立表，但「改了金额」这类直接修改走这里） */
export const budgetChanges = sqliteTable(
  'budget_changes',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    budgetId: text('budget_id').references((): AnySQLiteColumn => budgets.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    note: text('note'),
    actorId: text('actor_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    index('idx_bchange_budget').on(t.budgetId, t.createdAt),
    index('idx_bchange_ledger').on(t.ledgerId, t.createdAt),
  ),
);

/**
 * S-09 净资产月末快照。
 *
 * 为什么必须存快照而不能「每月调一次接口」：
 *  ① 上个月末的余额是多少是**历史事实**，不会随今天的操作改变；
 *  ② 软删账单、账户归档、期初余额修改都会改写历史余额 —— 不存快照，
 *     「这个月比上个月涨了多少」会在用户改一笔旧账后悄悄变样。
 */
export const netWorthSnapshots = sqliteTable(
  'net_worth_snapshots',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    /** 月末（'2026-09-30'），不是月初 */
    snapshotDate: text('snapshot_date').notNull(),
    assetTotal: integer('asset_total').notNull(),
    liabilityTotal: integer('liability_total').notNull(),
    netWorth: integer('net_worth').notNull(),
    accountCount: integer('account_count').notNull(),
    /** X-05 口径版本：同一张表在不同口径下算出的数字可能不同，必须记下用哪一版算的 */
    policyVersion: text('policy_version').notNull(),
    valuationNote: text('valuation_note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(
    uniqueIndex('idx_nw_unique').on(t.ledgerId, t.snapshotDate),
    index('idx_nw_ledger').on(t.ledgerId, t.snapshotDate),
  ),
);

/**
 * X-05 口径版本化。
 * 记录每次口径变更，且**历史不回溯重算** —— 这是会计原则也是产品原则：
 * 用户在 3 月看到的「2 月支出 3000」，不该因为 4 月改了口径就变成 3200，
 * 那会让所有历史报表失去可信度。新口径只对新数据生效。
 */
export const statsPolicyVersions = sqliteTable(
  'stats_policy_versions',
  {
    /**
     * ⚠️ **不是**单独主键 —— 与 `ledger_id` 组成复合主键（见迁移 0012）。
     *
     * 口径版本是**账本内部**的记账约定（"v2 起内部转账不计收支"），
     * 两个账本各自叫 v2 完全合理。全局唯一会让「A 账本建了 v2」之后
     * B 账本**永远建不出** v2 —— 实测表现是 B 账本 POST /stats/policies
     * 直接 500（UNIQUE constraint failed），而报错栈指向 insert，
     * 完全看不出是建表时主键选错了。
     */
    version: text('version').notNull(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    effectiveFrom: text('effective_from').notNull(),
    changesJson: text('changes_json').notNull(),
    note: text('note'),
    createdBy: text('created_by').references((): AnySQLiteColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
  },
  (t) =>
    extras(
      primaryKey({ columns: [t.version, t.ledgerId] }),
      index('idx_policy_ledger').on(t.ledgerId, t.effectiveFrom),
    ),
);

/** S-11 事件标注：让同比/趋势有解释力（「涨 60% 是因为装修」） */
export const statEvents = sqliteTable(
  'stat_events',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    /** 挂日而不是挂月，这样同一事件能同时出现在日粒度与月粒度视图 */
    eventDate: text('event_date').notNull(),
    title: text('title').notNull(),
    note: text('note'),
    /** 预期金额（分），用于「超出预期多少」 */
    expectedAmount: integer('expected_amount'),
    tagId: text('tag_id').references((): AnySQLiteColumn => tags.id, { onDelete: 'set null' }),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(index('idx_event_ledger').on(t.ledgerId, t.eventDate)),
);

/**
 * S-12 自定义报表方案。
 *
 * 配置用 JSON 存，不预先为每个维度组合开一张表 —— 那是钱迹「配置十分钟」的成因。
 * 报表配置是**用户自己定义**的，形状由用户决定，先用 JSON 承载。
 */
export const savedReports = sqliteTable(
  'saved_reports',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** { groupBy: ['category','account'], metrics: ['expense'], range: 'thisMonth', filters: {} } */
    configJson: text('config_json').notNull(),
    /** 内置预设不能删，只能复制后改 */
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(index('idx_report_ledger').on(t.ledgerId, t.sortOrder)),
);

/**
 * X-06 报销冲减。
 *
 * 业务事实：先垫付 500（记入「差旅」支出），后公司报销 500 到账。
 * 会计上正确做法是**冲减原分类的支出**而非记一笔收入 ——
 * 这笔钱从未是收入，它是资产（应收报销款）的收回。
 * 若记收入：本月支出仍是 500、收入多 500，净结余看起来一样，
 * 但分类支出虚高，预算与分类统计全错。
 *
 * `receivedTxId` 必须真实存在于 transactions —— 报销到账是真实的现金流入，
 * 不记账等于账实不符。「它冲减了哪笔支出」是这条记录独有的语义。
 */
export const reimbursements = sqliteTable(
  'reimbursements',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    originTxId: text('origin_tx_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    receivedTxId: text('received_tx_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    claimDate: text('claim_date').notNull(),
    receivedDate: text('received_date').notNull(),
    orgName: text('org_name'),
    note: text('note'),
    status: text('status').notNull().default('confirmed'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => extras(
    index('idx_reimb_origin').on(t.originTxId),
    index('idx_reimb_ledger').on(t.ledgerId, t.receivedDate),
    check('reimb_status', sql`${t.status} IN ('pending','confirmed','void')`),
  ),
);

/**
 * X-02 跨期修订留痕。
 * 对账时发现的上月漏记，补记到上月 —— 数据写在上月，但**动作发生在本月**。
 * 报表按 txDate 归期（所以预算与统计自动正确），
 * 这张表回答「这些数字是什么时候被改的」。
 */
export const backdatedAdjustments = sqliteTable(
  'backdated_adjustments',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    txId: text('tx_id')
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: 'cascade' }),
    /** 账务归属期（= txDate 所在月） */
    effectivePeriod: text('effective_period').notNull(),
    /** 记账动作实际发生的日期（= 今天） */
    recordedOn: text('recorded_on').notNull(),
    daysLate: integer('days_late').notNull(),
    source: text('source').notNull(),
    reconRecordId: text('recon_record_id').references(
      (): AnySQLiteColumn => reconciliationRecords.id,
      { onDelete: 'set null' },
    ),
    note: text('note'),
    createdBy: text('created_by')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(index('idx_backdated').on(t.ledgerId, t.recordedOn)),
);

/** X-03 解锁留痕：解锁后可改历史数，是高风险动作，必须记理由 */
export const periodReopenLogs = sqliteTable(
  'period_reopen_logs',
  {
    id: text('id').primaryKey(),
    ledgerId: text('ledger_id')
      .notNull()
      .references((): AnySQLiteColumn => ledgers.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    reason: text('reason').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references((): AnySQLiteColumn => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => extras(index('idx_reopen_ledger').on(t.ledgerId, t.createdAt)),
);
