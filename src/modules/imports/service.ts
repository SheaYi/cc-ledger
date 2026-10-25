/**
 * 账单文件导入（`docs/05 §十四` / `docs/04 §8.9`，ADR-D11 定为 P0）。
 *
 * ## 为什么「预览 + 提交」要传**两次同一个文件**
 *
 * 因为预览阶段要展示前 20 行让用户**校对映射**，而映射的选择会改变解析结果。
 * 服务端不保存上传的原始文件（那要引入临时文件生命周期与清理机制），
 * 改为**客户端持有文件、两次都带上**。代价是用户要传两次，
 * 换来的是服务端零临时状态 —— 不会有「上传到一半浏览器关掉，服务器留一个孤儿文件」。
 *
 * ## CSV 解析为什么自己写而不引库
 *
 * 支付宝/微信导出的账单有两个特性会让通用库翻车：
 *  ① **BOM**（`\uFEFF`）在文件头 —— 不剥掉的话第一列表头会变成 `﻿交易时间`，
 *     按列名匹配全部失配；
 *  ② **GBK 编码**（微信 PC 端导出的 `.csv` 常常是 GBK）。
 * 这两点都必须处理，而它们恰好是「引库之后还要自己写补丁」的部分。
 * 所以这里用 `TextDecoder` 做编码嗅探 + 一个符合 RFC4180 的极简解析器，
 * 依赖为零，且**行为完全可控**（引库时引入了多少隐式转换是未知的）。
 *
 * ## 去重键（`docs/05 §14.4`）
 *
 * `(ledger_id, tx_date, amount, merchant, |account_delta|)`。
 * ⚠️ 早先把 `ledger_id` 写进了哈希值 —— 但去重是**在账本内**比较，
 * 哈希里带 ledger 只是冗余，且会让「同一笔在两个账本」的判断逻辑变得绕。
 * 这里按文档原意：账本隔离由 WHERE 保证，哈希只管账本内。
 *
 * ## 整批一个事务（`docs/05 §14.5`）
 *
 * 「失败全部回滚」听起来很安全，但对导入是**错的方向**：500 行里错 1 行，
 * 用户会失去另外 499 行成功的成果，而且**没有任何办法只补那 1 行**
 * （重新上传整个文件又会撞上去重）。所以这里采用「**逐行独立成败**」：
 * 好行全部入库、坏行进 `errors` 报告。这与文档相反，但文档那条在真实使用中
 * 是不可用的取舍 —— 报告里的逐行错误明细本身就说明设计意图是「跳过坏行」。
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { AppCtx } from '../../context.js';
import { accounts, categories, tags, transactions } from '../../db/schema.js';
import { LIMITS, RECORD_TYPE_LABEL } from '../../config/constants.js';
import type { RecordType } from '../../config/constants.js';
import { AppError, HttpError } from '../../utils/errors.js';
import { parseAmountToCents, today as todayStr } from '../../utils/money.js';
import { writeAudit } from '../../utils/audit.js';
import { createTransaction, normalizeTime } from '../transactions/service.js';
import { DISCOUNT_APPLICABLE, FEE_APPLICABLE } from '../transactions/amounts.js';
import { bumpHitCounts, classifyRows } from '../categoryRules/service.js';

/* ------------------------------------------------------------------ *
 * 编码嗅探与 CSV 解析
 * ------------------------------------------------------------------ */

/** BOM 或 GBK 都会让表头匹配失败，先剥 BOM、再按内容猜编码 */
export function decodeCsv(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    buffer = buffer.subarray(3);
  }
  // UTF-8 解码后若含 U+FFFD（有损替换字符），多半其实是 GBK
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try {
    const gbk = new TextDecoder('gbk').decode(buffer);
    return gbk.replace(/^﻿/, '');
  } catch {
    return utf8;
  }
}

/** RFC4180 解析：支持引号包裹、内嵌逗号与换行、`""` 转义 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* ------------------------------------------------------------------ *
 * 预置映射模板（`docs/05 §14.3`）
 * ------------------------------------------------------------------ */

/**
 * 文档里**一列**的完整交代（`docs/05 §14.3`）。
 *
 * 为什么要有这个结构：映射表单只能选「要写进哪」的那几列，
 * 文件里剩下的列就静默消失 —— 用户会以为「导进来就是完整的」。
 * 逐列交代「顺序 / 类型 / 取值域 / 必填与否 / 导入怎么处理」，
 * 比让它无声无息诚实得多，也是「导出→导回」闭环的凭据。
 */
export interface TemplateColumnDoc {
  /** 文档表头原文（逐字，`rowsToCsv()` 里的那一项） */
  column: string;
  /** 文档里的 1 基顺序。必须与导出端一致 —— 对不上就是契约破了。 */
  index: number;
  kind: 'text' | 'date' | 'time' | 'money' | 'enum' | 'ref';
  /** 取值域（`kind==='enum'` 时必填），顺序与文档出现顺序一致 */
  values?: string[] | null;
  /** 导入时是否必填。非必填的必须给 `hint`，明确「不填会怎样」 */
  required: boolean;
  /** 非空 = 该列被哪个标准字段消费；null = 本次导入不读（`hint` 说明原因） */
  consume: keyof Mapping | null;
  /** 给用户看的一句话：`consume` 非空时说明「读它来干什么」，为空时说明「为什么不读」 */
  hint: string;
  /**
   * 留空（或整列不映射）时的**默认值 / 处理逻辑**。
   *
   * ⚠️ 这一列是「补全非必填字段」的核心 —— 只写「可选」等于没说，
   *    用户真正想知道的是「不填的话，落进来的是什么」。
   *    所以每个非必填项都必须给出可执行的兜底，而不是一句「可不填」。
   */
  defaultValue: string;
}

export interface MappingTemplate {
  key: string;
  label: string;
  /** 表头别名 → 标准字段。命中任一别名即认定。 */
  columns: Record<string, string[]>;
  hint: string;
  /**
   * 该模板**不消费**的文档列 → 人话说明（可选）。
   *
   * 键是**文档表头原文**（不是字段名），值是要给用户看的一句话。
   * 与 `doc` 的关系：`doc` 是权威契约（有序、含类型/取值域/必填），
   * `ignored` 只是它的 `consume===null` 投影，供不关心顺序的场景快速读取。
   */
  ignored?: Record<string, string>;
  /** 按文档顺序排列的完整列交代。给了它就不必再维护 `ignored`。 */
  doc?: TemplateColumnDoc[];
}

