ALTER TABLE `session` ADD `node_id` text REFERENCES `knowledge_node`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX `idx_session_node` ON `session` (`node_id`,`kind`,`created_at`);
