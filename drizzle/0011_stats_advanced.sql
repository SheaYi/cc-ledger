ALTER TABLE `categories` ADD `cash_flow` text;--> statement-breakpoint
CREATE TABLE `net_worth_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `snapshot_date` text NOT NULL,
  `asset_total` integer NOT NULL,
  `liability_total` integer NOT NULL,
  `net_worth` integer NOT NULL,
  `account_count` integer NOT NULL,
  `policy_version` text NOT NULL,
  `valuation_note` text,
  `created_at` text NOT NULL,
  UNIQUE (`ledger_id`, `snapshot_date`)
);--> statement-breakpoint
CREATE INDEX `idx_nw_ledger` ON `net_worth_snapshots` (ledger_id, snapshot_date);--> statement-breakpoint
CREATE TABLE `stats_policy_versions` (
  `version` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `effective_from` text NOT NULL,
  `changes_json` text NOT NULL,
  `note` text,
  `created_by` text REFERENCES users(id) ON DELETE SET NULL,
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_policy_ledger` ON `stats_policy_versions` (ledger_id, effective_from);--> statement-breakpoint
CREATE TABLE `stat_events` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `event_date` text NOT NULL,
  `title` text NOT NULL,
  `note` text,
  `expected_amount` integer,
  `tag_id` text REFERENCES tags(id) ON DELETE SET NULL,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_event_ledger` ON `stat_events` (ledger_id, event_date);--> statement-breakpoint
CREATE TABLE `saved_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `name` text NOT NULL,
  `config_json` text NOT NULL,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_report_ledger` ON `saved_reports` (ledger_id, sort_order);--> statement-breakpoint
CREATE TABLE `reimbursements` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `origin_tx_id` text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  `received_tx_id` text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  `amount` integer NOT NULL,
  `claim_date` text NOT NULL,
  `received_date` text NOT NULL,
  `org_name` text,
  `note` text,
  `status` text NOT NULL DEFAULT 'confirmed',
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CHECK (`status` IN ('pending', 'confirmed', 'void'))
);--> statement-breakpoint
CREATE INDEX `idx_reimb_origin` ON `reimbursements` (origin_tx_id);--> statement-breakpoint
CREATE INDEX `idx_reimb_ledger` ON `reimbursements` (ledger_id, received_date);--> statement-breakpoint
CREATE TABLE `backdated_adjustments` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `tx_id` text NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  `effective_period` text NOT NULL,
  `recorded_on` text NOT NULL,
  `days_late` integer NOT NULL,
  `source` text NOT NULL,
  `recon_record_id` text REFERENCES reconciliation_records(id) ON DELETE SET NULL,
  `note` text,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_backdated` ON `backdated_adjustments` (ledger_id, recorded_on);--> statement-breakpoint
CREATE TABLE `period_reopen_logs` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `year` integer NOT NULL,
  `month` integer NOT NULL,
  `reason` text NOT NULL,
  `actor_id` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_reopen_ledger` ON `period_reopen_logs` (ledger_id, created_at);

-- ==========================================================================
-- 0011：统计与协同的数据模型扩展
--   S-09 净资产快照 / S-11 事件标注 / S-12 自定义报表 / S-13 导出留痕
--   S-17 现金流三分类 / X-05 口径版本化 / X-06 报销冲减 / X-02 跨期修订留痕
-- ==========================================================================