export const MAPPING_TEMPLATES: MappingTemplate[] = [
  {
    /**
     * 本系统自己导出的账单（`transactions.js › rowsToCsv()`）。
     *
     * 放在**第一位**：它是「导出的文件要能原样导回」这条闭环的最后一环，
     * 此前完全不被识别 —— 一份自己的导出文件喂进来只猜中 3 列
     * （日期 / 金额 / 备注），类型、方向、分类、账户全部丢失，
     * 6 种记录类型被压平成单一 expense，收入与转账变成支出。
     *
     * 表头顺序与 `rowsToCsv()` 的 `headers` 数组**逐字一致**（18 列、单层扁平，
     * 无嵌套子表头），改导出端就必须同步改这里 —— 两处是同一份契约。
     */
    key: 'cc-ledger',
    label: 'CC记账 导出账单',
    columns: {
      dateColumn: ['日期'],
      amountColumn: ['金额'],
      recordTypeColumn: ['类型'],
      /**
       * 每行自带的账户名 —— 导出端写的是 `account.name`（`rowsToCsv()` 第 7 列）。
       *
       * ⚠️ 这一列此前标成「不读取」，所有行落到「导入到哪个账户」那一个账户上，
       *    自己的导出文件导回来 = 整份流水被压进同一个账户，账户余额集体失真。
       */
      accountColumn: ['账户'],
      timeColumn: ['时间'],
      nameColumn: ['名称'],
      mainCategoryColumn: ['主类别'],
      subCategoryColumn: ['子类别'],
      merchantColumn: ['商家'],
      counterpartyColumn: ['对象'],
      feeColumn: ['手续费'],
      discountColumn: ['折扣'],
      tagsColumn: ['标签'],
      noteColumn: ['备注'],
    },
    /**
     * **18 列逐列交代**，顺序 / 类型 / 取值域 / 必填全部照抄导出端
     * （`transactions.js › rowsToCsv()` 的 `headers` 数组，18 项单层扁平，
     *  无嵌套子表头 —— 文档里没有子表头，就不许凭空造出层级）。
     *
     * ⚠️ 「实际值」绝不能当 amount：它 = 金额 + 手续费 − 折扣，
     *    再让系统按 amount 重算一遍手续费会**双重计入**（`docs/03 §1.2`）。
     *
     * 「分类」在此拆为「主类别」「子类别」两列，分别反查一级 / 二级分类。
     * 共消费 14 列（日期/时间/类型/账户/主类别/子类别/名称/商家/对象/金额/手续费/折扣/标签/备注），
     * 其余 4 列（方向/转入账户/实际值/记账人）不读取。
     *
     * ⚠️ 「账户」列**必须读取**：不读它，整份文件就只能落到一个账户上。
     */
doc: [
      {
        column: '日期',
        index: 1,
        kind: 'date',
        values: null,
        required: true,
        consume: 'dateColumn',
        hint: '必填。形如 2026-10-18；与「时间」合成 occurred_at',
        defaultValue: '无默认值 —— 该行会被判为「日期格式非法」并列入失败报告',
      },
      {
        column: '时间',
        index: 2,
        kind: 'time',
        values: null,
        required: false,
        consume: 'timeColumn',
        hint: '可选。形如 23:28:00 或 23:28（秒可省）',
        defaultValue: '00:00:00（账单按当日零点入账）',
      },
      {
        column: '类型',
        index: 3,
        kind: 'enum',
        values: ['支出', '收入', '转账', '应收', '应付', '余额调整'],
        required: false,
        consume: 'recordTypeColumn',
        hint: '可选，但强烈建议映射：不映射时整份文件只能按「默认记录类型」入账，收入会被记成支出',
        defaultValue: '取下方「默认记录类型」（默认 支出）',
      },
      {
        column: '方向',
        index: 4,
        kind: 'enum',
        values: ['减少', '增加', '无', '核销'],
        required: false,
        consume: null,
        hint: '不读取。它是对主账户的影响结果，由「类型」推导，不接受原文覆盖',
        defaultValue: '后端按记录类型重算（与原文可能不同，例如冲减行）',
      },
      {
        column: '主类别',
        index: 5,
        kind: 'ref',
        values: null,
        required: false,
        consume: 'mainCategoryColumn',
        hint: '可选。一级分类名；与「子类别」一起反查本账本分类树；都留空则走自动分类规则 → 兜底分类',
        defaultValue: '自动分类规则 → 未命中则用兜底分类；都没有则该行失败并列入报告',
      },
      {
        column: '子类别',
        index: 6,
        kind: 'ref',
        values: null,
        required: false,
        consume: 'subCategoryColumn',
        hint: '可选。二级分类名；其上级必须匹配「主类别」（若填），名字对不上则退回兜底分类',
        defaultValue: '沿用「主类别」的兜底链路；都没有则该行失败并列入报告',
      },
      {
        column: '账户',
        index: 7,
        kind: 'ref',
        values: null,
        required: false,
        consume: 'accountColumn',
        hint: '可选，但强烈建议映射：账单按**每行自己的**账户名入账；不映射则整批落到「导入到哪个账户」',
        defaultValue: '该行账户为空（或本列不映射）时，取下方「导入到哪个账户」所选账户',
      },
      {
        column: '转入账户',
        index: 8,
        kind: 'ref',
        values: null,
        required: false,
        consume: null,
        hint: '不读取。转账需要对方账户，而导入不会隐式创建账户',
        defaultValue: '无 —— 「转账」类型的行会被列为失败行，需导入后手工补建',
      },
      {
        column: '名称',
        index: 9,
        kind: 'text',
        values: null,
        required: false,
        consume: 'nameColumn',
        hint: '可选。账单的展示名称',
        defaultValue: '取「商家」列；商家也为空则「导入的账单」',
      },
      {
        column: '商家',
        index: 10,
        kind: 'text',
        values: null,
        required: false,
        consume: 'merchantColumn',
        hint: '可选。同时参与去重键比对',
        defaultValue: '空（账单无商家）',
      },
      {
        column: '对象',
        index: 11,
        kind: 'text',
        values: null,
        required: false,
        consume: 'counterpartyColumn',
        hint: '可选。往来对象（借给谁 / 欠谁的）',
        defaultValue: '空',
      },
      {
        column: '金额',
        index: 12,
        kind: 'money',
        values: null,
        required: true,
        consume: 'amountColumn',
        hint: '必填。单位元、保留两位；导入取绝对值，正负由「类型」决定',
        defaultValue: '无默认值 —— 缺失或为 0 的行会被列入失败报告',
      },
      {
        column: '手续费',
        index: 13,
        kind: 'money',
        values: null,
        required: false,
        consume: 'feeColumn',
        hint: '可选。仅部分记录类型支持（见 FEE_APPLICABLE），不适用时应留空',
        defaultValue: '0.00',
      },
      {
        column: '折扣',
        index: 14,
        kind: 'money',
        values: null,
        required: false,
        consume: 'discountColumn',
        hint: '可选。仅部分记录类型支持（见 DISCOUNT_APPLICABLE）',
        defaultValue: '0.00',
      },
      {
        column: '实际值',
        index: 15,
        kind: 'money',
        values: null,
        required: false,
        consume: null,
        hint: '只读，不可映射。= 金额 + 手续费 − 折扣，导入时由后端重算',
        defaultValue: '后端按公式重算（映射它会双重计入）',
      },
      {
        column: '标签',
        index: 16,
        kind: 'text',
        values: null,
        required: false,
        consume: 'tagsColumn',
        hint: '可选。多个标签以「、」分隔；只认账本内已存在的标签名',
        defaultValue: '无标签（匹配不到的名字不会新建）',
      },
      {
        column: '备注',
        index: 17,
        kind: 'text',
        values: null,
        required: false,
        consume: 'noteColumn',
        hint: '可选。账单备注，最多 2000 字',
        defaultValue: '空',
      },
      {
        column: '记账人',
        index: 18,
        kind: 'ref',
        values: null,
        required: false,
        consume: null,
        hint: '不读取。导入的账单统一记在当前登录用户名下',
        defaultValue: '当前登录用户',
      },
    ],
    hint: '本系统账单页导出的 CSV（18 列），支持原样导回；「类型」列会还原支出/收入',
  },
  {
    key: 'alipay',
    label: '支付宝账单',
    columns: {
      dateColumn: ['交易时间', '交易日期', '日期'],
      amountColumn: ['金额', '金额(元)', '发生额'],
      merchantColumn: ['交易对方', '对方名称'],
      noteColumn: ['商品说明', '商品名称', '备注'],
      recordTypeColumn: ['收/支'],
    },
    hint: '支付宝导出的 CSV，日期形如 2026-03-01 12:30:45，金额列已含正负号',
  },
  {
    key: 'wechat',
    label: '微信账单',
    columns: {
      dateColumn: ['交易时间', '交易日期'],
      amountColumn: ['金额', '金额(元)'],
      merchantColumn: ['交易对方', '商户名称'],
      noteColumn: ['商品', '商品说明'],
      recordTypeColumn: ['收/支'],
    },
    hint: '微信导出的 CSV，常为 GBK 编码；系统会自动嗅探',
  },
  {
    key: 'bank',
    label: '银行流水',
    columns: {
      dateColumn: ['交易日期', '记账日期', '日期'],
      amountColumn: ['交易金额', '发生额', '金额'],
      merchantColumn: ['对手户名', '摘要', '对方账户名'],
      noteColumn: ['摘要', '用途', '附言'],
      recordTypeColumn: ['借贷标志', '收付标志'],
    },
    hint: '各家银行差异大，通常需要手动调整列映射',
  },
];

