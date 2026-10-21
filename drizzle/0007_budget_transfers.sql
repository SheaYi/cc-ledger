CREATE TABLE `budget_transfers` (
  `id` text PRIMARY KEY NOT NULL,
  `ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE cascade,
  `year` integer NOT NULL,
  `month` integer NOT NULL,
  `from_category_id` text NOT NULL REFERENCES categories(id),
  `to_category_id` text NOT NULL REFERENCES categories(id),
  `amount` integer NOT NULL,
  `note` text,
  `created_by` text NOT NULL REFERENCES users(id),
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bt_period` ON `budget_transfers` (`ledger_id`,`year`,`month`);--> statement-breakpoint
CREATE INDEX `idx_bt_from` ON `budget_transfers` (`ledger_id`,`from_category_id`);--> statement-breakpoint
CREATE INDEX `idx_bt_to` ON `budget_transfers` (`ledger_id`,`to_category_id`);