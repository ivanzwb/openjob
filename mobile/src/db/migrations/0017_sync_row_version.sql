CREATE TABLE `sync_row_version` (
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`updated_ms` integer NOT NULL,
	PRIMARY KEY(`table_name`, `row_id`)
);
