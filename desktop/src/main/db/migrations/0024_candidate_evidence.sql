CREATE TABLE `candidate_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`statement` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_document_id` text NOT NULL,
	`source_start` integer NOT NULL,
	`source_end` integer NOT NULL,
	`source_text` text NOT NULL,
	`occurred_at` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaign`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_candidate_evidence_span` ON `candidate_evidence` (`campaign_id`,`kind`,`source_kind`,`source_document_id`,`source_start`,`source_end`);
--> statement-breakpoint
CREATE INDEX `idx_candidate_evidence_status` ON `candidate_evidence` (`campaign_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_candidate_evidence_source` ON `candidate_evidence` (`source_kind`,`source_document_id`);
