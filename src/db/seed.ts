import type { Db } from './client.js';
import { accountGroups, accounts, categories, tags, templates } from './schema.js';
import {
  DEFAULT_ACCOUNT_GROUPS,
  DEFAULT_CATEGORY_TREES,
  DEFAULT_TAGS,
  DEFAULT_TEMPLATES,
} from './seed-data.js';
import {
  ACCOUNT_TYPE_META,
  LEDGER_EPOCH,
  SYSTEM_VIRTUAL_ACCOUNTS,
} from '../config/constants.js';
import { nowIso } from '../utils/money.js';

/** 同一账本内的稳定主键：`${ledgerId}#${key}`，保证跨账本不冲突 */
export function seedId(ledgerId: string, key: string): string {
  return `${ledgerId}#${key}`;
}

export interface SeedResult {
  groups: number;
  accounts: number;
  categories: number;
  tags: number;
  templates: number;
}

/**
 * 幂等地为新账本写入全部预置数据（docs/08）。
 * 依赖确定性主键 + ON CONFLICT DO NOTHING，重复调用不产生重复记录。
 */
export function seedLedgerDefaults(
  db: Db,
  ledgerId: string,
  ownerUserId: string,
): SeedResult {
  const at = nowIso();
  const result: SeedResult = { groups: 0, accounts: 0, categories: 0, tags: 0, templates: 0 };

  db.transaction((tx) => {
    // ---------- 1. 账户分组（6 个） ----------
    for (const g of DEFAULT_ACCOUNT_GROUPS) {
      const r = tx
        .insert(accountGroups)
        .values({
          id: seedId(ledgerId, g.key),
          ledgerId,
          name: g.name,
          kind: g.kind,
          icon: g.icon,
          sortOrder: g.sortOrder,
          isDefault: true,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      result.groups += r.changes;
    }

    // ---------- 2. 系统虚拟账户（3 个） ----------
    const virtualGroupId = seedId(ledgerId, 'grp_virtual');
    for (const [idx, va] of SYSTEM_VIRTUAL_ACCOUNTS.entries()) {
      const meta = ACCOUNT_TYPE_META[va.type];
      const r = tx
        .insert(accounts)
        .values({
          id: seedId(ledgerId, va.key),
          ledgerId,
          groupId: virtualGroupId,
          name: va.name,
          type: va.type,
          icon: va.icon,
          kind: meta.kind,
          openingBalance: 0,
          // 虚拟账户是台账，从账本起点累计（见 LEDGER_EPOCH 的注释）
          openingDate: LEDGER_EPOCH,
          includeInTotal: false,
          sortOrder: idx + 1,
          isDefault: true,
          createdBy: ownerUserId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .run();
      result.accounts += r.changes;
    }

    // ---------- 3. 分类树（记录类型 → 主类别 → 子类别） ----------
    for (const tree of DEFAULT_CATEGORY_TREES) {
      let parentSort = 0;
      for (const parent of tree.parents) {
        parentSort += 1;
        const parentId = seedId(ledgerId, parent.key);
        const rp = tx
          .insert(categories)
          .values({
            id: parentId,
            ledgerId,
            recordType: tree.recordType,
            parentId: null,
            level: 1,
            name: parent.name,
            icon: parent.icon,
            sortOrder: parentSort,
            isDefault: true,
            createdAt: at,
          })
          .onConflictDoNothing()
          .run();
        result.categories += rp.changes;

        let childSort = 0;
        for (const child of parent.children) {
          childSort += 1;
          const rc = tx
            .insert(categories)
            .values({
              id: seedId(ledgerId, child.key),
              ledgerId,
              recordType: tree.recordType,
              parentId,
              level: 2,
              name: child.name,
              icon: child.icon,
              sortOrder: childSort,
              isDefault: true,
              createdAt: at,
            })
            .onConflictDoNothing()
            .run();
          result.categories += rc.changes;
        }
      }
    }

    // ---------- 4. 标签（8 个） ----------
    for (const [idx, t] of DEFAULT_TAGS.entries()) {
      const r = tx
        .insert(tags)
        .values({
          id: seedId(ledgerId, t.key),
          ledgerId,
          name: t.name,
          color: t.color,
          sortOrder: idx + 1,
          useCount: 0,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      result.tags += r.changes;
    }

    // ---------- 5. 模板（8 个） ----------
    for (const [idx, t] of DEFAULT_TEMPLATES.entries()) {
      const payload = {
        recordType: t.recordType,
        accountId: null,
        accountGroupKey: t.groupKey,
        toAccountId: null,
        categoryId: seedId(ledgerId, t.categoryKey),
        merchant: null,
        counterparty: null,
        name: t.title,
        fee: 0,
        discount: 0,
        tagIds: [] as string[],
        note: null,
        defaultAmount: t.defaultAmount,
      };
      const r = tx
        .insert(templates)
        .values({
          id: seedId(ledgerId, t.key),
          ledgerId,
          name: t.name,
          icon: t.icon,
          sortOrder: idx + 1,
          payloadJson: JSON.stringify(payload),
          useCount: 0,
          isDefault: true,
          createdBy: ownerUserId,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      result.templates += r.changes;
    }
  });

  return result;
}
