DROP INDEX IF EXISTS `idx_ag_ledger_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ag_ledger_name` ON `account_groups` (`ledger_id`,`name`) WHERE "account_groups"."archived_at" IS NULL;