#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
smoke4 最后 21 处的**显式映射**（人工判读后落笔）。

为什么单独一个文件：`rebuild-infer.mjs` 只对「规则能确定」的项落笔，
剩下这 21 处要么无 check 文本、要么动词与路由方法看起来不一致 ——
但读过上下文后可以确定。**逐条写死**而不是再放宽规则，
是因为放宽规则会让判据变松，而松的判据会产出「看起来对」的假绿。

每条都附判读依据（哪一行 check / 哪个 body 字段），便于事后复核。
"""
import io
import json
import sys

# 行号 → (完整路径片段, 判读依据)
MAPPING = {
    138: ("/ledgers/${ledgerA}/accounts",
          "body: { groupId, name, type, openingBalance, openingDate } → 建账户；下一行 check「虚拟账户 kind=virtual」是紧随其后的另一条"),
    167: ("/ledgers/${ledgerA}/accounts",
          "body: { groupId: newGroupId, name: '转入户', type: 'debit_card' } → 建账户"),
    254: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "后续 check 读 r.json.data.balance → 余额接口"),
    268: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "「未删除时计入（5888.89 − 3333.33）」读 .data.balance → 余额接口；推断器把它当 POST 是动词表误判"),
    271: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "「软删除后余额自动回滚到 5888.89」读 .data.balance → 余额接口；同上误判"),
    320: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "转账后校验双方余额，读 .data.balance"),
    334: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "同上"),
    385: ("/ledgers/${ledgerA}/categories",
          "「归档后默认列表不再出现」指分类列表"),
    462: ("/ledgers/${ledgerA}/accounts/${acc.id}/reconcile/preview",
          "「对账预览 200」；推断器已给出同一路径（被动词表误判为存疑）"),
    503: ("/ledgers/${ledgerA}/accounts/${acc.id}",
          "「账户 lastReconciledAt 已更新」→ 读单个账户详情"),
    516: ("/ledgers/${ledgerA}/accounts/${acc.id}/reconcile",
          "「reasonCode=other 缺说明 → 400」→ 提交对账"),
    529: ("/ledgers/${ledgerA}/accounts/${acc.id}/balance",
          "「对账可锁定此前账单」前的余额核对"),
    531: ("/ledgers/${ledgerA}/accounts/${acc.id}/reconcile",
          "带 lockBeforeDate 的对账提交"),
    585: ("/ledgers/${ledgerA}/accounts?includeArchived=true",
          "「includeArchived=true 可查到」"),
    625: ("/ledgers/${ledgerA}/account-groups?includeArchived=true",
          "「物理删除后 includeArchived 也不含」"),
    629: ("/ledgers/${ledgerA}/account-groups",
          "「删除后同名可重建 201」"),
    650: ("/ledgers/${ledgerA}/account-groups",
          "「停用分组默认不可见」→ 默认列表"),
    656: ("/ledgers/${ledgerA}/account-groups",
          "「停用后同名可重建 201（部分唯一索引）」"),
    671: ("/ledgers/${ledgerA}/account-groups",
          "「恢复后默认列表可见」"),
    675: ("/ledgers/${ledgerA}/account-groups/${grp.id}/restore",
          "「重复恢复幂等 200」"),
    687: ("/ledgers/${ledgerA}/account-groups",
          "「无令牌建分组 → 401」，沿用上一处的资源"),
}

path = sys.argv[1] if len(sys.argv) > 1 else 'scripts/smoke-stage4.mjs'
lines = io.open(path, encoding='utf-8').read().split('\n')

OLD = 'P`/ledgers/'
applied, missed = 0, []
for lineno, (frag, why) in sorted(MAPPING.items()):
    i = lineno - 1
    if i >= len(lines) or OLD not in lines[i]:
        missed.append((lineno, '该行已无待替换片段'))
        continue
    lines[i] = lines[i].replace(OLD, '`' + frag + '`')
    applied += 1

io.open(path, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
print(f'显式映射落笔 {applied} / {len(MAPPING)} 处')
for m in missed:
    print('  未落笔 L%d：%s' % m)

# 复核：还有没有残留的破损行
left = [i + 1 for i, l in enumerate(lines) if OLD in l]
print('仍破损：', left if left else '无')
