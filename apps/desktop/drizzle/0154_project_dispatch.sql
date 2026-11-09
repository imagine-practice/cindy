CREATE TABLE `material_dispatch_attempts` (
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`revision` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`turn_generation` integer NOT NULL,
	`consumer` text NOT NULL,
	`preparation_key` text NOT NULL,
	`reference_ids_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`outcome` text NOT NULL,
	`evidence_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `client_id`, `revision`, `attempt_id`, `consumer`),
	FOREIGN KEY (`session_id`,`client_id`,`revision`) REFERENCES `material_dispatch_revisions`(`session_id`,`client_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "material_dispatch_attempts_turn" CHECK(typeof("material_dispatch_attempts"."turn_generation")='integer' AND "material_dispatch_attempts"."turn_generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "material_dispatch_attempts_actor" CHECK("material_dispatch_attempts"."actor_kind" IN ('account','bot')),
	CONSTRAINT "material_dispatch_attempts_consumer" CHECK("material_dispatch_attempts"."consumer" IN ('vision','provider')),
	CONSTRAINT "material_dispatch_attempts_outcome" CHECK("material_dispatch_attempts"."outcome" IN ('pending','confirmed','not-consumed','unknown'))
);
--> statement-breakpoint
CREATE INDEX `material_dispatch_attempts_recovery` ON `material_dispatch_attempts` (`session_id`,`client_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `material_dispatch_messages` (
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`current_revision` integer NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `client_id`),
	CONSTRAINT "material_dispatch_messages_revision" CHECK(typeof("material_dispatch_messages"."current_revision")='integer' AND "material_dispatch_messages"."current_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `material_dispatch_observations` (
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`revision` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`consumer` text NOT NULL,
	`receipt_sha256` text NOT NULL,
	`evidence_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `client_id`, `revision`, `attempt_id`, `consumer`, `receipt_sha256`),
	FOREIGN KEY (`session_id`,`client_id`,`revision`,`attempt_id`,`consumer`) REFERENCES `material_dispatch_attempts`(`session_id`,`client_id`,`revision`,`attempt_id`,`consumer`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `material_dispatch_revisions` (
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`revision` integer NOT NULL,
	`project_id` text NOT NULL,
	`selector_json` text NOT NULL,
	`content_sha256` text NOT NULL,
	`state` text NOT NULL,
	`preparation_json` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `client_id`, `revision`),
	FOREIGN KEY (`session_id`,`client_id`) REFERENCES `material_dispatch_messages`(`session_id`,`client_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "material_dispatch_revisions_revision" CHECK(typeof("material_dispatch_revisions"."revision")='integer' AND "material_dispatch_revisions"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "material_dispatch_revisions_state" CHECK("material_dispatch_revisions"."state" IN ('queued','attached','superseded','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `material_dispatch_revisions_project` ON `material_dispatch_revisions` (`project_id`,`session_id`,`client_id`);