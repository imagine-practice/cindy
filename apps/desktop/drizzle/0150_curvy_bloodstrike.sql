CREATE TABLE `project_group_link_requests` (
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`canonical_intent` text NOT NULL,
	`relation_id` text NOT NULL,
	`commit_revision` integer NOT NULL,
	`status_at_commit` text NOT NULL,
	`change` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`actor_kind`, `actor_id`, `request_id`),
	FOREIGN KEY (`relation_id`) REFERENCES `project_group_links`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_group_link_requests_actor" CHECK("project_group_link_requests"."actor_kind" IN ('account','bot')),
	CONSTRAINT "project_group_link_requests_revision" CHECK(typeof("project_group_link_requests"."commit_revision")='integer' AND "project_group_link_requests"."commit_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "project_group_link_requests_status" CHECK("project_group_link_requests"."status_at_commit" IN ('active','removed')),
	CONSTRAINT "project_group_link_requests_change" CHECK("project_group_link_requests"."change" IN ('linked','unlinked','unchanged'))
);
--> statement-breakpoint
CREATE INDEX `project_group_link_requests_relation` ON `project_group_link_requests` (`relation_id`,`commit_revision`);--> statement-breakpoint
CREATE TABLE `project_group_links` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_account_id` text NOT NULL,
	`resource_device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`group_endpoint` text NOT NULL,
	`group_room_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_by_kind` text NOT NULL,
	`updated_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_group_links_status" CHECK("project_group_links"."status" IN ('active','removed')),
	CONSTRAINT "project_group_links_revision" CHECK(typeof("project_group_links"."revision")='integer' AND "project_group_links"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "project_group_links_kinds" CHECK("project_group_links"."created_by_kind" IN ('account','bot') AND "project_group_links"."updated_by_kind" IN ('account','bot'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_group_links_scope` ON `project_group_links` (`resource_account_id`,`resource_device_id`,`project_id`,`group_endpoint`,`group_room_id`);--> statement-breakpoint
CREATE INDEX `project_group_links_group` ON `project_group_links` (`resource_account_id`,`resource_device_id`,`group_endpoint`,`group_room_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `project_group_links_project` ON `project_group_links` (`project_id`,`status`);