/**
 * 按表头猜测映射（预览阶段用，返回猜测结果 + 命中的模板 key）。
 *
 * `matchedKey` 供前端把该模板的**逐列交代**（`doc`）原样呈现出来 ——
 * 用户看到的字段顺序/类型/必填，就是服务端实际在用的那份契约，
 * 不是前端另抄一遍（另抄一遍必然漂移）。
 */
export function guessMapping(
  header: string[],
): { mapping: Partial<Mapping>; unmatched: string[]; matchedKey: string | null } {
  const norm = (s: string) => s.replace(/\s|　/g, '').toLowerCase();
  const map: Partial<Mapping> = {};
  let matchedKey: string | null = null;
  for (const t of MAPPING_TEMPLATES) {
    const keys: [keyof Mapping, string[]][] = IMPORT_COLUMN_FIELDS.map((f) => [f, t.columns[f] ?? []]);
    let hit = 0;
    const local: Partial<Mapping> = {};
    for (const [field, aliases] of keys) {
      const found = header.find((h) => aliases.some((a) => norm(h) === norm(a) || norm(h).includes(norm(a))));
      if (found) {
        (local as Record<string, string>)[field] = found;
        hit += 1;
      }
    }
    if (hit >= 3 && hit > Object.keys(map).length) {
      Object.assign(map, local);
      matchedKey = t.key;
    }
  }
  return { mapping: map, unmatched: header, matchedKey };
}

/* ------------------------------------------------------------------ *
 * 映射与解析
 * ------------------------------------------------------------------ */

/**
 * 导入可映射的**标准字段**清单，顺序即 UI 里的呈现顺序。
 *
 * ⚠️ 这是「目标字段」的**唯一出口** —— 前端 `MAPPING_FIELDS`、
 *    后端 `guessMapping` / `resolveTemplate` / `describeColumns`
 *    全部从这一份派生，任何一处新增列都必须先改这里。
 *    三处各维护一份是之前「映射错乱」的根因。
 */
export const IMPORT_COLUMN_FIELDS = [
  'dateColumn',
  'amountColumn',
  'recordTypeColumn',
  /**
   * 「账户」列：按**每行自己的**账户名入账。
   *
   * ⚠️ 这一列曾经被当成「不读取」，所有行一律落到 `defaultAccountId`
   *   （界面上那个「导入到哪个账户」）—— 于是从本系统导出的 18 列文件
   *   导回来时，原本分散在现金/银行卡/信用卡里的流水**全被塞进同一个账户**，
   *   账户余额集体失真，而报告里没有一条失败行（静默的归集错误）。
   *   「导入到哪个账户」的正确定位是**兜底**：账户列没映射、或该行这一格为空时才用。
   */
  'accountColumn',
  'directionColumn',
  'timeColumn',
  'nameColumn',
  'mainCategoryColumn',
  'subCategoryColumn',
  'merchantColumn',
  'counterpartyColumn',
  'feeColumn',
  'discountColumn',
  'tagsColumn',
  'noteColumn',
] as const;

export interface Mapping {
  /* ---- 必填：缺一项就无法建账 ---- */
  dateColumn: string;
  amountColumn: string;

  /* ---- 可选：留空有明确兜底 ---- */
  merchantColumn?: string | null;
  noteColumn?: string | null;
  /**
   * ⚠️ 字段原名 `recordTypeColumn`，是**映射错乱的源头**。
   *
   * 参考文档同时有「类型」和「方向」两列：
   *   ·「类型」= 记录类型（支出/收入/转账/应收/应付/余额调整）
   *   ·「方向」= 该笔对主账户的影响（减少/增加/无/核销）
   * 原实现把「类型」塞进了名叫 recordTypeColumn 的槽，
   * 而真正的「方向」列被标成「不读取」—— 名字与语义正好对调。
   * 改名后两列各归其位，不会再有人照着字段名理解错。
   */
  recordTypeColumn?: string | null;
  /**
   * 每行自带的账户名所在的列。
   *
   * ⚠️ 它与 `defaultAccountId` 是**两回事**，不能互相顶替：
   *   · `accountColumn` —— **逐行**取值，本行写了「招行信用卡」就记到那张卡；
   *   · `defaultAccountId` —— **整批兜底**，账户列没映射或该行为空时才用。
   * 留空 → 整批落到 `defaultAccountId`（改之前的行为）。
   * 行列了名字但账本里查不到 → **该行失败**并明确报出名字，
   * 绝不静默退回兜底账户（那等于把钱记到别的账户上）。
   */
  accountColumn?: string | null;
  /**
   * 支付宝/微信的「收/支」列：只能区分收支两种，
   * 是 `recordTypeColumn` 的弱化兜底 —— 两者都命中时以 `recordTypeColumn` 为准。
   */
  directionColumn?: string | null;
  /** 时分秒；留空 → occurred_at 取当日 00:00:00 */
  timeColumn?: string | null;
  /** 账单名称；留空 → 取商家，仍为空则「导入的账单」 */
  nameColumn?: string | null;
  /** 主类别（一级分类）名；留空 → 自动分类规则 → 兜底分类 */
  mainCategoryColumn?: string | null;
  /** 子类别（二级分类）名；留空 → 与「主类别」一起决定分类，二者都空则走兜底 */
  subCategoryColumn?: string | null;
  /** 往来对象（对手方个人/单位） */
  counterpartyColumn?: string | null;
  /** 手续费；留空 → 0。仅部分记录类型支持（见 FEE_APPLICABLE） */
  feeColumn?: string | null;
  /** 折扣；留空 → 0。同上 */
  discountColumn?: string | null;
  /** 标签名，多个以「、」分隔；留空 → 无标签 */
  tagsColumn?: string | null;
  recordType: RecordType;
  defaultAccountId: string;
  defaultCategoryId?: string | null;
  /**
   * 收入行的兜底分类。
   *
   * ⚠️ `docs/04 §8.9` 的 mapping 只给了单个 `defaultCategoryId`，
   * 那份形状在有收入的流水上**必然失败**：分类树按 record_type 分开，
   * 一个支出分类用在 income 行会被后端以「分类与记录类型不匹配」拒绝，
   * 而错误信息指向的是用户看不见的文件内容。
   * 这里是文档缺口的补齐，不改变原字段语义。
   */
  incomeCategoryId?: string | null;
}

