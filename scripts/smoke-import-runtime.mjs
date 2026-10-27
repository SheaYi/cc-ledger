/**
 * 导入运行时冒烟：用真实 DB（:memory: + 迁移）跑一遍 `commit()`，
 * 验证新增的可选列（手续费/折扣/标签/分类/对象/时间/名称）真的写进账单。
 *
 * 不依赖 HTTP（避开注册/导入限流），直接调用 service 层。
 */
import { openDatabase } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';
import { createLedger } from '../dist/modules/ledgers/service.js';
import { createAccount } from '../dist/modules/accounts/service.js';
import { createCategory } from '../dist/modules/categories/service.js';
import { commit } from '../dist/modules/imports/service.js';
import { createTag } from '../dist/modules/tags/service.js';
import { users, accountGroups, transactions, transactionTags, tags } from '../dist/db/schema.js';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'node:fs';

const TMP_DB = 'C:/Users/xieyi/WorkBuddy/11/cc-ledger/data/smoke-import-test.db';
try { unlinkSync(TMP_DB); } catch {}
const now = () => new Date().toISOString();
let failed = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
}

const handle = openDatabase(TMP_DB);
runMigrations(handle);
const ctx = { env: {}, dbHandle: handle, db: handle.db, startedAt: Date.now() };

const UID = 'u_smoke';
handle.db
  .insert(users)
  .values({ id: UID, username: 'smoke', passwordHash: 'x', nickname: 'Smoke', status: 'active', createdAt: now(), updatedAt: now() })
  .run();

const ledger = createLedger(ctx, UID, { name: '冒烟账本', type: 'personal', currency: 'CNY' });
const grp = handle.db.select().from(accountGroups).where(eq(accountGroups.ledgerId, ledger.id)).all()[0];
check('建账本后存在默认账户分组', !!grp, grp?.id);

const acc = createAccount(ctx, UID, ledger.id, { groupId: grp.id, name: '现金', type: 'cash' });
check('账户创建成功', !!acc?.id, acc?.id);
/**
 * 第二个账户：验证「账户」列是**按行**归集而不是整批落到兜底账户。
 *
 * ⚠️ 这是本次修复的回归点：此前「账户」列被标成「不读取」，
 *    导出的 18 列文件导回来时所有流水被压进 `defaultAccountId` 一个账户，
 *    账户余额集体失真而报告零失败行（静默的归集错误）。
 */
const acc2 = createAccount(ctx, UID, ledger.id, { groupId: grp.id, name: '招行卡', type: 'debit_card' });
check('第二个账户创建成功', !!acc2?.id, acc2?.id);

const catParent = createCategory(ctx, UID, ledger.id, { recordType: 'expense', name: '餐饮冒烟' });
const catChild = createCategory(ctx, UID, ledger.id, { recordType: 'expense', parentId: catParent.id, name: '外卖冒烟' });
const incCat = createCategory(ctx, UID, ledger.id, { recordType: 'income', name: '工资冒烟' });
const incChild = createCategory(ctx, UID, ledger.id, { recordType: 'income', parentId: incCat.id, name: '月薪冒烟' });
check('父子分类创建成功', !!catChild?.id && !!incChild?.id);

/**
 * 名称 / 商家 / 对象 / 标签 / 备注五列是**按列直写**：
 * 不做匹配、不转换、不校验、不兜底填充。
 * 标签列更是「原样落库」—— 账本里没有的同名标签会新建，而不是被悄悄丢掉。
 */
const tagLunch = createTag(ctx, UID, ledger.id, { name: '午餐' });
const tagReimb = createTag(ctx, UID, ledger.id, { name: '报销' });
const tagSalary = createTag(ctx, UID, ledger.id, { name: '工资' });
const tagMonthly = createTag(ctx, UID, ledger.id, { name: '月薪' });
check('标签创建成功', !!tagLunch?.id && !!tagSalary?.id);

