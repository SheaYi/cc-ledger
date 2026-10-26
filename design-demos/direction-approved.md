# 方向批准记录 · direction-approved

> 按 `huashu-design` 的三方向门要求落档。实现开工前必须具备此文件。

- **日期**：2026-10-26
- **项目**：CC记账（cc-ledger）· 手机端全量 UI 重设计
- **展示的三版**：A 钱包优先 / B 流水优先 / C 即记即走
- **原型**：`design-demos/mobile-home-directions.html`
- **截图**：`screenshots/design-directions.png`（1320px 三列真实渲染，用项目现有 token 值）

## 用户选择（原话）

> **A**

> **同意**

*（第二个「同意」是对「是否沿用现有 token 体系」的答复。）*

## 落定结论

1. **方向 = A · 钱包优先**
   参照 Apple Wallet / 招行掌上生活。**先给结论再给流水**：开屏一张净资产卡（复用已有
   `--c-hero-panel`），底部带 30 天走势面积图；其下依次是本月收支、账户横滑卡、快速记账入口、
   最近流水。

2. **沿用现有 token 体系，不换视觉语言**
   `tokens.css` 保持不动。三个方向共用同一套语义色与尺度，只改信息架构。
   理由：`tokens.css` 一改桌面端跟着全变，且 `audit:contrast`（对比度闸门）与
   `probe:mobile`（51 项断言）会成批失效。

## 三项豁免说明

- 本次是在**既有生产 App** 上做页面级重设计，不是从零做视觉物料，故不适用「≥45s 长片渲染前
  的 hook 硬检查」。
- Skill 自述「生产级 Web App 不适用」，本次按 references/app-prototype.md 的**原型路线**使用：
  用其方向探索与品位，不改既有 Design System（见结论 2）。
- 用户已明确选定方向，本次会话后续迭代按 SKILL.md「窄桥」豁免，不再重复三方向门。
