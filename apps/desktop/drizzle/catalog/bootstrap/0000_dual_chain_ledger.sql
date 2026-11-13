CREATE TABLE `migration_history_v2` (
	`namespace` text NOT NULL,
	`id` integer NOT NULL,
	`identity` text NOT NULL,
	`applied_at` integer NOT NULL,
	`provenance` text NOT NULL,
	PRIMARY KEY(`namespace`, `id`)
);
--> statement-breakpoint
CREATE TABLE `migration_state_v2` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