// 18 列全量头，覆盖所有新增可选列（主类别/子类别拆分）
const header = ['日期', '时间', '类型', '方向', '主类别', '子类别', '账户', '转入账户', '名称', '商家', '对象', '金额', '手续费', '折扣', '实际值', '标签', '备注', '记账人'];
const rows = [
  // 支出行：带手续费/折扣/标签/分类(父子)/对象/名称/时间；账户列写「招行卡」→ 应落 acc2
  ['2026-10-18', '12:30:00', '支出', '', '餐饮冒烟', '外卖冒烟', '招行卡', '', '午餐', '美团', '美团', '100.00', '3.00', '1.50', '', '午餐、报销', '测试备注', ''],
  // 收入行：用 incomeCategoryId 兜底，手续费应被带入（income 支持 fee）；账户列写「现金」→ 应落 acc
  ['2026-10-19', '09:00:00', '收入', '', '', '', '现金', '', '工资', '公司', '公司', '8000.00', '0', '0', '', '工资、月薪', '月薪', ''],
  // 转账行：应被 commit 识别为「暂不支持批量导入」失败行（不建账）
  ['2026-10-20', '10:00:00', '转账', '', '', '', '', '', '转给老婆', '', '', '500.00', '0', '0', '', '', '', ''],
  // 账户列写了账本里没有的名字 → 该行必须**失败并点名**，绝不静默退回兜底账户
  ['2026-10-21', '11:00:00', '支出', '', '餐饮冒烟', '外卖冒烟', '不存在的卡', '', '午餐', '美团', '美团', '66.00', '0', '0', '', '', '账户不存在测试', ''],
  // 直写行：名称列**故意留空** → 名称就必须是空（不能被兜底成商家 / 「导入的账单」）；
  // 标签列写了两个账本里都没有的标签 → 必须按原样新建并挂上，不能丢弃也不能报错
  ['2026-10-22', '08:15:00', '支出', '', '餐饮冒烟', '外卖冒烟', '现金', '', '', '楼下便利店', '老王', '25.00', '0', '0', '', '夜宵、临时标签', '', ''],
];
const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

const mapping = {
  dateColumn: '日期',
  amountColumn: '金额',
  recordTypeColumn: '类型',
  accountColumn: '账户',
  timeColumn: '时间',
  nameColumn: '名称',
  mainCategoryColumn: '主类别',
  subCategoryColumn: '子类别',
  merchantColumn: '商家',
  counterpartyColumn: '对象',
  feeColumn: '手续费',
  discountColumn: '折扣',
  tagsColumn: '标签',
  noteColumn: '备注',
  recordType: 'expense',
  defaultAccountId: acc.id,
  defaultCategoryId: catChild.id,
  incomeCategoryId: incChild.id,
};

const report = commit(ctx, UID, ledger.id, Buffer.from(csv), mapping, false);
console.log('report:', JSON.stringify({ total: report.total, succeeded: report.succeeded, failed: report.failed, skipped: report.skipped }));
for (const e of report.errors) console.log(`  row ${e.row} [${e.column}] ${e.message}`);
check('成功 3 行（支出+收入+直写行）', report.succeeded === 3, `succeeded=${report.succeeded}`);
check('失败 2 行（转账不支持 + 账户不存在）', report.failed === 2, `failed=${report.failed}`);
check('转账失败行给出人话原因', report.errors.some((e) => /暂不支持批量导入/.test(e.message)), JSON.stringify(report.errors[0]?.message ?? ''));
/**
 * 「账户」列写了账本里没有的名字 → 必须失败并**点名**，
 * 不能静默落到兜底账户（那是把钱记到别的账户上，且报告里看不出来）。
 */
check(
  '账户名不存在 → 该行失败并点名（不静默退回兜底账户）',
  report.errors.some((e) => /账户「不存在的卡」在本账本里不存在/.test(e.message)),
  JSON.stringify(report.errors.map((e) => e.message)),
);

// 读回账单做字段级断言（金额列存「分」整数）
const txs = handle.db.select().from(transactions).where(eq(transactions.ledgerId, ledger.id)).all();
check('落库 3 笔账单', txs.length === 3, `len=${txs.length}`);

const exp = txs.find((t) => t.note === '测试备注');
check('支出行手续费=3.00(分300)', exp?.fee === 300, `fee=${exp?.fee}`);
check('支出行折扣=1.50(分150)', exp?.discount === 150, `discount=${exp?.discount}`);
check('支出行分类解析为子分类', exp?.categoryId === catChild.id, `cat=${exp?.categoryId} expect=${catChild.id}`);
check('支出行对象=美团', exp?.counterparty === '美团', `cp=${exp?.counterparty}`);
check('支出行名称=午餐', exp?.name === '午餐', `name=${exp?.name}`);
check('支出行时间=12:30:00', exp?.txTime === '12:30:00', `txTime=${exp?.txTime}`);
check('支出行备注=测试备注', exp?.note === '测试备注', `note=${exp?.note}`);
check('支出行商家=美团', exp?.merchant === '美团', `merchant=${exp?.merchant}`);
/**
 * 按行归集的核心断言：支出行写的是「招行卡」→ 落到 acc2，
 * 而不是整批落到 defaultAccountId（现金）。
 */
