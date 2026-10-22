import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECORD_TYPE_LABEL, RECORD_TYPES } from '../src/config/constants';
import { MAPPING_TEMPLATES, decodeCsv, guessMapping, parseCsv, parseRows } from '../src/modules/imports/service';

/**
 * 导入映射契约测试。
 *
 * ## 为什么要拿真实文件做断言
 *
 * 导出端表头定义在**前端**（`public/assets/views/transactions.js › rowsToCsv()`），
 * 导入端模板在**后端**（本文件）。两者是同一份契约的两半，
 * 天然会漂移 —— 而漂移的表现是「自己的导出文件导不回来」，
 * 且**零报错**：只猜中 3 列，类型、方向、分类、账户全部丢失。
 *
 * 所以这里不写「我以为的 18 个列名」，而是读真实导出文件比对。
 */

const EXPORT_HEADERS = [
  '日期', '时间', '类型', '方向', '主类别', '子类别', '账户', '转入账户',
  '名称', '商家', '对象', '金额', '手续费', '折扣', '实际值', '标签', '备注', '记账人',
];

const REF_CSV = 'C:/Users/xieyi/Desktop/账单_我的账本_2026-10-18.csv';
const tpl = MAPPING_TEMPLATES.find((t) => t.key === 'cc-ledger')!;

/**
 * 旧版导出只有「分类」单列，新版拆成「主类别 / 子类别」两列。
 * 真机参考文件可能是任一种格式，统一归一到新格式再比对，
 * 这样无论 fixture 是旧 17 列还是新 18 列，契约断言都稳定。
 */
function normalizeHeader(h: string[]): string[] {
  const i = h.indexOf('分类');
  if (i >= 0 && !h.includes('主类别')) {
    const out = h.slice();
    out.splice(i, 1, '主类别', '子类别');
    return out;
  }
  return h;
}

/** 读参考文档（存在才读；不存在时用内联表头，保证 CI 也能跑） */
function refHeader(): string[] {
  try {
    const rows = parseCsv(decodeCsv(readFileSync(REF_CSV)));
    return (rows[0] ?? []).map((c) => c.trim());
  } catch {
    return EXPORT_HEADERS;
  }
}

describe('导入模板 · CC记账导出账单（18 列契约）', () => {
  it('列名、顺序、数量与导出端逐字一致', () => {
    const doc = tpl.doc!;
    expect(doc.map((d) => d.column)).toEqual(EXPORT_HEADERS);
    expect(doc.map((d) => d.column)).toEqual(normalizeHeader(refHeader()));
    // 顺序必须是文档顺序，不能只是集合相等
    expect(doc.map((d) => d.index)).toEqual(EXPORT_HEADERS.map((_, i) => i + 1));
  });

  it('不得遗漏也不得新增：18 列全部有交代（含类型/必填/去向）', () => {
    for (const d of tpl.doc!) {
      expect(d.hint, `列「${d.column}」缺说明`).toBeTruthy();
      expect(['text', 'date', 'time', 'money', 'enum', 'ref']).toContain(d.kind);
      expect(typeof d.required).toBe('boolean');
    }
    // 枚举列必须写出取值域
    for (const d of tpl.doc!.filter((x) => x.kind === 'enum')) {
      expect(d.values?.length, `枚举列「${d.column}」缺取值域`).toBeGreaterThan(0);
    }
  });

  it('「类型」列取值域 = 6 种记录类型', () => {
    const type = tpl.doc!.find((d) => d.column === '类型')!;
    // 文档用短名「应收/应付」，标签是「应收款项/应付款项」——允许两者
    expect(type.values!.sort()).toEqual(
      [...RECORD_TYPES].map((r) => (r === 'receivable' ? '应收' : r === 'payable' ? '应付' : RECORD_TYPE_LABEL[r])).sort(),
    );
  });

  it('非必填项都带「不填会怎样」的提示（用户明确要求）', () => {
    for (const d of tpl.doc!.filter((x) => !x.required)) {
      expect(d.hint.length).toBeGreaterThan(4);
    }
  });

  it('派生列「实际值」绝不可被映射（= 金额+手续费−折扣，会双重计入）', () => {
    expect(tpl.doc!.find((d) => d.column === '实际值')!.consume).toBeNull();
  });

  it('引用列（账户 / 转入账户）不读取：导入不做隐式建账户', () => {
    for (const n of ['账户', '转入账户']) {
      expect(tpl.doc!.find((d) => d.column === n)!.consume).toBeNull();
    }
  });

  it('可选列均可映射（时间 / 名称 / 对象 / 主类别 / 子类别 / 手续费 / 折扣 / 标签）', () => {
    const m = {
      timeColumn: '时间',
      nameColumn: '名称',
      counterpartyColumn: '对象',
      mainCategoryColumn: '主类别',
      subCategoryColumn: '子类别',
      feeColumn: '手续费',
      discountColumn: '折扣',
      tagsColumn: '标签',
    };
    for (const [field, col] of Object.entries(m)) {
      expect(tpl.doc!.find((d) => d.column === col)!.consume).toBe(field);
    }
  });
});

