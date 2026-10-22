CREATE TABLE `duplicate_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_id` text NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
	`group_key` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`actor_id` text REFERENCES users(id) ON DELETE SET NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `dr_status` CHECK (`status` IN ('confirmed','ignored'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dr_group` ON `duplicate_reviews` (`ledger_id`,`group_key`);--> statement-breakpoint
CREATE INDEX `idx_dr_ledger` ON `duplicate_reviews` (`ledger_id`,`status`);

-- ==========================================================================
-- 0016：重复扣费的人工判定结果
--
-- ## 现象
-- 对账页「重复扣费」卡长期是空的：`recurring_detections` 只在统计页确认过
-- 订阅后才有行，而绝大多数用户从没做过这一步。于是这张卡永远显示
-- 「还没有确认过的订阅」—— 用户以为自己没有重复扣费，实际是**根本没检测**。
--
-- ## 为什么判定结果要单独建表
--
-- 「疑似重复」是算法算出来的**候选**，它随数据变化而重算：今天两笔像重复，
-- 用户补了备注明天就不像了。若把判定写进 `transactions`，要么为 UI 污染
-- 业务表，要么重算时把用户的判定冲掉。判定是「人对某一组候选的意见」，
-- 与候选本身生命周期不同，分开存才不会互相覆盖。
--
-- ## 为什么用 group_key 而不是「相关账目 id 集合」
--
-- 组内成员会变（新增或删除一笔都改变这个簇）。以 id 集合做键会导致
-- 「我明明忽略过了，它又冒出来」。group_key 只取**稳定的判定维度**
-- （金额分 | 商户 | 窗口起始日），成员变化不影响键，判定才留得住。
--
-- ## 为什么 status 只允许两档
--
-- 只有「确认是重复」和「忽略（不是重复）」两种结论，没有中间态。
-- 留 `candidate` 会让人分不清「算法还没判」和「人还没判」。
--
-- ## 为什么外键用 ON DELETE CASCADE / SET NULL 而不是默认
--
-- drizzle 的 `.references()` 不写 `onDelete` 就是 NO ACTION —— 那会拦住父记录
-- 删除（本项目账本删除踩过这个坑）。账本级表一律 cascade；`actor_id`
-- 指向用户，用户删号后判定仍要留着，故 set null。
-- ==========================================================================
