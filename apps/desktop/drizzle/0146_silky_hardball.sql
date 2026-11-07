CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_members_project_subject_kind` ON `project_members` (`project_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_members_owner` ON `project_members` (`project_id`) WHERE "project_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX `idx_project_members_subject` ON `project_members` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`owner_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_status_updated` ON `projects` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `assignee_kind` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `assignee_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id` ON `sessions` (`project_id`);