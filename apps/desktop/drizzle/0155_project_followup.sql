CREATE TABLE `bot_task_followup_requests` (
	`task_id` text NOT NULL,
	`requester_bot_id` text NOT NULL,
	`key_digest` text NOT NULL,
	`body_digest` text NOT NULL,
	`input_id` text NOT NULL,
	`admitted_run_sequence` integer NOT NULL,
	`child_session_id` text NOT NULL,
	`phase` text NOT NULL,
	`native_accepted_at` integer,
	`result_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `requester_bot_id`, `key_digest`),
	FOREIGN KEY (`task_id`) REFERENCES `bot_delegations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bot_task_followup_requests_run" CHECK("bot_task_followup_requests"."admitted_run_sequence" >= 1),
	CONSTRAINT "bot_task_followup_requests_phase" CHECK("bot_task_followup_requests"."phase" IN ('admitted', 'dispatching', 'unknown', 'settled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_task_followup_requests_input_id_unique` ON `bot_task_followup_requests` (`input_id`);