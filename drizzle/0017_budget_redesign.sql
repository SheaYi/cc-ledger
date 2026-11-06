ALTER TABLE `transactions` ADD COLUMN `budget_excluded` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `budget_kind` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `budget_method` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `elastic_base` integer;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `elastic_ratio` integer;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `occupancy_mode` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD COLUMN `archived_at` text;--> statement-breakpoint
ALTER TABLE `budget_prefs` ADD COLUMN `alert_tiers` text;--> statement-breakpoint
ALTER TABLE `budget_prefs` ADD COLUMN `large_expense_cents` integer;--> statement-breakpoint
ALTER TABLE `budget_prefs` ADD COLUMN `channels_json` text;--> statement-breakpoint
ALTER TABLE `budget_prefs` ADD COLUMN `overspend_policy` text;--> statement-breakpoint
ALTER TABLE `budget_prefs` ADD COLUMN `time_progress_alert` integer;--> statement-breakpoint
CREATE TABLE `budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
	`budget_id` text REFERENCES budgets(id) ON DELETE CASCADE,
	`category_id` text REFERENCES categories(id) ON DELETE SET NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`amount` integer NOT NULL,
	`expected_on` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`note` text,
	`released_at` text,
	`created_by` text NOT NULL REFERENCES users(id),
	`created_at` text NOT NULL,
	CONSTRAINT `bres_kind` CHECK (`kind` IN ('committed','reserved')),
	CONSTRAINT `bres_status` CHECK (`status` IN ('held','released'))
);--> statement-breakpoint
CREATE INDEX `idx_bres_ledger` ON `budget_reservations` (`ledger_id`,`status`,`expected_on`);--> statement-breakpoint
CREATE INDEX `idx_bres_budget` ON `budget_reservations` (`budget_id`,`status`);--> statement-breakpoint
CREATE TABLE `budget_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
	`period_key` text NOT NULL,
	`budget_id` text,
	`scope_name` text,
	`budget_kind` text DEFAULT 'expense' NOT NULL,
	`amount` integer NOT NULL,
	`actual` integer NOT NULL,
	`variance` integer NOT NULL,
	`variance_ratio_bp` integer,
	`period_days` integer NOT NULL,
	`archived_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bsnap_unique` ON `budget_snapshots` (`ledger_id`,`period_key`,`budget_id`);--> statement-breakpoint
CREATE INDEX `idx_bsnap_ledger` ON `budget_snapshots` (`ledger_id`,`period_key`);
