ALTER TABLE `accounts` ADD `reconcile_cycle` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `reconcile_anchor_day` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `reconcile_remind_days` integer;--> statement-breakpoint
CREATE TABLE `bank_statements` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `account_id` text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  `source` text NOT NULL DEFAULT 'manual',
  `statement_month` text NOT NULL,
  `filename` text,
  `row_count` integer NOT NULL DEFAULT 0,
  `matched_count` integer NOT NULL DEFAULT 0,
  `imported_count` integer NOT NULL DEFAULT 0,
  `uploaded_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_stmt_account` ON `bank_statements` (account_id, statement_month);--> statement-breakpoint
CREATE INDEX `idx_stmt_ledger` ON `bank_statements` (ledger_id);--> statement-breakpoint
CREATE TABLE `bank_statement_lines` (
  `id` text PRIMARY KEY NOT NULL,
  `statement_id` text NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `account_id` text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  `tx_date` text NOT NULL,
  `direction` text NOT NULL,
  `amount` integer NOT NULL,
  `merchant` text,
  `description` text,
  `balance_after` integer,
  `match_state` text NOT NULL DEFAULT 'unmatched',
  `matched_tx_id` text REFERENCES transactions(id) ON DELETE SET NULL,
  `match_score` integer,
  `match_reason` text,
  `excluded_reason` text,
  `row_no` integer NOT NULL,
  `raw_json` text,
  `created_at` text NOT NULL,
  CHECK (`direction` IN ('debit', 'credit')),
  CHECK (`match_state` IN ('unmatched', 'suspected', 'matched', 'ignored'))
);--> statement-breakpoint
CREATE INDEX `idx_line_statement` ON `bank_statement_lines` (statement_id);--> statement-breakpoint
CREATE INDEX `idx_line_match` ON `bank_statement_lines` (account_id, match_state);--> statement-breakpoint
CREATE INDEX `idx_line_date` ON `bank_statement_lines` (ledger_id, tx_date);--> statement-breakpoint
CREATE TABLE `recon_adjusting_items` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `account_id` text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  `side` text NOT NULL,
  `item_date` text NOT NULL,
  `amount` integer NOT NULL,
  `kind` text NOT NULL,
  `note` text,
  `related_tx_id` text REFERENCES transactions(id) ON DELETE SET NULL,
  `cleared_at` text,
  `cleared_tx_id` text REFERENCES transactions(id) ON DELETE SET NULL,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL,
  CHECK (`side` IN ('positive', 'negative'))
);--> statement-breakpoint
CREATE INDEX `idx_adj_account` ON `recon_adjusting_items` (account_id, cleared_at);--> statement-breakpoint
CREATE INDEX `idx_adj_ledger` ON `recon_adjusting_items` (ledger_id, item_date);--> statement-breakpoint
CREATE TABLE `recurring_detections` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  `account_id` text,
  `fingerprint` text NOT NULL,
  `merchant` text NOT NULL,
  `period_type` text NOT NULL,
  `amount` integer NOT NULL,
  `first_seen` text NOT NULL,
  `last_seen` text NOT NULL,
  `occurrence_count` integer NOT NULL,
  `last_tx_id` text REFERENCES transactions(id) ON DELETE SET NULL,
  `status` text NOT NULL DEFAULT 'candidate',
  `user_label` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  UNIQUE (`ledger_id`, `fingerprint`),
  CHECK (`status` IN ('candidate', 'confirmed', 'ignored'))
);--> statement-breakpoint
CREATE INDEX `idx_recurring_ledger` ON `recurring_detections` (ledger_id, status);

-- ==========================================================================
-- 0009：对账模块的数据模型扩展（R-05 排期 / R-06 流水导入 / R-07~R-08 匹配 /
--       R-09 未达账项与调节表 / R-10 信用卡账单日 / R-11 匹配率 / R-12 重复扣费）
--
-- 设计上的一条硬原则：**银行流水永不进业务表**。
-- 流水只进 bank_statement_lines 这张暂存表，只有「已确认匹配」的那一行才会
-- 通过 POST /transactions 走完整账务校验落进 transactions。
-- 理由是账务的：银行流水里有大量用户根本不打算记的条目（信用卡还款本身、
-- 账户间内部转账、ATM 取现找零），直接落业务表就等于把「系统流水」与
-- 「用户账本」混成一个东西 —— 而只有后者才能作为报表与预算的口径来源。
-- ==========================================================================