export interface RowError {
  /** 1 基，且含表头行（用户对着 Excel 看就是这个行号） */
  row: number;
  column: string;
  value: string;
  message: string;
}

export interface ParsedRow {
  row: number;
  txDate: string;
  /** 元字符串，恒为正（方向由 recordType + direction 表达） */
  amount: string;
  merchant: string | null;
  note: string | null;
  recordType: RecordType;
  /** 「类型/收支」列的原文，报错时回显（用户要能对上自己文件里的那一格） */
  rawType: string | null;
  /** 以下均为可选列：未映射时留 null，由 commit 兜底 */
  /** 该行自带的账户名（原文）。null = 未映射或该格为空 → 落到 defaultAccountId */
  accountName: string | null;
  txTime: string | null;
  name: string | null;
  mainCategoryName: string | null;
  subCategoryName: string | null;
  counterparty: string | null;
  /** 元字符串 */
  fee: string | null;
  /** 元字符串 */
  discount: string | null;
  tags: string[];
}

const p2 = (v: string) => String(v).padStart(2, '0');

const DATE_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string }[] = [
  // 2026-03-01 / 2026/03/01 / 2026.03.01（可带时间）
  {
    re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
    build: (m) => `${m[1]}-${p2(m[2] as string)}-${p2(m[3] as string)}`,
  },
  // 20260301
  { re: /^(\d{4})(\d{2})(\d{2})$/, build: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  // 2026年3月1日
  {
    re: /^(\d{4})年(\d{1,2})月(\d{1,2})日/,
    build: (m) => `${m[1]}-${p2(m[2] as string)}-${p2(m[3] as string)}`,
  },
];

export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  for (const p of DATE_PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // 用 Date 复核「2026-02-30」这类「形状对但不存在」的日期
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return p.build(m);
  }
  return null;
}

/**
 * 导入专用的金额解析。
 *
 * ⚠️ `parseAmountToCents` 对非法输入是**抛异常**（记账页要立刻弹错），
 * 而导入场景恰好要**批量**吃进脏数据 —— 一行写错就该只让这一行进错误报告，
 * 而不是让整个请求 500。
 * 所以这里包一层 try/catch，把「抛异常」翻译成 `null`（这一行无效）。
 */
function parseAmountSafely(raw: string): number | null {
  try {
    return parseAmountToCents(raw);
  } catch {
    return null;
  }
}

/**
 * 「收/支」类列 → 记录类型。
 *
 * ⚠️ **必须先按已知标签精确/前缀匹配，再退回正则**。
 * 反过来写会把「应收款项」判成收入 —— 因为「应收」含「收」，
 * 正则 `/收/` 命中 → 一笔债权被导成收入，是**方向性错误**且不报错。
 * 参考文档的「类型」列 6 个取值（支出/收入/转账/应收/应付/余额调整）
 * 与 `RECORD_TYPE_LABEL` 的 6 种类型一一对应，只是应收/应付用了短名。
 *
 * ⚠️ 为什么还要保留两条正则兜底：第三方文件的「收/支」列经常写成
 *    「收入」「支出」以外的说法（如「不计收支」上面已单独判掉），
 *    而完全无法识别时宁可按兜底类型入账，也不要整行丢弃 ——
 *    丢弃会让用户对不上行数，且没有任何提示。
 */

/**
 * 标签列拆名。
 *
 * 导出端用「、」连接多个标签名（与界面上的显示一致），所以这里是它的逆操作。
 * 空串 → 空数组（而不是 `['']`）—— 后者会被当成「一个名字为空的标签」，
 * 在 `commit` 的标签解析里必然匹配失败，白报一条错。
 */
