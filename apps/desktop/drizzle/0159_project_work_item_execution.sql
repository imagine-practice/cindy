CREATE TABLE `project_work_item_execution_approvals` (
	`request_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`audit_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_work_item_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`executor_bot_id` text NOT NULL,
	`caller_session_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`key_digest` text NOT NULL,
	`body_digest` text NOT NULL,
	`fingerprint` text NOT NULL,
	`input_id` text NOT NULL,
	`phase` text NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_work_item_executions_phase" CHECK("project_work_item_executions"."phase" IN ('admitted','dispatching','settled','unknown')),
	CONSTRAINT "project_work_item_executions_binding" CHECK("project_work_item_executions"."binding_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_work_item_executions_input_id_unique` ON `project_work_item_executions` (`input_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_work_item_executions_request` ON `project_work_item_executions` (`session_id`,`executor_bot_id`,`key_digest`);