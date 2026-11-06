CREATE TABLE `budget_rollovers__new` (
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
  CHECK (`mode` IN ('clear', 'carry', 'carry_negative', 'to_savings'))
);--> statement-breakpoint
INSERT INTO `budget_rollovers__new` (`id`, `ledger_id`, `from_budget_id`, `to_budget_id`, `from_period`, `to_period`, `mode`, `amount`, `remaining_at_close`, `note`, `reversed_at`, `created_by`, `created_at`)
SELECT `id`, `ledger_id`, `from_budget_id`, `to_budget_id`, `from_period`, `to_period`, `mode`, `amount`, `remaining_at_close`, `note`, `reversed_at`, `created_by`, `created_at` FROM `budget_rollovers`;--> statement-breakpoint
DROP TABLE `budget_rollovers`;--> statement-breakpoint
ALTER TABLE `budget_rollovers__new` RENAME TO `budget_rollovers`;--> statement-breakpoint
CREATE INDEX `idx_rollover_ledger` ON `budget_rollovers` (`ledger_id`, `from_period`);--> statement-breakpoint
CREATE INDEX `idx_rollover_target` ON `budget_rollovers` (`to_budget_id`);