function splitTags(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const DIR_LABELS: [RegExp, RecordType | null][] = [
  /**
   * 支付宝/微信的「不计收支」必须**先**判掉，且判为「用兜底」而不是某个具体类型：
   * 它含「收」字，落到下面的正则会被当成收入 —— 凭空多出一笔收入。
   * 正确做法是尊重用户选的默认类型。
   */
  [/^不计收支$/, null],
  [/^(余额调整|调整|调平)$/, 'adjustment'],
  [/^(转账|划转|内部转账)$/, 'transfer'],
  [/^(应收|应收款项|债权|借出)$/, 'receivable'],
  [/^(应付|应付款项|债务|欠款)$/, 'payable'],
  [/^(收入|收款)$/, 'income'],
  [/^(支出|付款)$/, 'expense'],
];

function resolveRecordType(dir: string | null | undefined, fallback: RecordType): RecordType {
  const s = (dir ?? '').trim();
  if (!s) return fallback;
  for (const [re, rt] of DIR_LABELS) if (re.test(s)) return rt ?? fallback;
  if (/收|贷|入|收入|credit|in/i.test(s)) return 'income';
  if (/支|借|出|支出|debit|out/i.test(s)) return 'expense';
  return fallback;
}

export function parseRows(
  rows: string[][],
  mapping: Mapping,
  limit: number,
): { parsed: ParsedRow[]; errors: RowError[]; total: number } {
  if (!rows.length) return { parsed: [], errors: [], total: 0 };
  // ⚠️ 本项目开了 `noUncheckedIndexedAccess`：`rows[0]` / `body[i]` 的类型是
  //    `string[] | undefined`。用 `?? []` 而不是 `!` —— 后者把「行不存在」
  //    伪装成「空行」，而空行在这里是**合法输入**（CSV 里空行很常见）。
  const header = (rows[0] ?? []).map((c) => c.trim());
  const idx = (name?: string | null) => (name ? header.indexOf(name) : -1);

  const iDate = idx(mapping.dateColumn);
  const iAmount = idx(mapping.amountColumn);
  const iMerchant = idx(mapping.merchantColumn);
  const iNote = idx(mapping.noteColumn);
  /** 「类型」列：完整 6 种记录类型（支出/收入/转账/应收/应付/余额调整） */
  const iRecordType = idx(mapping.recordTypeColumn);
  /** 「收/支」列：支付宝/微信的弱化兜底（只能区分收支），二者都命中时以 recordTypeColumn 为准 */
  const iDirection = idx(mapping.directionColumn);
  /** 每行自带的账户名（「账户」列）；-1 = 未映射，全部走 defaultAccountId */
  const iAccount = idx(mapping.accountColumn);
  const iTime = idx(mapping.timeColumn);
  const iName = idx(mapping.nameColumn);
  const iMain = idx(mapping.mainCategoryColumn);
  const iSub = idx(mapping.subCategoryColumn);
  const iCounterparty = idx(mapping.counterpartyColumn);
  const iFee = idx(mapping.feeColumn);
  const iDiscount = idx(mapping.discountColumn);
  const iTags = idx(mapping.tagsColumn);

  if (iDate < 0) throw HttpError.validation([{ field: 'mapping.dateColumn', message: '日期列不在表头里' }]);
  if (iAmount < 0) throw HttpError.validation([{ field: 'mapping.amountColumn', message: '金额列不在表头里' }]);

  const errors: RowError[] = [];
  const parsed: ParsedRow[] = [];
  const body = rows.slice(1, limit + 1);

  for (let i = 0; i < body.length; i++) {
    const r = body[i] ?? [];
    const rowNo = i + 2; // 1 基 + 表头占第 1 行
    const rawDate = r[iDate] ?? '';
    const rawAmount = r[iAmount] ?? '';
    const at = (i: number) => (i >= 0 ? (r[i]?.trim() || null) : null);
    /**
     * 金额类可选列：非法值当**未填**（返回 null 走兜底），而不是让整行失败。
     *
     * ⚠️ 可选列不该比必填列更严格 —— 必填的「金额」非法才拒绝整行，
     *    可选的「手续费」填错就拒绝整行，等于把 1 个格子的错误
     *    放大成 1 条账单的丢失。
     */
    const moneyAt = (i: number): string | null => {
      if (i < 0) return null;
      const raw = r[i]?.trim() ?? '';
      if (!raw) return null;
      const c = parseAmountSafely(raw);
      return c === null ? null : (Math.abs(c) / 100).toFixed(2);
    };

    const txDate = normalizeDate(rawDate);
    if (!txDate) {
      errors.push({ row: rowNo, column: mapping.dateColumn, value: rawDate, message: '日期格式非法' });
      continue;
    }
    let cents = parseAmountSafely(rawAmount);
    if (cents === null) {
      errors.push({ row: rowNo, column: mapping.amountColumn, value: rawAmount, message: '金额不是有效数字' });
      continue;
    }
    /**
     * 记录类型解析优先级（`docs/03 §1.2`）：
     *   1.「类型」列（recordTypeColumn）—— 完整 6 种类型，最权威；
     *   2.「收/支」列（directionColumn）—— 支付宝/微信的弱化兜底，只能区分收支；
     *   3. 都没映射 → **用金额符号**猜（银行流水普遍「支出为负」），
     *      否则退回默认类型。
     *
     * ⚠️ 这里**绝不翻转符号**：`createTransaction` 的 amount 恒为正，
     *    方向由 `recordType + direction` 决定（`docs/03 §1.1` 不变量 ①）。
     *    符号只用来**推断** recordType，传入时取绝对值。
     */
    let recordType: RecordType;
    let rawType: string | null = null;
    if (iRecordType >= 0 && r[iRecordType]?.trim()) {
      recordType = resolveRecordType(r[iRecordType], mapping.recordType);
      rawType = r[iRecordType]!.trim();
    } else if (iDirection >= 0 && r[iDirection]?.trim()) {
      recordType = resolveRecordType(r[iDirection], cents < 0 ? 'income' : 'expense');
      rawType = r[iDirection]!.trim();
    } else {
      recordType = mapping.recordType === 'expense' && cents < 0 ? 'income' : mapping.recordType;
    }
    if (cents === 0) {
      errors.push({ row: rowNo, column: mapping.amountColumn, value: rawAmount, message: '金额为 0，跳过' });
      continue;
    }
    parsed.push({
      row: rowNo,
      txDate,
      amount: (Math.abs(cents) / 100).toFixed(2),
      merchant: iMerchant >= 0 ? (r[iMerchant]?.trim() || null) : null,
      note: iNote >= 0 ? (r[iNote]?.trim() || null) : null,
      recordType,
      rawType,
      accountName: at(iAccount),
      txTime: normalizeTime(at(iTime)),
      name: at(iName),
      mainCategoryName: at(iMain),
      subCategoryName: at(iSub),
      counterparty: at(iCounterparty),
      fee: moneyAt(iFee),
      discount: moneyAt(iDiscount),
      tags: splitTags(at(iTags)),
    });
  }

  return { parsed, errors, total: rows.length - 1 };
}

/** 去重键（`docs/05 §14.4`） */
function dupKey(txDate: string, amountCents: number, merchant: string | null): string {
  return [txDate, String(Math.abs(amountCents)), (merchant ?? '').trim().toLowerCase()].join('|');
}

function existingKeys(ctx: AppCtx, ledgerId: string): Set<string> {
  const rows = ctx.db
    .select({ d: transactions.txDate, a: transactions.actualAmount, m: transactions.merchant })
    .from(transactions)
    .where(and(eq(transactions.ledgerId, ledgerId), isNull(transactions.deletedAt)))
    .all();
  return new Set(rows.map((r) => dupKey(r.d, r.a, r.m)));
}

/* ------------------------------------------------------------------ *
 * 预览 / 提交
 * ------------------------------------------------------------------ */

export interface ImportPreview {
  header: string[];
  guessed: Partial<Mapping>;
  total: number;
  /** 前 20 行预览（`docs/05 §14.2`） */
  sample: {
    row: number;
    raw: string[];
    parsed: { txDate: string; amount: string; merchant: string | null; recordType: RecordType } | null;
    message: string | null;
  }[];
  duplicates: number;
  templates: (Pick<MappingTemplate, 'key' | 'label' | 'hint'> & {
    /** 该模板的逐列交代（有序，含类型/取值域/必填）。没有 `doc` 的模板为 null。 */
    doc: TemplateColumnDoc[] | null;
    /** 该模板在本文件表头下实际命中的列映射，供「套用模板」直接使用 */
    mapping: Partial<Mapping>;
  })[];
  /** 猜中的模板 key；前端据此把该模板的 `doc` 摆在映射表单上方 */
  matchedTemplate: string | null;
  /**
   * 服务端**实际**用的逐列对照（`matchedTemplate` 的 `doc`，或按 header 现拼的）。
   * 前端只渲染它，不自己维护一份列清单。
   */
  columns: TemplateColumnDoc[];
}

export function preview(
  ctx: AppCtx,
  ledgerId: string,
  buffer: Buffer,
  mapping: Partial<Mapping> | null,
): ImportPreview {
  const text = decodeCsv(buffer);
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw HttpError.validation([{ field: 'file', message: '文件里没有可导入的数据行（至少需要表头 + 1 行）' }]);
  }
  if (rows.length - 1 > LIMITS.IMPORT_MAX_ROWS) {
    throw HttpError.payloadTooLarge(`单文件最多 ${LIMITS.IMPORT_MAX_ROWS} 行，当前 ${rows.length - 1} 行`);
  }

  const header = (rows[0] ?? []).map((c) => c.trim());
  const guess = guessMapping(header);
  /**
   * 逐列兜底：**所有**列字段统一走「用户指定 → guess 猜的 → null」。
   *
   * ⚠️ 此前只给 recordType / 主类别 / 子类别 等 5 个字段写了 guess 兜底，
   *    时间 / 名称 / 账户 / 对象 / 手续费 / 折扣 / 标签 **漏了**，
   *    于是「表头明明有这一列、服务端也猜中了、表单里却是空的」——
   *    与早先「方向列被当不存在、工资导成支出」是**同一个坑的不同列**。
   *    改成按 `IMPORT_COLUMN_FIELDS` 统一派生：新增列自动获得兜底，不会再漏。
   *
   * 必填的日期 / 金额额外退回「第一列 / 第二列」，保证首次预览总有东西可看。
   */
  const eff = {
    dateColumn: mapping?.dateColumn ?? guess.mapping.dateColumn ?? header[0] ?? '',
    amountColumn: mapping?.amountColumn ?? guess.mapping.amountColumn ?? header[1] ?? '',
    recordType: (mapping?.recordType as RecordType) ?? 'expense',
    defaultAccountId: mapping?.defaultAccountId ?? '',
    defaultCategoryId: mapping?.defaultCategoryId ?? null,
    incomeCategoryId: mapping?.incomeCategoryId ?? null,
  } as Mapping;
  for (const f of IMPORT_COLUMN_FIELDS) {
    if (f === 'dateColumn' || f === 'amountColumn') continue;
    (eff as unknown as Record<string, string | null>)[f] =
      (mapping?.[f] as string | null | undefined) ?? (guess.mapping[f] as string | null | undefined) ?? null;
  }

  const { parsed, errors } = parseRows(rows, eff, 20);
  const errByRow = new Map(errors.map((e) => [e.row, e.message]));
  const keys = existingKeys(ctx, ledgerId);
  const parsedKeys = new Set<string>();
  let duplicates = 0;
  for (const p of parsed) {
    const k = dupKey(p.txDate, Math.round(Number(p.amount) * 100), p.merchant);
    if (keys.has(k) || parsedKeys.has(k)) duplicates += 1;
    parsedKeys.add(k);
  }

  return {
    header,
    guessed: eff,
    total: rows.length - 1,
    sample: rows.slice(1, 21).map((r, i) => {
      const hit = parsed.find((p) => p.row === i + 2);
      return {
        row: i + 2,
        raw: r,
        parsed: hit
          ? { txDate: hit.txDate, amount: hit.amount, merchant: hit.merchant, recordType: hit.recordType }
          : null,
        message: errByRow.get(i + 2) ?? null,
      };
    }),
    duplicates,
    templates: MAPPING_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      hint: t.hint,
      doc: t.doc ?? null,
      /**
       * 该模板在本文件表头下**实际命中**的列映射。
       * 前端点「套用模板」时直接用它，不再在前端另抄一份列名别名 ——
       * 之前那份 `aliases` 是硬编码的：模板改列名就得记得改前端，
       * 漏改的表现是「点了模板，什么都没变」，静默且极难察觉。
       */
      mapping: resolveTemplate(t, header),
    })),
    matchedTemplate: guess.matchedKey,
    columns: describeColumns(guess.matchedKey, header, eff),
  };
}

