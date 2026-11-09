CREATE TABLE `material_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`purpose` text NOT NULL,
	`refs_json` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `material_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`version` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`storage_kind` text NOT NULL,
	`storage_ref` text NOT NULL,
	`source_mtime` integer,
	`read_state` text DEFAULT 'pending' NOT NULL,
	`failure_reason` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_material_versions_material_version` ON `material_versions` (`material_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_material_versions_sha256` ON `material_versions` (`sha256`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_materials_project_status` ON `materials` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_materials_work_item` ON `materials` (`work_item_id`);