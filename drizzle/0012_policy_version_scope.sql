CREATE TABLE `__new_stats_policy_versions` (
  `version` text NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `effective_from` text NOT NULL,
  `changes_json` text NOT NULL,
  `note` text,
  `created_by` text REFERENCES users(id) ON DELETE SET NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`version`, `ledger_id`)
);--> statement-breakpoint
INSERT INTO `__new_stats_policy_versions` (`version`, `ledger_id`, `effective_from`, `changes_json`, `note`, `created_by`, `created_at`) SELECT `version`, `ledger_id`, `effective_from`, `changes_json`, `note`, `created_by`, `created_at` FROM `stats_policy_versions`;--> statement-breakpoint
DROP TABLE `stats_policy_versions`;--> statement-breakpoint
ALTER TABLE `__new_stats_policy_versions` RENAME TO `stats_policy_versions`;--> statement-breakpoint
CREATE INDEX `idx_policy_ledger` ON `stats_policy_versions` (ledger_id, effective_from);

-- ==========================================================================
-- 0012：口径版本号的唯一性从「全局」改为「每个账本内」
--
-- 0011 建表时把 `version` 单独当主键。这是错的：
--   · 口径版本是**账本内部**的记账约定（"v2 起内部转账不计收支"），
--     两个账本各自叫 v2 完全合理；
--   · 而全局唯一会让「A 账本建了 v2」之后 B 账本永远建不出 v2 ——
--     实测表现是第二个账本 POST /stats/policies 直接 500
--     （UNIQUE constraint failed），而报错栈指向 insert，看不出是建表的问题。
--
-- 改成复合主键 (version, ledger_id)。表是 0011 才建的，数据量可忽略，
-- 用 SQLite 标准的「新建 → 搬迁 → 删除 → 改名」四步重建。
-- ==========================================================================