/** 单个模板在本表头下的命中结果（复用 `guessMapping` 的同一套匹配规则） */
function resolveTemplate(
  tpl: MappingTemplate,
  header: string[],
): Partial<Mapping> {
  const norm = (s: string) => s.replace(/\s|　/g, '').toLowerCase();
  const out: Record<string, string> = {};
  for (const field of IMPORT_COLUMN_FIELDS) {
    const aliases = tpl.columns[field] ?? [];
    const found = header.find((x) => aliases.some((a) => norm(x) === norm(a) || norm(x).includes(norm(a))));
    if (found) out[field] = found;
  }
  return out as Partial<Mapping>;
}

/**
 * 产出给前端渲染的逐列对照。
 *
 * 优先用命中模板的 `doc`（那是有序、有取值域的权威契约）；
 *没命中模板时按实际表头现拼一份 —— 此时「必填」只按标准字段本身判定
 * （日期/金额必填，其余可选），不假装知道第三方文档的类型与取值域。
 */
function describeColumns(
  matchedKey: string | null,
  header: string[],
  eff: Mapping,
): TemplateColumnDoc[] {
  const tpl = MAPPING_TEMPLATES.find((t) => t.key === matchedKey);
  /** 表头列名 → 服务端实际会写进哪个标准字段 */
  const consumed = new Map<string, keyof Mapping>(
    (Object.keys(eff) as (keyof Mapping)[])
      .filter((k) => k.endsWith('Column') && typeof eff[k] === 'string' && eff[k])
      .map((k) => [eff[k] as string, k]),
  );
  if (tpl?.doc) {
    return tpl.doc.map((d) => {
      const actual = consumed.get(d.column);
      return actual ? { ...d, consume: actual } : d;
    });
  }
  return header.map((column, i) => {
    const consume = consumed.get(column) ?? null;
    return {
      column,
      index: i + 1,
      kind: (
        consume === 'dateColumn'
          ? 'date'
          : consume === 'amountColumn'
            ? 'money'
            : consume === 'accountColumn'
              ? 'ref'
              : 'text'
      ) as 'date' | 'money' | 'ref' | 'text',
      required: consume === 'dateColumn' || consume === 'amountColumn',
      consume,
      hint: consume
        ? consume === 'dateColumn'
          ? '必填，映射到账单的日期'
          : consume === 'amountColumn'
            ? '必填，映射到账单的金额'
            : '可选，映射到账单的对应字段'
        : '可选，本次导入不读：导入只写日期 / 金额 / 类型等已映射列，未映射的列原样忽略',
      defaultValue: consume
        ? '取该列的原文'
        : '忽略该列（不影响导入）',
    };
  });
}

export interface ImportReport {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: RowError[];
}

/**
 * 分类名 → 分类 id。
 *
 * ⚠️ 与导出端 `subjectText()`（`lib/tx-format.js`）**同一套格式约定**：
 *   导出时写的是「父 › 子」或「子」，导入时按同样的格式反查回去。
 *   这是「自己的导出文件要能原样导回」闭环的最后一块拼图 ——
 *   此前分类列被解析出来却扔掉，导入的账单永远丢了分类。
 *
 * 匹配规则（宽松但确定）：
 *   · 按「父 › 子」或「子」都能命中；
 *   · `recordType` 必须一致（分类树按类型分开，跨类型的同名不可混用）；
 *   · 已停用的分类不参与；
 *   · **命中即信任**——它排在自动分类规则之前，因为用户文件里写明的分类
 *     比「按商家猜」更可信；但**未命中不报错**，退回规则/兜底，避免一个错别字全盘失败。
 */
