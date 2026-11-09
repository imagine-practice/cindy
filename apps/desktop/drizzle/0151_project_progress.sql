CREATE TABLE `work_item_progress` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`status` text,
	`revision` integer NOT NULL,
	`reason` text,
	`unblock_condition` text,
	`completion_event_id` integer,
	`updated_by_kind` text NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`completion_event_id`) REFERENCES `work_item_progress_events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `work_item_progress_events` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`intent_json` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text,
	`unblock_condition` text,
	`resolution` text,
	`completion_note` text,
	`created_at` integer NOT NULL,
	`revision` integer NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_progress_events_request` ON `work_item_progress_events` (`project_id`,`session_id`,`binding_revision`,`actor_kind`,`actor_id`,`request_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `project_binding_revision` integer DEFAULT 0 NOT NULL;