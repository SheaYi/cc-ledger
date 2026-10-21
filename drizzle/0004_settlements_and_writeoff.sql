CREATE TABLE `transaction_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`settle_tx_id` text NOT NULL,
	`original_tx_id` text NOT NULL,
	`amount` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`settle_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`original_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_settle_amount_positive" CHECK("transaction_settlements"."amount" > 0),
	CONSTRAINT "ck_settle_amount_max" CHECK("transaction_settlements"."amount" <= 9999999999),
	CONSTRAINT "ck_settle_not_self" CHECK("transaction_settlements"."settle_tx_id" <> "transaction_settlements"."original_tx_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_settle_pk` ON `transaction_settlements` (`settle_tx_id`,`original_tx_id`);--> statement-breakpoint
CREATE INDEX `idx_settle_original` ON `transaction_settlements` (`original_tx_id`);--> statement-breakpoint
CREATE INDEX `idx_settle_ledger` ON `transaction_settlements` (`ledger_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`record_type` text NOT NULL,
	`direction` text NOT NULL,
	`account_id` text NOT NULL,
	`to_account_id` text,
	`category_id` text,
	`parent_category_id` text,
	`amount` integer NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`discount` integer DEFAULT 0 NOT NULL,
	`actual_amount` integer NOT NULL,
	`account_delta` integer NOT NULL,
	`to_account_delta` integer,
	`name` text,
	`merchant` text,
	`counterparty` text,
	`note` text,
	`tx_date` text NOT NULL,
	`tx_time` text,
	`occurred_at` text NOT NULL,
	`template_id` text,
	`recurring_rule_id` text,
	`installment_plan_id` text,
	`installment_index` integer,
	`adjustment_reason` text,
	`import_hash` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`client_request_id` text,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurring_rule_id`) REFERENCES `recurring_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`installment_plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_amount_positive" CHECK("__new_transactions"."amount" > 0),
	CONSTRAINT "ck_amount_max" CHECK("__new_transactions"."amount" <= 9999999999),
	CONSTRAINT "ck_fee_non_negative" CHECK("__new_transactions"."fee" >= 0),
	CONSTRAINT "ck_discount_non_negative" CHECK("__new_transactions"."discount" >= 0),
	CONSTRAINT "ck_name_len" CHECK("__new_transactions"."name" IS NULL OR LENGTH(TRIM("__new_transactions"."name")) <= 50),
	CONSTRAINT "ck_merchant_len" CHECK("__new_transactions"."merchant" IS NULL OR LENGTH(TRIM("__new_transactions"."merchant")) <= 50),
	CONSTRAINT "ck_counterparty_len" CHECK("__new_transactions"."counterparty" IS NULL OR LENGTH(TRIM("__new_transactions"."counterparty")) <= 50),
	CONSTRAINT "ck_note_len" CHECK("__new_transactions"."note" IS NULL OR LENGTH("__new_transactions"."note") <= 500),
	CONSTRAINT "ck_direction_values" CHECK("__new_transactions"."direction" IN ('increase','decrease','none','write_off')),
	CONSTRAINT "ck_direction_by_type" CHECK(("__new_transactions"."record_type" = 'expense'    AND "__new_transactions"."direction" = 'decrease') OR
          ("__new_transactions"."record_type" = 'income'     AND "__new_transactions"."direction" = 'increase') OR
          ("__new_transactions"."record_type" = 'transfer'   AND "__new_transactions"."direction" = 'decrease') OR
          ("__new_transactions"."record_type" = 'adjustment' AND "__new_transactions"."direction" IN ('increase','decrease')) OR
          ("__new_transactions"."record_type" = 'receivable' AND "__new_transactions"."direction" IN ('decrease','increase','write_off')) OR
          ("__new_transactions"."record_type" = 'payable'    AND "__new_transactions"."direction" IN ('none','decrease','write_off')))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "ledger_id", "record_type", "direction", "account_id", "to_account_id", "category_id", "parent_category_id", "amount", "fee", "discount", "actual_amount", "account_delta", "to_account_delta", "name", "merchant", "counterparty", "note", "tx_date", "tx_time", "occurred_at", "template_id", "recurring_rule_id", "installment_plan_id", "installment_index", "adjustment_reason", "import_hash", "created_by", "updated_by", "created_at", "updated_at", "deleted_at", "client_request_id") SELECT "id", "ledger_id", "record_type", "direction", "account_id", "to_account_id", "category_id", "parent_category_id", "amount", "fee", "discount", "actual_amount", "account_delta", "to_account_delta", "name", "merchant", "counterparty", "note", "tx_date", "tx_time", "occurred_at", "template_id", "recurring_rule_id", "installment_plan_id", "installment_index", "adjustment_reason", "import_hash", "created_by", "updated_by", "created_at", "updated_at", "deleted_at", "client_request_id" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tx_client_req` ON `transactions` (`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_tx_ledger_date` ON `transactions` (`ledger_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_account` ON `transactions` (`ledger_id`,`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_to_account` ON `transactions` (`ledger_id`,`to_account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_category` ON `transactions` (`ledger_id`,`parent_category_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_type_date` ON `transactions` (`ledger_id`,`record_type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_merchant` ON `transactions` (`ledger_id`,`merchant`) WHERE "transactions"."merchant" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_tx_counterparty` ON `transactions` (`ledger_id`,`counterparty`) WHERE "transactions"."counterparty" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_tx_recurring` ON `transactions` (`recurring_rule_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_tx_installment` ON `transactions` (`installment_plan_id`,`installment_index`);--> statement-breakpoint
CREATE INDEX `idx_tx_import_hash` ON `transactions` (`ledger_id`,`import_hash`);--> statement-breakpoint
CREATE INDEX `idx_tx_deleted` ON `transactions` (`deleted_at`);