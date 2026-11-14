ALTER TABLE `project_group_links` ADD `work_dir_key` text;--> statement-breakpoint
ALTER TABLE `project_group_links` ADD `linked_owner_kind` text;--> statement-breakpoint
ALTER TABLE `project_group_links` ADD `linked_owner_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `project_group_links_work_project` ON `project_group_links` (`resource_account_id`,`resource_device_id`,`group_endpoint`,`group_room_id`) WHERE "project_group_links"."work_dir_key" IS NOT NULL;