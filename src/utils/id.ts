import { randomBytes } from 'node:crypto';

/** Crockford Base32（排除易混字符 I L O U） */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成 26 位 ULID（时间有序，适合做主键/索引） */
export function ulid(): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32]! + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart += ENCODING[bytes[i]! % 32]!;
  }
  return timePart + randPart;
}

/** 生成带业务前缀的 ID，如 newId('usr') → usr_01J8X... */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const ID_PREFIX = {
  user: 'usr',
  refreshToken: 'rt',
  ledger: 'ldg',
  ledgerMember: 'lm',
  invitation: 'inv',
  ledgerLog: 'log',
  accountGroup: 'grp',
  account: 'acc',
  category: 'cat',
  tag: 'tag',
  transaction: 'tx',
  transactionSettlement: 'stl',
  attachment: 'att',
  template: 'tpl',
  recurringRule: 'rcr',
  installmentPlan: 'ipl',
  installmentSchedule: 'sch',
  reconciliation: 'rec',
  budget: 'bud',
  budgetTransfer: 'btr',
  categoryRule: 'rul',
  periodClosure: 'pc',
  /* --- `docs/15` 对标 FRD 的 51 条需求所需（迁移 0009~0011） --- */
  bankStatement: 'bst',
  bankStatementLine: 'bsl',
  reconAdjustingItem: 'rad',
  recurringDetection: 'rdt',
  budgetAlert: 'bal',
  budgetRollover: 'bro',
  budgetPool: 'bpo',
  budgetPoolEntry: 'bpe',
  budgetTemplate: 'btp',
  budgetChange: 'bch',
  netWorthSnapshot: 'nws',
  statsPolicyVersion: 'spv',
  statEvent: 'sev',
  savedReport: 'rpt',
  reimbursement: 'rim',
  backdatedAdjustment: 'bad',
  periodReopenLog: 'prl',
} as const;