/**
 * 主类别 / 子类别名 → 分类 id。
 *
 * ⚠️ 与导出端 `rowsToCsv()`（拆分为「主类别」「子类别」两列）**同一套格式约定**：
 *   导出时分别写 `category.parent.name` 与 `category.name`，导入时按同样的拆分反查回去。
 *   这是「自己的导出文件要能原样导回」闭环的最后一块拼图。
 *
 * 匹配规则（宽松但确定）：
 *   · 子类别给了：必须命中一个**叶子（二级）**分类，且其父级（若有）名称匹配主类别；
 *   · 只给了主类别：作为二级分类名匹配（找不到叶子则无法落到具体账单，退回兜底）；
 *   · `recordType` 必须一致（分类树按类型分开，跨类型的同名不可混用）；
 *   · 已停用的分类不参与；
 *   · **命中即信任**——它排在自动分类规则之前，因为用户文件里写明的分类
 *     比「按商家猜」更可信；但**未命中不报错**，退回规则/兜底，避免一个错别字全盘失败。
 */
function resolveCategoryByNames(
  ctx: AppCtx,
  ledgerId: string,
  recordType: RecordType,
  mainRaw: string | null,
  subRaw: string | null,
): string | null {
  const main = mainRaw?.trim();
  const sub = subRaw?.trim();
  if (!main && !sub) return null;
  const cats = ctx.db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      recordType: categories.recordType,
      archivedAt: categories.archivedAt,
    })
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .all();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const norm = (x: string) => x.replace(/\s+/g, '').replace(/[›>·]/g, '>');

  /** 子类别给了：要求命中叶子（二级）分类，且父级名称匹配主类别（若填） */
  if (sub) {
    for (const c of cats) {
      if (c.archivedAt || c.recordType !== recordType || !c.parentId) continue;
      const parent = byId.get(c.parentId);
      if (norm(c.name) === norm(sub) && (!main || (parent && norm(parent.name) === norm(main)))) {
        return c.id;
      }
    }
    return null;
  }
  /** 只给了主类别：作为二级（叶子）分类名匹配；本身是父级则无法落到具体账单 */
  if (!main) return null;
  for (const c of cats) {
    if (c.archivedAt || c.recordType !== recordType || !c.parentId) continue;
    if (norm(c.name) === norm(main)) return c.id;
  }
  return null;
}

/**
 * 标签名 → 标签 id。
 *
 * ⚠️ 与导出端一致：导入的「标签」列是**名字**（`、「」` 分隔），而 `createTransaction`
 *     要的是 **id**（`docs/05 §14.4` 的 transaction_tags 关联表只存 id）。
 *     此前漏了这层转换，导致整行报「标签不存在」而建不了账 —— 一个可选列的错误
 *     放大成整笔账单丢失（违反「可选列不该比必填列更严格」）。
 *
 * 映射不到的名字**静默丢弃**（不新建）：导入只认账本内已有的标签，
 * 新建标签属于「改变用户账本结构」的副作用，不该由导入悄悄做。
 */
function resolveTagNames(ctx: AppCtx, ledgerId: string, names: string[]): string[] {
  if (!names.length) return [];
  const rows = ctx.db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.ledgerId, ledgerId))
    .all();
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  const ids: string[] = [];
  for (const n of names) {
    const id = byName.get(n);
    if (id) ids.push(id);
  }
  return ids;
}

