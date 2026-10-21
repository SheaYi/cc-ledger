ALTER TABLE `budgets` ADD `period_start` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `period_end` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `period_label` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `alert_enabled` integer;--> statement-breakpoint
CREATE TABLE `budget_alerts` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `budget_id` text NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  `period_key` text NOT NULL,
  `level` text NOT NULL,
  `triggered_at` text NOT NULL,
  `notified_at` text,
  UNIQUE (`budget_id`, `period_key`, `level`)
);--> statement-breakpoint
CREATE INDEX `idx_alert_ledger` ON `budget_alerts` (ledger_id, triggered_at);--> statement-breakpoint
CREATE TABLE `budget_prefs` (
  `ledger_id` text PRIMARY KEY NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `default_alert_ratio` integer NOT NULL DEFAULT 80,
  `dnd_enabled` integer NOT NULL DEFAULT 0,
  `dnd_from` text,
  `dnd_to` text,
  `notify_on_create` integer NOT NULL DEFAULT 1,
  `prediction_min_days` integer NOT NULL DEFAULT 3,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `budget_rollovers` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `from_budget_id` text REFERENCES budgets(id) ON DELETE CASCADE,
  `to_budget_id` text REFERENCES budgets(id) ON DELETE CASCADE,
  `from_period` text NOT NULL,
  `to_period` text NOT NULL,
  `mode` text NOT NULL,
  `amount` integer NOT NULL,
  `remaining_at_close` integer NOT NULL,
  `note` text,
  `reversed_at` text,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  CHECK (`mode` IN ('clear', 'carry', 'to_savings'))
);--> statement-breakpoint
CREATE INDEX `idx_rollover_ledger` ON `budget_rollovers` (ledger_id, from_period);--> statement-breakpoint
CREATE INDEX `idx_rollover_target` ON `budget_rollovers` (to_budget_id);--> statement-breakpoint
CREATE TABLE `budget_pools` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `name` text NOT NULL,
  `target_amount` integer NOT NULL,
  `target_date` text NOT NULL,
  `saved_amount` integer NOT NULL DEFAULT 0,
  `savings_account_id` text REFERENCES accounts(id) ON DELETE SET NULL,
  `expense_category_id` text REFERENCES categories(id) ON DELETE SET NULL,
  `status` text NOT NULL DEFAULT 'active',
  `note` text,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CHECK (`status` IN ('active', 'fulfilled', 'archived'))
);--> statement-breakpoint
CREATE INDEX `idx_pool_ledger` ON `budget_pools` (ledger_id, status);--> statement-breakpoint
CREATE TABLE `budget_pool_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `pool_id` text NOT NULL REFERENCES budget_pools(id) ON DELETE CASCADE,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `amount` integer NOT NULL,
  `occurred_on` text NOT NULL,
  `related_tx_id` text REFERENCES transactions(id) ON DELETE SET NULL,
  `note` text,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  CHECK (`kind` IN ('contribute', 'spend', 'adjust', 'refund'))
);--> statement-breakpoint
CREATE INDEX `idx_pool_entry` ON `budget_pool_entries` (pool_id, occurred_on);--> statement-breakpoint
CREATE TABLE `budget_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `name` text NOT NULL,
  `note` text,
  `items_json` text NOT NULL,
  `is_default` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_btpl_ledger` ON `budget_templates` (ledger_id);--> statement-breakpoint
ALTER TABLE `budgets` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `scope_id` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `project_label` text;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_budget_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_budget_unique` ON `budgets` (`ledger_id`,`category_id`,`period_type`,`year`,`month`) WHERE `period_type` IN ('monthly','yearly');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_budget_scope_unique` ON `budgets` (ledger_id, scope, scope_id, period_type, year, month, period_start, period_end);--> statement-breakpoint
ALTER TABLE `budgets` ADD `visibility` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `owner_id` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE TABLE `budget_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `budget_id` text REFERENCES budgets(id) ON DELETE SET NULL,
  `action` text NOT NULL,
  `before_json` text,
  `after_json` text,
  `note` text,
  `actor_id` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_bchange_budget` ON `budget_changes` (budget_id, created_at);--> statement-breakpoint
CREATE INDEX `idx_bchange_ledger` ON `budget_changes` (ledger_id, created_at);

-- ==========================================================================
-- 0010：预算模块的数据模型扩展（B-01 比例法 / B-05 预警与免打扰 /
--       B-07 多周期（周预算·自定义账期）/ B-08 结转 / B-09 专项预算池 /
--       B-11 模板与推荐 / B-12 标签·项目预算 / B-13 家庭共享）
-- ==========================================================================
