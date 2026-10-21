CREATE INDEX `idx_tx_ledger_txdate` ON `transactions` (`ledger_id`, `tx_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_ledger_type_txdate` ON `transactions` (`ledger_id`, `record_type`, `tx_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_account_txdate` ON `transactions` (`ledger_id`, `account_id`, `tx_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_to_account_txdate` ON `transactions` (`ledger_id`, `to_account_id`, `tx_date`);--> statement-breakpoint
CREATE INDEX `idx_tx_live_txdate` ON `transactions` (`ledger_id`, `tx_date`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acc_virtual_unique` ON `accounts` (`ledger_id`, `type`) WHERE `kind` = 'virtual';--> statement-breakpoint
CREATE INDEX `idx_recon_ledger` ON `reconciliation_records` (`ledger_id`, `reconcile_date`);

-- ==========================================================================
-- 0013：按 `tx_date` 区间查询的索引 + 虚拟账户唯一约束
--
-- ## 为什么必须补 `tx_date` 索引（这是本迁移的主要动因）
--
-- 迁移 0000 建的 11 个 `transactions` 索引**全部以 `occurred_at` 结尾**：
--   (ledger_id, occurred_at) / (ledger_id, account_id, occurred_at) / ...
-- 而**所有**按日期区间的查询用的都是 `tx_date`：
--   · `periodFlow()`        accounts/service.ts —— 概览、统计、预算已花、同比环比
--   · `ledgerDeltas()`      accounts/balance.ts —— 账户余额、净资产、对账 systemBalance
--   · `heatmap` / `drilldown` / `budget.spent*`
-- SQLite **无法**用 `occurred_at` 索引服务 `tx_date BETWEEN` 谓词，
-- 于是统计、余额、对账三条主链路全部走全表扫描。
--
-- `occurred_at` 索引**保留**：账单列表按时间排序仍然需要它。
--
-- ## 为什么用部分索引表达软删
--
-- 全站查询必带 `deleted_at IS NULL`，而迁移 0000 只给了单列 `idx_tx_deleted`，
-- 它服务不了 `ledger_id = ? AND deleted_at IS NULL` 这类条件。
-- 这里用 `WHERE deleted_at IS NULL` 的部分索引：软删行占比极低，
-- 部分索引能显著减小体积（`02 §5.1` 对 merchant/counterparty 已是同一手法）。
--
-- ## 虚拟账户唯一约束（防静默错账）
--
-- `docs/03 §8.1` 脚注 ¹² 声明「每类虚拟账户在账本内只有唯一一个」，
-- 但此前只有 `UNIQUE(ledger_id, name)`，没有任何 DB 约束。
-- `debts/service.ts` 用 `find(x => x.type === type && x.kind === 'virtual')`
-- **取第一个** —— 一旦出现两个 receivable 虚拟账户，台账余额会随机取一个且**不报错**。
-- 用部分唯一索引钉死它。
--
-- ## 回滚
--
-- 全是 `CREATE INDEX` —— 回滚就是对应的 `DROP INDEX`，秒级、零数据风险：
--   DROP INDEX idx_tx_ledger_txdate; DROP INDEX idx_tx_ledger_type_txdate;
--   DROP INDEX idx_tx_account_txdate; DROP INDEX idx_tx_to_account_txdate;
--   DROP INDEX idx_tx_live_txdate;    DROP INDEX idx_acc_virtual_unique;
--   DROP INDEX idx_recon_ledger;
--
-- ⚠️ 唯一索引若在建库时失败，说明存量存在重复虚拟账户 ——
--    先跑 `SELECT ledger_id, type, COUNT(*) FROM accounts WHERE kind='virtual'
--          GROUP BY 1,2 HAVING COUNT(*)>1;` 清理，**不要**删掉这条迁移。
--
-- ## 刻意没做的两件事（理由记在这里，避免后人重复决策）
--
-- 1. **没有给 `transactions` 加 `CHECK(actual_amount >= 0)` 等约束**。
--    SQLite 加 CHECK 必须重建表，而 `transaction_tags` / `transaction_settlements`
--    等子表对 `transactions.id` 是 `ON DELETE CASCADE` ——
--    `DROP TABLE transactions` 会**级联删掉全部关联数据**。
--    为两条防御性约束冒全表数据丢失的风险不成比例。
--    替代方案：这些不变量由 `calculateAmounts()` 在写入时保证（已有 13 个必测用例），
--    并由 `npm run audit:ledger` 对存量做只读校验。
--
-- 2. **没有补 `attachments.ledger_id` 的外键**。同样是重建表，收益（应用层已隔离）
--    低于风险。留待未来若真需要重建 attachments 时一并处理。
-- ==========================================================================