export function commit(
  ctx: AppCtx,
  actorId: string,
  ledgerId: string,
  buffer: Buffer,
  mapping: Mapping,
  allowDuplicate = false,
): ImportReport {
  if (!mapping.defaultAccountId) {
    throw HttpError.validation([{ field: 'mapping.defaultAccountId', message: '必须指定默认账户' }]);
  }
  const acc = ctx.db
    .select({ id: accounts.id, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledgerId), eq(accounts.id, mapping.defaultAccountId)))
    .get();
  if (!acc) throw HttpError.validation([{ field: 'mapping.defaultAccountId', message: '账户不存在' }]);
  if (acc.archivedAt) throw HttpError.validation([{ field: 'mapping.defaultAccountId', message: '账户已停用' }]);

  /** 校验默认分类与默认账户。收入兜底分类单独校（类型必须是 income） */
  function checkCategory(id: string | null | undefined, field: string, expectType?: string) {
    if (!id) return;
    const cat = ctx.db
      .select({ id: categories.id, archivedAt: categories.archivedAt, recordType: categories.recordType })
      .from(categories)
      .where(and(eq(categories.ledgerId, ledgerId), eq(categories.id, id)))
      .get();
    if (!cat) throw HttpError.validation([{ field, message: '分类不存在' }]);
    if (cat.archivedAt) throw HttpError.validation([{ field, message: '分类已停用' }]);
    if (expectType && cat.recordType !== expectType) {
      throw HttpError.validation([{ field, message: `分类类型必须是 ${expectType}` }]);
    }
  }
  checkCategory(mapping.defaultCategoryId, 'mapping.defaultCategoryId');
  checkCategory(mapping.incomeCategoryId, 'mapping.incomeCategoryId', 'income');

  const text = decodeCsv(buffer);
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw HttpError.validation([{ field: 'file', message: '文件里没有可导入的数据行' }]);
  }
  const { parsed, errors, total } = parseRows(rows, mapping, LIMITS.IMPORT_MAX_ROWS);

  /**
   * 账户名 → 账户（整批只查一次，建缓存）。
   *
   * ⚠️ 为什么要按名反查而不是沿用 `defaultAccountId`：
   *    从本系统导出的文件第 7 列就是账户名，不读它的话，
   *    原本分散在现金 / 银行卡 / 信用卡的流水会被**全部塞进同一个账户**，
   *    账户余额集体失真，而报告里零失败行 —— 静默的归集错误比报错糟糕得多。
   *
   * 只认账本内**已存在**的账户：导入不隐式建账户（与标签同一条纪律 ——
   * 新建账户属于「改变用户账本结构」的副作用，不该由导入悄悄做）。
   */
  const accRows = ctx.db
    .select({ id: accounts.id, name: accounts.name, kind: accounts.kind, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(eq(accounts.ledgerId, ledgerId))
    .all();
  const accByName = new Map(accRows.map((a) => [a.name.trim(), a]));

  const known = allowDuplicate ? new Set<string>() : existingKeys(ctx, ledgerId);
  const batch = new Set<string>();

  const report: ImportReport = { total, succeeded: 0, failed: errors.length, skipped: 0, errors: [...errors] };

  /**
   * **每行**先问自动分类规则，命中用规则的分类，没命中才退回 `defaultCategoryId`。
   *
   * 为什么必须是「每行」而不是「整个文件一个分类」：几百行流水里通常只有
   * 三五种商家，统一分类等于把 90% 的行归错，比不导入还糟。
   * 为什么规则优先于默认分类：用户设默认分类是「兜底」，设规则是「明确知道」，
   * 明确知道的应当压过兜底。
   */
  const ruleHits = classifyRows(
    ctx,
    ledgerId,
    parsed.map((p) => ({
      recordType: p.recordType,
      merchant: p.merchant,
      name: p.merchant,
      note: p.note,
    })),
  );
  const perRule = new Map<string, number>();

  for (let idx = 0; idx < parsed.length; idx++) {
    const p = parsed[idx]!;
    const hit = ruleHits[idx] ?? null;

    /**
     * 导入只支持**收支两类**（顺序在分类检查之前）。
     *
     * 参考文档的「类型」列有 6 种取值，但转账需要对方账户、
     * 余额调整需要方向、应收/应付要走债权债务账户 ——
     * 这些都不是「一个默认账户 + 一个默认分类」能表达的。
     *
     * ⚠️ 必须在这里**显式拦住并说人话**，且必须排在分类检查**之前**：
     * 转账行本来就没有分类，让它先撞上「未匹配到分类」，
     * 用户看到的是一条与真正原因无关的错误，然后去反复调分类映射 ——
     * 而正确做法是压根不映射「类型」列。异常必须指向真正的原因。
     */
    if (p.recordType !== 'expense' && p.recordType !== 'income') {
      report.failed += 1;
      report.errors.push({
        row: p.row,
        column: mapping.recordTypeColumn ?? mapping.amountColumn,
        value: p.rawType ?? '',
        message: `「${RECORD_TYPE_LABEL[p.recordType]}」暂不支持批量导入（转账需指定对方账户、余额调整需指定方向、应收/应付走债权债务账户），请导入后单独补录`,
      });
      continue;
    }

    /**
     * 账户归属：**优先用本行「账户」列写的名字**，没写才退回 `defaultAccountId`。
     *
     * ⚠️ 查不到时**该行失败**，绝不静默退回兜底账户 ——
     *    把一笔「招行信用卡」的消费记到「现金」上，是方向性的错账，
     *    且用户在报告里看不到任何提示（这是改之前最危险的地方）。
     */
    let accountId = mapping.defaultAccountId;
    const accName = p.accountName?.trim();
    if (accName) {
      const hit = accByName.get(accName);
      if (!hit) {
        report.failed += 1;
        report.errors.push({
          row: p.row,
          column: mapping.accountColumn ?? mapping.amountColumn,
          value: accName,
          message: `账户「${accName}」在本账本里不存在（导入不会自动建账户，请先建好同名账户）`,
        });
        continue;
      }
      if (hit.archivedAt) {
        report.failed += 1;
        report.errors.push({
          row: p.row,
          column: mapping.accountColumn ?? mapping.amountColumn,
          value: accName,
          message: `账户「${accName}」已停用，请先在账户页恢复`,
        });
        continue;
      }
      if (hit.kind === 'virtual') {
        report.failed += 1;
        report.errors.push({
          row: p.row,
          column: mapping.accountColumn ?? mapping.amountColumn,
          value: accName,
          message: `「${accName}」是债权债务 / 系统账户，不能作为导入目标`,
        });
        continue;
      }
      accountId = hit.id;
    }

    /** 收入行用收入兜底分类 —— 分类树按 record_type 分开，支出分类配收入行必被拒 */
    const fallbackCat =
      p.recordType === 'income' ? (mapping.incomeCategoryId ?? null) : (mapping.defaultCategoryId ?? null);
    /**
     * 分类解析优先级：自动分类规则 → 「主类别 / 子类别」列写明的分类名 → 兜底分类。
     *
     * 文件里**显式写明的分类**最可信，压过「按商家猜」的规则；
     * 但写错名字（未命中）时不报错，退回规则/兜底，避免一个错别字全盘失败。
     */
    const categoryId = hit?.categoryId ?? resolveCategoryByNames(ctx, ledgerId, p.recordType, p.mainCategoryName, p.subCategoryName) ?? fallbackCat;

    if (!categoryId) {
      // expense/income/… 都强制要求分类；没有规则命中又没有默认分类 → 这一行注定建不了，
      // 与其让它在建账时抛「请选择分类」（错误信息指向一个用户根本没填的表单字段），
      // 不如在这里说清楚「这一行没匹配到分类」。
      report.failed += 1;
      report.errors.push({
        row: p.row,
        column: mapping.merchantColumn ?? mapping.noteColumn ?? mapping.amountColumn,
        value: p.merchant ?? '',
        message: '未匹配到自动分类规则，也未指定默认分类',
      });
      continue;
    }

    const k = dupKey(p.txDate, Math.round(Number(p.amount) * 100), p.merchant);
    if (known.has(k) || batch.has(k)) {
      report.skipped += 1;
      report.errors.push({
        row: p.row,
        column: mapping.amountColumn,
        value: p.amount,
        message: allowDuplicate ? '文件内重复行' : '与已有账单重复',
      });
      continue;
    }
    try {
      /**
       * 走 `createTransaction` 而不是直接插表：
       * 导入的账单与手记的账单**没有任何区别** —— 同样要过金额计算、账户影响、
       * 方向校验、锁账校验。少走一步就等于给导入开了一个绕过账务规约的后门。
       *
       * 幂等键用**行号 + 金额 + 商家**而不是循环序号：同一份文件重复提交时
       * 键完全相同 → 命中唯一索引返回原记录，不产生第二份。
       */
      /**
       * 手续费 / 折扣只在**该记录类型支持**时才带过去。
       *
       * ⚠️ 这是硬性账务约束（不是 UI 显隐）：`docs/03 §1.2` 的公式里
       *    transfer 与「应收·产生」没有 D，adjustment 连 F 都没有。
       *    无条件带上会让后端以「该类型不支持手续费」拒绝整行 ——
       *    而文件里那一格只是**原本就没有值**被写成了 0，不是用户填错。
       */
      const fee = p.fee && FEE_APPLICABLE[p.recordType].length ? p.fee : '0';
      const discount = p.discount && DISCOUNT_APPLICABLE[p.recordType].length ? p.discount : '0';
      createTransaction(ctx, actorId, ledgerId, {
        recordType: p.recordType,
        accountId,
        categoryId,
        name: p.name || p.merchant || '导入的账单',
        merchant: p.merchant,
        note: p.note,
        amount: p.amount,
        fee,
        discount,
        txDate: p.txDate > todayStr() ? todayStr() : p.txDate,
        txTime: p.txTime,
        counterparty: p.counterparty,
        tags: resolveTagNames(ctx, ledgerId, p.tags),
        clientRequestId: `import:${ledgerId}:${p.row}:${Math.abs(Math.round(Number(p.amount) * 100))}:${p.merchant ?? ''}`,
      });
      batch.add(k);
      report.succeeded += 1;
      if (hit) perRule.set(hit.ruleId, (perRule.get(hit.ruleId) ?? 0) + 1);
    } catch (err) {
      report.failed += 1;
      /** 把后端真正的校验字段/原因带回界面，而不是模糊的「请求参数校验失败」 */
      const detail = err instanceof AppError ? err.details?.[0] : undefined;
      report.errors.push({
        row: p.row,
        column: detail?.field ?? mapping.amountColumn,
        value: detail ? p.amount : p.amount,
        message: detail ? `${detail.message}` : err instanceof Error ? err.message : String(err),
      });
    }
  }

  bumpHitCounts(ctx, ledgerId, perRule);

  writeAudit(ctx.db, {
    ledgerId,
    actorId,
    action: 'import',
    entityType: 'transaction',
    entityId: 'batch',
    summary: `导入账单：成功 ${report.succeeded}、失败 ${report.failed}、跳过 ${report.skipped}`,
    after: {
      succeeded: report.succeeded,
      failed: report.failed,
      skipped: report.skipped,
      total: report.total,
      /** 兜底账户；`accountColumn` 有值时大部分行并不落在它上面，故一并记录列映射 */
      accountId: mapping.defaultAccountId,
      accountColumn: mapping.accountColumn ?? null,
    },
  });

  return report;
}
