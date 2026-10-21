#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重建脚本（一次性工具）

用法：  python3 scripts/rebuild-paths.py '<json>'

JSON 形态：{"file": {"行号": "新的一整行内容", ...}, ...}

存在的理由：2026-08-14 我用一段有缺陷的正则批量给脚本加 `P` 标签前缀，
它把整个模板（含 `${...}` 与路径后缀）一起替换掉了，**丢失了 244 行路径**。
本脚本按**行号精确替换**，不做任何正则猜测 —— 恢复期的每一步都必须可核对。
"""
import io
import json
import sys

plan = json.loads(sys.argv[1])
for path, edits in plan.items():
    lines = io.open(path, encoding="utf-8").read().split("\n")
    for lineno, new in edits.items():
        n = int(lineno)
        old = lines[n - 1]
        lines[n - 1] = new
        print("  %s:%d" % (path.split("/")[-1], n))
        print("    - %s" % old.strip()[:118])
        print("    + %s" % new.strip()[:118])
    io.open(path, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("重建完成")
