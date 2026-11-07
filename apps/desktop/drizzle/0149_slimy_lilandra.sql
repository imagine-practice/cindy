CREATE TABLE `material_references` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text,
	`binding_revision` integer,
	`material_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`material_id`,`version`) REFERENCES `material_versions`(`material_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "material_references_project_epoch" CHECK("material_references"."work_item_id" IS NOT NULL OR "material_references"."binding_revision" IS NULL),
	CONSTRAINT "material_references_valid_epoch" CHECK("material_references"."binding_revision" IS NULL OR (typeof("material_references"."binding_revision") = 'integer' AND "material_references"."binding_revision" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_material_references_project` ON `material_references` (`project_id`,`material_id`) WHERE "material_references"."work_item_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_material_references_task` ON `material_references` (`project_id`,`work_item_id`,`binding_revision`,`material_id`) WHERE "material_references"."work_item_id" IS NOT NULL AND "material_references"."binding_revision" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_material_references_legacy` ON `material_references` (`project_id`,`work_item_id`,`material_id`) WHERE "material_references"."work_item_id" IS NOT NULL AND "material_references"."binding_revision" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_material_references_scope` ON `material_references` (`project_id`,`work_item_id`,`binding_revision`,`status`);--> statement-breakpoint
ALTER TABLE `material_contexts` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `material_contexts` ADD `binding_revision` integer;