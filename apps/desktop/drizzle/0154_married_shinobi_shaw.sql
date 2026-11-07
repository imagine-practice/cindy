CREATE TABLE `project_dirs` (
	`project_id` text NOT NULL,
	`dir_key` text NOT NULL,
	`dir_path` text NOT NULL,
	`remote_host_id` text,
	`agent_device_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `dir_key`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_dirs_dir_key` ON `project_dirs` (`dir_key`);