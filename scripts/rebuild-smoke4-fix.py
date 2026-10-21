#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修正 `rebuild-infer.mjs` 落笔后的**语义绑定错误**。

自动推断把 `{id}` 绑成「该行之前最后一次出现的 `.id` 变量」——
这在**同一资源内**可靠，跨资源就必然错：分类段被绑成了 `feeAcc.id`（手续费账户），
447 行甚至绑出了不存在的 `t`。这些必须按上下文逐条写死。
"""
import io
import sys

# 行号 → (正确的路径片段, 依据)
FIX = {
    128: ("/ledgers/${ledgerB}/account-groups",
          "「跨账本读分组 → 404」：要用**别人**的账本，ledgerA 是自己的"),
    382: ("/ledgers/${ledgerA}/categories/${newCatId}",
          "上一行 check 断言 `c.id === newCatId`，删的就是它"),
    391: ("/ledgers/${ledgerA}/categories/${presetChild.id}",
          "上面 `const presetChild = presetParent?.children?.[0]`"),
    396: ("/ledgers/${ledgerA}/categories/${presetChild.id}",
          "同上（换展示图标）"),
    401: ("/ledgers/${ledgerA}/categories/${presetChild.id}",
          "同上（停用/归档）"),
    403: ("/ledgers/${ledgerA}/categories/${presetChild.id}/restore",
          "同上（恢复）"),
    417: ("/ledgers/${ledgerA}/categories/${usedCat.id}",
          "上一行 `usedParent = r.json.data.find(p => p.id === usedCat.id)`"),
    447: ("/ledgers/${ledgerA}/tags/${tagId}",
          "上一行 check 断言 `t.id === tagId`；自动绑定错成了不存在的 `t`"),
}

path = sys.argv[1] if len(sys.argv) > 1 else 'scripts/smoke-stage4.mjs'
lines = io.open(path, encoding='utf-8').read().split('\n')

import re
# 定位每行里 `/ledgers/${…}` 的完整片段并整段替换
# （结尾 `)` 属于 [^`] 的字符类，别漏掉）
PAT = re.compile(r'`/ledgers/\$\{[^`]*`')

applied = 0
for lineno, (frag, why) in sorted(FIX.items()):
    i = lineno - 1
    if i >= len(lines) or not PAT.search(lines[i]):
        print('  ⚠️ L%d 未匹配到路径片段' % lineno)
        continue
    lines[i] = PAT.sub(lambda _m: '`' + frag + '`', lines[i], count=1)
    applied += 1

io.open(path, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
print('修正绑定 %d / %d 处' % (applied, len(FIX)))
for k in sorted(FIX):
    print('  L%-4d %-58s %s' % (k, FIX[k][0], FIX[k][1]))
