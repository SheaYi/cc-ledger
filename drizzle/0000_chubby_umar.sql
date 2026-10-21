CREATE TABLE `account_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ag_ledger_name` ON `account_groups` (`ledger_id`,`name`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`kind` text NOT NULL,
	`opening_balance` integer DEFAULT 0 NOT NULL,
	`opening_date` text NOT NULL,
	`credit_limit` integer,
	`billing_day` integer,
	`due_day` integer,
	`include_in_total` integer DEFAULT true NOT NULL,
	`icon` text,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`last_reconciled_at` text,
	`last_reconciled_balance` integer,
	`archived_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `account_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_acc_ledger_name` ON `accounts` (`ledger_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_acc_ledger` ON `accounts` (`ledger_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_acc_group` ON `accounts` (`group_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploader_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_att_tx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`category_id` text,
	`period_type` text DEFAULT 'monthly' NOT NULL,
	`year` integer NOT NULL,
	`month` integer,
	`amount` integer NOT NULL,
	`rollover` integer DEFAULT false NOT NULL,
	`alert_ratio` integer DEFAULT 80 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_budget_unique` ON `budgets` (`ledger_id`,`category_id`,`period_type`,`year`,`month`);--> statement-breakpoint
CREATE INDEX `idx_budget_ledger` ON `budgets` (`ledger_id`,`year`,`month`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`record_type` text NOT NULL,
	`parent_id` text,
	`level` integer NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cat_unique` ON `categories` (`ledger_id`,`record_type`,`parent_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_cat_tree` ON `categories` (`ledger_id`,`record_type`,`level`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_cat_parent` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`match_field` text NOT NULL,
	`match_op` text NOT NULL,
	`match_value` text NOT NULL,
	`record_type` text NOT NULL,
	`target_category_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rule_match` ON `category_rules` (`ledger_id`,`enabled`,`priority`);--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`title` text NOT NULL,
	`total_amount` integer NOT NULL,
	`total_fee` integer DEFAULT 0 NOT NULL,
	`installment_count` integer NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`first_date` text NOT NULL,
	`fee_mode` text DEFAULT 'once' NOT NULL,
	`per_period_fee` integer DEFAULT 0 NOT NULL,
	`fee_handling` text DEFAULT 'first_period' NOT NULL,
	`account_id` text NOT NULL,
	`debt_account_id` text NOT NULL,
	`record_type` text DEFAULT 'expense' NOT NULL,
	`category_id` text,
	`merchant` text,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_transaction_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`debt_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`start_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_plan_ledger` ON `installment_plans` (`ledger_id`,`status`);--> statement-breakpoint
CREATE TABLE `installment_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`ledger_id` text NOT NULL,
	`seq` integer NOT NULL,
	`due_date` text NOT NULL,
	`principal` integer NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`total_due` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_at` text,
	`repay_tx_id` text,
	FOREIGN KEY (`plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repay_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sched_plan_seq` ON `installment_schedules` (`plan_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_sched_plan` ON `installment_schedules` (`plan_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sched_due` ON `installment_schedules` (`ledger_id`,`due_date`,`status`);--> statement-breakpoint
CREATE TABLE `ledger_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`inviter_id` text NOT NULL,
	`code` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inv_code` ON `ledger_invitations` (`code`);--> statement-breakpoint
CREATE TABLE `ledger_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`summary` text,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_logs_ledger` ON `ledger_logs` (`ledger_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_logs_entity` ON `ledger_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `ledger_members` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`nickname_override` text,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_lm_ledger_user` ON `ledger_members` (`ledger_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_lm_user` ON `ledger_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'personal' NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`owner_id` text NOT NULL,
	`current_ledger` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ledgers_owner` ON `ledgers` (`owner_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `period_closures` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`closed_at` text NOT NULL,
	`closed_by` text NOT NULL,
	`note` text,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pc_unique` ON `period_closures` (`ledger_id`,`year`,`month`);--> statement-breakpoint
CREATE TABLE `reconciliation_records` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`account_id` text NOT NULL,
	`reconcile_date` text NOT NULL,
	`system_balance` integer NOT NULL,
	`actual_balance` integer NOT NULL,
	`diff_amount` integer NOT NULL,
	`adjustment_tx_id` text,
	`reason_code` text,
	`reason_note` text,
	`operator_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`adjustment_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`operator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_recon_account` ON `reconciliation_records` (`account_id`,`reconcile_date`);--> statement-breakpoint
CREATE TABLE `recurring_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`record_type` text DEFAULT 'expense' NOT NULL,
	`account_id` text NOT NULL,
	`to_account_id` text,
	`category_id` text,
	`merchant` text,
	`counterparty` text,
	`frequency` text NOT NULL,
	`interval_count` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`day_of_month` integer,
	`week_day` integer,
	`month` integer,
	`max_month_end` integer DEFAULT true NOT NULL,
	`amount` integer NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`discount` integer DEFAULT 0 NOT NULL,
	`title` text,
	`note` text,
	`tag_ids_json` text,
	`generate_ahead_days` integer DEFAULT 1 NOT NULL,
	`auto_create` integer DEFAULT true NOT NULL,
	`last_generated_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_recr_gen` ON `recurring_rules` (`status`,`last_generated_date`);--> statement-breakpoint
CREATE INDEX `idx_recr_ledger` ON `recurring_rules` (`ledger_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_info` text,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_rt_token_hash` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_rt_user` ON `refresh_tokens` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_rt_expire` ON `refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#8E8E93' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tag_ledger_name` ON `tags` (`ledger_id`,`name`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`payload_json` text NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledgers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tpl_ledger_name` ON `templates` (`ledger_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_tpl_rank` ON `templates` (`ledger_id`,`use_count`,`last_used_at`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tt_pk` ON `transaction_tags` (`transaction_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_tt_tag` ON `transaction_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL,
	`record_type` text NOT NULL,
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
	CONSTRAINT "ck_amount_positive" CHECK("transactions"."amount" > 0),
	CONSTRAINT "ck_fee_non_negative" CHECK("transactions"."fee" >= 0),
	CONSTRAINT "ck_discount_non_negative" CHECK("transactions"."discount" >= 0),
	CONSTRAINT "ck_merchant_len" CHECK("transactions"."merchant" IS NULL OR LENGTH(TRIM("transactions"."merchant")) <= 50),
	CONSTRAINT "ck_counterparty_len" CHECK("transactions"."counterparty" IS NULL OR LENGTH(TRIM("transactions"."counterparty")) <= 50)
);
--> statement-breakpoint
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
CREATE INDEX `idx_tx_deleted` ON `transactions` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`phone` text,
	`password_hash` text NOT NULL,
	`nickname` text NOT NULL,
	`avatar_path` text,
	`status` text DEFAULT 'active' NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_phone` ON `users` (`phone`);