describe('guessMapping · 自己的导出文件要能被完整识别', () => {
  const rows = parseCsv(decodeCsv(Buffer.from(EXPORT_HEADERS.join(','), 'utf-8')));

  it('命中 cc-ledger 模板', () => {
    expect(guessMapping(EXPORT_HEADERS).matchedKey).toBe('cc-ledger');
  });

  it('核心列字段全部命中（此前只命中 3 个，类型列丢失）', () => {
    const { mapping } = guessMapping(EXPORT_HEADERS);
    expect(mapping.dateColumn).toBe('日期');
    expect(mapping.amountColumn).toBe('金额');
    expect(mapping.merchantColumn).toBe('商家');
    expect(mapping.noteColumn).toBe('备注');
    expect(mapping.recordTypeColumn).toBe('类型');
    expect(mapping.mainCategoryColumn).toBe('主类别');
    expect(mapping.subCategoryColumn).toBe('子类别');
  });

  it('解析真实参考文档：类型列按行还原记录类型', () => {
    let csv: string;
    try {
      csv = decodeCsv(readFileSync(REF_CSV));
    } catch {
      return; // 本机无该文件时跳过
    }
    const all = parseCsv(csv);
    const { mapping } = guessMapping((all[0] ?? []).map((c) => c.trim()));
    const { parsed } = parseRows(all, {
      dateColumn: mapping.dateColumn!,
      amountColumn: mapping.amountColumn!,
      merchantColumn: mapping.merchantColumn ?? null,
      noteColumn: mapping.noteColumn ?? null,
      recordTypeColumn: mapping.recordTypeColumn ?? null,
      recordType: 'expense',
      defaultAccountId: 'acc_x',
    }, 1000);

    expect(parsed.length).toBeGreaterThan(0);
    // 关键回归：「应收」含「收」，早先用正则 /收/ 判成收入 —— 方向性错误且不报错
    expect(parsed.some((p) => p.recordType === 'receivable')).toBe(true);
    expect(parsed.some((p) => p.recordType === 'payable')).toBe(true);
    expect(parsed.some((p) => p.recordType === 'transfer')).toBe(true);
    expect(parsed.some((p) => p.recordType === 'adjustment')).toBe(true);
    expect(parsed.some((p) => p.recordType === 'expense')).toBe(true);
    expect(parsed.some((p) => p.recordType === 'income')).toBe(true);
    // 原始类型值回显，报错时用户能对上自己文件里那一格
    expect(parsed.filter((p) => p.recordType === 'receivable').every((p) => p.rawType === '应收')).toBe(true);
    void rows;
  });

  it('「不计收支」不判成收入（支付宝/微信的既有取值，含「收」字）', () => {
    const header = ['交易时间', '金额', '交易对方', '收/支'];
    const rows = [
      header,
      ['2026-03-01 10:00:00', '100.00', '退款', '不计收支'],
      ['2026-03-02 10:00:00', '200.00', '工资', '收入'],
    ];
    const { parsed } = parseRows(
      rows,
      {
        dateColumn: '交易时间',
        amountColumn: '金额',
        merchantColumn: '交易对方',
        noteColumn: null,
        directionColumn: '收/支',
        recordType: 'expense',
        defaultAccountId: 'acc_x',
      },
      10,
    );
    expect(parsed[0]!.recordType).toBe('expense'); // 尊重默认，而不是凭空记一笔收入
    expect(parsed[1]!.recordType).toBe('income');
  });
});