check('支出行按「账户」列落到招行卡（不是兜底账户）', exp?.accountId === acc2.id, `accountId=${exp?.accountId} expect=${acc2.id}`);

// 标签断言：账单应挂 2 个标签（午餐、报销）
const tagRows = handle.db
  .select({ name: tags.name })
  .from(transactionTags)
  .innerJoin(tags, eq(transactionTags.tagId, tags.id))
  .where(eq(transactionTags.transactionId, exp.id))
  .all();
const tagNames = tagRows.map((r) => r.name).sort();
check('支出行标签=午餐+报销', JSON.stringify(tagNames) === JSON.stringify(['午餐', '报销']), JSON.stringify(tagNames));

const inc = txs.find((t) => t.note === '月薪');
check('收入行分类=月薪子类别(incomeCategoryId 兜底)', inc?.categoryId === incChild.id, `cat=${inc?.categoryId}`);
check('收入行手续费按 0 处理（列里就是 0）', inc?.fee === 0, `fee=${inc?.fee}`);
check('收入行按「账户」列落到现金', inc?.accountId === acc.id, `accountId=${inc?.accountId} expect=${acc.id}`);

/* ---- 五个文本列「按列直写」的断言 ---- */
const plain = txs.find((t) => t.merchant === '楼下便利店');
check('直写行落库（空名称不拦导入）', !!plain?.id, plain?.id ?? 'none');
/**
 * 名称列为空 → 名称必须是 null。
 * 旧行为是「取商家兜底，再兜底成『导入的账单』」，凭空造出文件里没有的值。
 */
check(
  '名称列为空 → 名称就是空（不取商家兜底、不填「导入的账单」）',
  plain?.name === null,
  `name=${JSON.stringify(plain?.name)}`,
);
check('商家列原样写入', plain?.merchant === '楼下便利店', `merchant=${plain?.merchant}`);
check('对象列原样写入', plain?.counterparty === '老王', `cp=${plain?.counterparty}`);
check('备注列为空 → 备注就是空', plain?.note === null, `note=${JSON.stringify(plain?.note)}`);

const plainTagRows = handle.db
  .select({ name: tags.name })
  .from(transactionTags)
  .innerJoin(tags, eq(transactionTags.tagId, tags.id))
  .where(eq(transactionTags.transactionId, plain?.id ?? ''))
  .all();
const plainTagNames = plainTagRows.map((r) => r.name).sort();
check(
  '标签列原样写入（账本里没有的同名标签自动新建，不丢弃不报错）',
  JSON.stringify(plainTagNames) === JSON.stringify(['夜宵', '临时标签'].sort()),
  JSON.stringify(plainTagNames),
);
/** 已有同名标签必须被复用，不能因为导入又建一个重名的 */
const lunchCount = handle.db
  .select({ id: tags.id })
  .from(tags)
  .where(eq(tags.name, '午餐'))
  .all();
check('已有同名标签被复用（没有建出第二个「午餐」）', lunchCount.length === 1, `count=${lunchCount.length}`);

/* ---- 去重口径：日期 + 时间 + 金额（商家不参与） ---- */
const dedupCsv = [
  ['日期', '时间', '商家', '金额'].join(','),
  ['2026-09-01', '10:00', '星巴克', '30.00'].join(','),
  ['2026-09-01', '10:00', '星巴克（国贸店）', '30.00'].join(','), // 商家不同 → 仍判重复
  ['2026-09-01', '19:00', '星巴克', '30.00'].join(','), // 时间不同 → 不重复
  ['2026-09-02', '10:00', '星巴克', '30.00'].join(','), // 日期不同 → 不重复
].join('\r\n');
const dedupMapping = { ...mapping, recordTypeColumn: undefined, defaultAccountId: acc.id };
const dedupRep = commit(ctx, UID, ledger.id, Buffer.from(dedupCsv), dedupMapping, false);
check(
  '商家不同但同日同时同额 → 判为重复（商家不参与去重键）',
  dedupRep.succeeded === 3 && dedupRep.skipped === 1,
  JSON.stringify({ s: dedupRep.succeeded, k: dedupRep.skipped }),
);
check(
  '时间不同 / 日期不同 → 都不是重复',
  dedupRep.errors.some((e) => /重复/.test(e.message)) &&
    dedupRep.errors.filter((e) => /重复/.test(e.message)).length === 1,
  JSON.stringify(dedupRep.errors.map((e) => e.message)),
);

handle.close();
try { unlinkSync(TMP_DB); } catch {}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
