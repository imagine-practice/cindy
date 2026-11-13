CREATE TABLE `account_usage_snapshots` (
	`agent_kind` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_input_queue_snapshots` (
	`session_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auto_review_projections` (
	`session_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`projected_revision` integer DEFAULT -1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`payload` text,
	PRIMARY KEY(`session_id`, `lead_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auto_review_projections_lead_idx` ON `auto_review_projections` (`lead_id`);--> statement-breakpoint
CREATE TABLE `bot_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`requesting_bot_id` text NOT NULL,
	`target_bot_id` text,
	`parent_session_id` text,
	`child_session_id` text,
	`objective` text NOT NULL,
	`context_refs_json` text DEFAULT '[]' NOT NULL,
	`artifact_refs_json` text DEFAULT '[]' NOT NULL,
	`permission_snapshot_json` text DEFAULT '{}' NOT NULL,
	`group_task_posts_json` text DEFAULT '{}' NOT NULL,
	`lineage_json` text DEFAULT '[]' NOT NULL,
	`target_profile_version` integer,
	`depth` integer DEFAULT 1 NOT NULL,
	`budget_tokens` integer,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result_summary` text,
	`output_artifacts_json` text DEFAULT '[]' NOT NULL,
	`pending_interaction_json` text,
	`last_error` text,
	`run_sequence` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`completed_at` integer,
	`completion_delivered_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`requesting_bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_requester_status` ON `bot_delegations` (`requesting_bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_target_status` ON `bot_delegations` (`target_bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_parent_session` ON `bot_delegations` (`parent_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_delegations_child_session` ON `bot_delegations` (`child_session_id`);--> statement-breakpoint
CREATE TABLE `bot_direct_message_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_a_id` text NOT NULL,
	`bot_b_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`close_reason` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`max_messages` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`blocked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_dm_threads_active_pair` ON `bot_direct_message_threads` (`bot_a_id`,`bot_b_id`) WHERE "bot_direct_message_threads"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_bot_dm_threads_pair_updated` ON `bot_direct_message_threads` (`bot_a_id`,`bot_b_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `bot_direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`sender_bot_id` text NOT NULL,
	`recipient_bot_id` text NOT NULL,
	`sender_session_id` text,
	`recipient_session_id` text,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`sender_name` text,
	`recipient_name` text,
	`bridge_session_id` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `bot_direct_message_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_direct_messages_thread_sequence` ON `bot_direct_messages` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_bot_direct_messages_thread_created` ON `bot_direct_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_group_members` (
	`group_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`position` integer NOT NULL,
	`last_seen_sequence` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `bot_id`),
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_group_members_bot` ON `bot_group_members` (`bot_id`);--> statement-breakpoint
CREATE TABLE `bot_group_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`author_kind` text NOT NULL,
	`author_bot_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`mentions_json` text DEFAULT '{"all":false,"botIds":[]}' NOT NULL,
	`notice_code` text,
	`client_id` text,
	`plan_id` text,
	`files_json` text DEFAULT '[]' NOT NULL,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_messages_group_sequence` ON `bot_group_messages` (`group_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_messages_group_client` ON `bot_group_messages` (`group_id`,`client_id`) WHERE "bot_group_messages"."client_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `bot_group_plan_steps` (
	`plan_id` text NOT NULL,
	`position` integer NOT NULL,
	`bot_id` text NOT NULL,
	`bot_name` text NOT NULL,
	`task` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_message_id` text,
	`started_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`plan_id`, `position`),
	FOREIGN KEY (`plan_id`) REFERENCES `bot_group_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bot_group_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`status` text NOT NULL,
	`request_text` text NOT NULL,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`organizer_bot_id` text NOT NULL,
	`organizer_name` text NOT NULL,
	`current_step` integer,
	`work_dir` text,
	`branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_group_plans_group_created` ON `bot_group_plans` (`group_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`reply_mode` text DEFAULT 'all' NOT NULL,
	`speaking_mode` text DEFAULT 'auto' NOT NULL,
	`organizer_bot_id` text,
	`project_dir` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bot_groups_updated` ON `bot_groups` (`updated_at`);--> statement-breakpoint
CREATE TABLE `bot_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_lifecycle_events_bot_created` ON `bot_lifecycle_events` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_lifecycle_events_session_created` ON `bot_lifecycle_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`version` integer NOT NULL,
	`identity_source` text DEFAULT '' NOT NULL,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_profile_versions_bot_version` ON `bot_profile_versions` (`bot_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_bot_profile_versions_bot_created` ON `bot_profile_versions` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`avatar` text DEFAULT '🤖' NOT NULL,
	`avatar_color` text DEFAULT 'violet' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`hidden_at` integer,
	`pinned_at` integer,
	`attention_reason` text,
	`attention_at` integer,
	`current_version` integer DEFAULT 1 NOT NULL,
	`canonical_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_status_updated` ON `bot_profiles` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_canonical_session` ON `bot_profiles` (`canonical_session_id`);--> statement-breakpoint
CREATE TABLE `bot_runtime_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`agent_kind` text NOT NULL,
	`working_dir` text NOT NULL,
	`memory_scope_key` text,
	`configured_json` text DEFAULT '{}' NOT NULL,
	`resolved_json` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`prepared_at` integer DEFAULT 0 NOT NULL,
	`applied_at` integer,
	`failed_at` integer,
	`failure_json` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_runtime_snapshots_bot_prepared` ON `bot_runtime_snapshots` (`bot_id`,`prepared_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_runtime_snapshots_session_prepared` ON `bot_runtime_snapshots` (`session_id`,`prepared_at`);--> statement-breakpoint
CREATE TABLE `bot_session_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`profile_version` integer DEFAULT 1 NOT NULL,
	`role` text NOT NULL,
	`route_key` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_session` ON `bot_session_links` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_canonical_per_bot` ON `bot_session_links` (`bot_id`) WHERE "bot_session_links"."role" = 'canonical';--> statement-breakpoint
CREATE INDEX `idx_bot_session_links_bot_role` ON `bot_session_links` (`bot_id`,`role`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `bot_task_followup_requests_input_id_unique` ON `bot_task_followup_requests` (`input_id`);--> statement-breakpoint
CREATE TABLE `chat_cache_messages` (
	`namespace` text NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`namespace`, `room_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `chat_cache_rooms` (
	`namespace` text NOT NULL,
	`room_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`namespace`, `room_id`)
);
--> statement-breakpoint
CREATE TABLE `custom_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`url` text NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_custom_mcp_servers_sort_order` ON `custom_mcp_servers` (`sort_order`);--> statement-breakpoint
CREATE TABLE `custom_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`runtimes` text DEFAULT '{}' NOT NULL,
	`auth` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_custom_providers_sort_order` ON `custom_providers` (`sort_order`);--> statement-breakpoint
CREATE TABLE `daily_model_usage` (
	`day` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_create_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `agent_kind`, `model`, `cost_currency`)
);
--> statement-breakpoint
CREATE TABLE `daily_session_usage` (
	`day` text NOT NULL,
	`session_id` text NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `daily_spend` (
	`day` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `cost_currency`)
);
--> statement-breakpoint
CREATE TABLE `device_link_ownership` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_pid` integer NOT NULL,
	`owner_label` text,
	`heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `embedding_jobs` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`model_id` text NOT NULL,
	`vec_table` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`scheduled_at` integer NOT NULL,
	`locked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_embedding_jobs_natural` ON `embedding_jobs` (`source`,`source_id`,`chunk_index`,`model_id`);--> statement-breakpoint
CREATE INDEX `idx_embedding_jobs_status_scheduled` ON `embedding_jobs` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_embedding_jobs_source_id` ON `embedding_jobs` (`source`,`source_id`);--> statement-breakpoint
CREATE TABLE `embedding_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `ghost_cards` (
	`call_id` text PRIMARY KEY NOT NULL,
	`ghost_id` text NOT NULL,
	`session_id` text,
	`html` text NOT NULL,
	`height` integer NOT NULL,
	`v` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ghost_cards_updated_at_idx` ON `ghost_cards` (`updated_at`);--> statement-breakpoint
CREATE TABLE `github_observations` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hook_group_context_cursors` (
	`provider` text NOT NULL,
	`cursor_key` text NOT NULL,
	`cursor_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `cursor_key`)
);
--> statement-breakpoint
CREATE INDEX `hook_group_context_cursors_updated_at_idx` ON `hook_group_context_cursors` (`updated_at`);--> statement-breakpoint
CREATE TABLE `hook_group_message_stats` (
	`provider` text PRIMARY KEY NOT NULL,
	`row_count` integer NOT NULL,
	`text_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hook_group_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`message_id` text NOT NULL,
	`chat_name` text,
	`author` text NOT NULL,
	`is_bot` integer DEFAULT 0 NOT NULL,
	`text` text NOT NULL,
	`file_names` text,
	`image_refs` text,
	`sent_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hook_group_messages_msg_idx` ON `hook_group_messages` (`provider`,`chat_id`,`thread_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `hook_group_messages_window_idx` ON `hook_group_messages` (`provider`,`chat_id`,`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `im_bindings` (
	`channel` text NOT NULL,
	`bot_context_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`target_session_id` text NOT NULL,
	`attached_at` integer NOT NULL,
	`attached_via_card_message_id` text,
	PRIMARY KEY(`channel`, `bot_context_id`, `user_id`, `scope_key`),
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_im_bindings_target` ON `im_bindings` (`target_session_id`);--> statement-breakpoint
CREATE TABLE `im_notification_origins` (
	`channel` text NOT NULL,
	`bot_context_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `bot_context_id`, `user_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `material_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`binding_revision` integer,
	`work_item_id` text NOT NULL,
	`purpose` text NOT NULL,
	`refs_json` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX `material_dispatch_revisions_project` ON `material_dispatch_revisions` (`project_id`,`session_id`,`client_id`);--> statement-breakpoint
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
CREATE INDEX `idx_materials_work_item` ON `materials` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `mcp_app_view_states` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`server_id` text NOT NULL,
	`server_revision` text NOT NULL,
	`plugin_instance` text,
	`state_json` text NOT NULL,
	`byte_length` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_app_view_states_session` ON `mcp_app_view_states` (`session_id`);--> statement-breakpoint
CREATE TABLE `media_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`ext` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`is_cache` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_access_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`model_id` text NOT NULL,
	`capability` text NOT NULL,
	`guide_revision` text NOT NULL,
	`guide_json` text NOT NULL,
	`state` text NOT NULL,
	`task_id` text,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_invocations_owner_created_at_idx` ON `media_invocations` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_invocations_owner_state_idx` ON `media_invocations` (`owner`,`state`);--> statement-breakpoint
CREATE TABLE `media_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`ref_kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`origin_session_id` text,
	`origin_kind` text,
	`origin_id` text,
	`label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`hash`) REFERENCES `media_blobs`(`hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_refs_hash_idx` ON `media_refs` (`hash`);--> statement-breakpoint
CREATE INDEX `media_refs_ref_idx` ON `media_refs` (`ref_kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_use_id` text,
	`agent_meta` text,
	`agent_kind` text,
	`created_at` integer NOT NULL,
	`rewind_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_messages_session_client` ON `messages` (`session_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_session_created` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_rewind_at` ON `messages` (`rewind_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_active_error_tail` ON `messages` (`session_id`,`created_at`) WHERE "messages"."role" = 'error' AND "messages"."rewind_at" IS NULL;--> statement-breakpoint
CREATE TABLE `messages_fts_rows` (
	`fts_rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_fts_rows_message_id_idx` ON `messages_fts_rows` (`message_id`);--> statement-breakpoint
CREATE TABLE `migration_history` (
	`seq` integer PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`content_hash` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `migration_history_v2` (
	`namespace` text NOT NULL,
	`id` integer NOT NULL,
	`identity` text NOT NULL,
	`applied_at` integer NOT NULL,
	`provenance` text NOT NULL,
	PRIMARY KEY(`namespace`, `id`)
);
--> statement-breakpoint
CREATE TABLE `migration_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `migration_state_v2` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orca_remote_opens` (
	`remote_session_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orca_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lead_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_active_team_per_lead` ON `orca_teams` (`lead_session_id`) WHERE "orca_teams"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_orca_teams_status` ON `orca_teams` (`status`);--> statement-breakpoint
CREATE TABLE `orca_worker_creation_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `orca_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orca_worker_creation_reservations_team_label` ON `orca_worker_creation_reservations` (`team_id`,lower("label"));--> statement-breakpoint
CREATE INDEX `idx_orca_worker_creation_reservations_expires_at` ON `orca_worker_creation_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `orca_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`label` text,
	`worktree_branch` text,
	`role` text DEFAULT 'developer' NOT NULL,
	`focused` integer DEFAULT false NOT NULL,
	`idle_since` integer,
	`execution_device_id` text,
	`remote_session_id` text,
	`last_bridged_message_id` text,
	`remote_released_at` integer,
	`pending_remote_report` text,
	`remote_stop_confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `orca_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orca_workers_session_id` ON `orca_workers` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orca_workers_team_label` ON `orca_workers` (`team_id`,lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orca_workers_focused_per_team` ON `orca_workers` (`team_id`) WHERE "orca_workers"."focused" = true;--> statement-breakpoint
CREATE INDEX `idx_orca_workers_team_id` ON `orca_workers` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_orca_workers_status` ON `orca_workers` (`status`);--> statement-breakpoint
CREATE TABLE `pi_usage_receipts` (
	`session_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`priced` integer DEFAULT false NOT NULL,
	`pricing_payload` text,
	PRIMARY KEY(`session_id`, `settlement_id`, `receipt_id`)
);
--> statement-breakpoint
CREATE INDEX `pi_usage_receipts_pending_idx` ON `pi_usage_receipts` (`priced`);--> statement-breakpoint
CREATE TABLE `plugin_task_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`operation` text NOT NULL,
	`target_id` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_task_request_key` ON `plugin_task_requests` (`plugin_id`,`operation`,`target_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `plugin_task_target` ON `plugin_task_requests` (`target_id`,`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_usage_events` (
	`call_id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`history_generation` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`tool_name` text NOT NULL,
	`entry_kind` text DEFAULT 'tool' NOT NULL,
	`session_id` text,
	`version` text,
	`release_id` text,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`report_target` text,
	`report_state` text DEFAULT 'not-applicable' NOT NULL,
	`next_attempt_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `plugin_usage_subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plugin_usage_events_time_idx` ON `plugin_usage_events` (`subject_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `plugin_usage_events_task_idx` ON `plugin_usage_events` (`subject_id`,`session_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `plugin_usage_events_pending_idx` ON `plugin_usage_events` (`next_attempt_at`,`occurred_at`) WHERE "plugin_usage_events"."report_state" = 'pending';--> statement-breakpoint
CREATE TABLE `plugin_usage_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_key` text,
	`source_kind` text NOT NULL,
	`plugin_id` text,
	`organization_id` text,
	`source_key` text,
	`server_root` text,
	`ghost_id` text NOT NULL,
	`display_name` text NOT NULL,
	`binding_revision` text,
	`recording_started_at` integer NOT NULL,
	`history_generation` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_usage_subjects_source_idx` ON `plugin_usage_subjects` (`stable_key`);--> statement-breakpoint
CREATE INDEX `plugin_usage_subjects_binding_idx` ON `plugin_usage_subjects` (`ghost_id`,`binding_revision`);--> statement-breakpoint
CREATE TABLE `project_aliases` (
	`project_key` text PRIMARY KEY NOT NULL,
	`alias` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_aliases_updated_at` ON `project_aliases` (`updated_at`);--> statement-breakpoint
CREATE TABLE `project_automation_consents` (
	`working_dir` text PRIMARY KEY NOT NULL,
	`consented_at` integer NOT NULL,
	`config_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_dirs` (
	`project_id` text NOT NULL,
	`dir_key` text NOT NULL,
	`dir_path` text NOT NULL,
	`remote_host_id` text,
	`agent_device_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `dir_key`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_project_dirs_dir_key` ON `project_dirs` (`dir_key`);--> statement-breakpoint
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
CREATE INDEX `project_group_links_project` ON `project_group_links` (`project_id`,`status`);--> statement-breakpoint
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
	`admission_kind` text,
	`consent_working_dir` text,
	`consent_config_hash` text,
	`execution_body` text,
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
CREATE UNIQUE INDEX `project_work_item_executions_request` ON `project_work_item_executions` (`session_id`,`executor_bot_id`,`key_digest`);--> statement-breakpoint
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
CREATE TABLE `recent_workdirs` (
	`path` text PRIMARY KEY NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recent_workdirs_last_used_at` ON `recent_workdirs` (`last_used_at`);--> statement-breakpoint
CREATE TABLE `right_sidebar_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `right_sidebar_tabs_session_idx` ON `right_sidebar_tabs` (`session_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_subagents_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'subagents';--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_bot_artifacts_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'bot-artifacts';--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`session_id` text,
	`fired_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`error_msg` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`estimated_value_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`estimated_value_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`cost_attribution` text DEFAULT 'legacy' NOT NULL,
	`result_text` text,
	`pre_run_hook_result` text,
	`trigger_source` text,
	`read_at` integer,
	`heartbeat_at` integer,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_schedule` ON `schedule_runs` (`schedule_id`,`fired_at`);--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_running_schedule` ON `schedule_runs` (`schedule_id`) WHERE "schedule_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_running_heartbeat` ON `schedule_runs` (`heartbeat_at`) WHERE "schedule_runs"."status" = 'running' AND "schedule_runs"."heartbeat_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_running_legacy` ON `schedule_runs` (`fired_at`) WHERE "schedule_runs"."status" = 'running' AND "schedule_runs"."heartbeat_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_unread_terminal` ON `schedule_runs` (`schedule_id`,`status`,`fired_at`) WHERE "schedule_runs"."read_at" IS NULL AND "schedule_runs"."status" IN ('success', 'failed', 'aborted', 'interrupted');--> statement-breakpoint
CREATE INDEX `idx_schedule_runs_session_latest` ON `schedule_runs` (`session_id`,`fired_at`,`id`) WHERE "schedule_runs"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `schedule_session_latest_runs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`fired_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `schedule_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_schedule_session_latest_runs_run` ON `schedule_session_latest_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`job_type` text DEFAULT 'prompt' NOT NULL,
	`job_config` text,
	`execution_mode` text DEFAULT 'agent' NOT NULL,
	`script_config` text,
	`webhook_trigger` text,
	`source` text DEFAULT 'user',
	`project_config_id` text,
	`project_id` text,
	`legacy_session_fallback` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'cron' NOT NULL,
	`cron_expr` text NOT NULL,
	`timezone` text NOT NULL,
	`recurring` integer DEFAULT true NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`interval_ms` integer,
	`agent_kind` text NOT NULL,
	`model_agent_kind` text,
	`model_agent_device_id` text,
	`model` text,
	`provider_id` text,
	`agent_device_id` text,
	`effort` text,
	`fast_mode` integer DEFAULT false NOT NULL,
	`working_dir` text,
	`workspace_kind` text DEFAULT 'project' NOT NULL,
	`use_worktree` integer DEFAULT false NOT NULL,
	`target_session_id` text,
	`persistent_session` integer DEFAULT false NOT NULL,
	`silent_when_idle` integer DEFAULT false NOT NULL,
	`pre_run_hook_command` text,
	`pre_run_hook_timeout_ms` integer,
	`pre_run_plugin_id` text,
	`pre_run_plugin_on_failure` text,
	`skip_log_session_id` text,
	`notify_desktop` integer DEFAULT true NOT NULL,
	`notify_feishu` integer DEFAULT false NOT NULL,
	`notify_wecom_group` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_fired_at` integer,
	`last_finished_at` integer,
	`next_fire_at` integer,
	`expire_at` integer,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`skip_log_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_schedules_active_next` ON `schedules` (`status`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `idx_schedules_target_session` ON `schedules` (`target_session_id`);--> statement-breakpoint
CREATE TABLE `session_goals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`budget_tokens` integer,
	`max_turns` integer,
	`no_progress_limit` integer,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`no_progress_streak` integer DEFAULT 0 NOT NULL,
	`usage_reset_at` integer,
	`last_reason` text,
	`agent_kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_goals_status` ON `session_goals` (`status`);--> statement-breakpoint
CREATE TABLE `session_imports` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_fingerprint` text,
	`source_version` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`issue` text,
	`original_cwd` text,
	`request_id` text,
	`imported_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_session_imports_source` ON `session_imports` (`source`,`source_session_id`);--> statement-breakpoint
CREATE TABLE `session_pr_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`host` text DEFAULT 'github.com' NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`manually_added` integer DEFAULT false NOT NULL,
	`association_source` text DEFAULT 'legacy' NOT NULL,
	`association_origin` text,
	`removed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_session_pr_refs` ON `session_pr_refs` (`session_id`,`provider`,`host`,`owner`,`repo`,`pr_number`);--> statement-breakpoint
CREATE INDEX `idx_session_pr_refs_session_last_seen` ON `session_pr_refs` (`session_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `session_task_tags` (
	`session_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `tag_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `task_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_task_tags_tag_idx` ON `session_task_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New Maker' NOT NULL,
	`task_objective` text,
	`working_dir` text,
	`project_dir` text,
	`project_id` text,
	`project_binding_revision` integer DEFAULT 0 NOT NULL,
	`assignee_kind` text,
	`assignee_id` text,
	`workspace_kind` text DEFAULT 'project' NOT NULL,
	`model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`scheduled_model_baseline` text,
	`effort` text DEFAULT 'high' NOT NULL,
	`permission_mode` text DEFAULT 'ask' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sdk_session_id` text,
	`total_token_usage` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`total_cost_amount` real DEFAULT 0 NOT NULL,
	`total_cost_currency` text,
	`total_cost_is_approximate` integer DEFAULT false NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`context_window` integer DEFAULT 0 NOT NULL,
	`context_window_runtime` integer,
	`fast_mode` integer DEFAULT false NOT NULL,
	`plan_mode_enabled` integer DEFAULT false NOT NULL,
	`cleared_at` integer,
	`pinned_at` integer,
	`hidden_at` integer,
	`notifications_muted` integer DEFAULT false NOT NULL,
	`summary` text,
	`provider_id` text,
	`user_send_at` integer,
	`last_activity_at` integer,
	`agent_kind` text DEFAULT 'cc' NOT NULL,
	`orca_role` text,
	`parent_session_id` text,
	`forked_at_message_id` text,
	`worktree_path` text,
	`source` text DEFAULT 'desktop' NOT NULL,
	`feishu_open_id` text,
	`feishu_bot_app_id` text,
	`im_bot_context_id` text,
	`im_user_id` text,
	`im_default_route` text,
	`used_project_context` integer DEFAULT false NOT NULL,
	`codex_history_has_product_prompt` integer,
	`codex_plan_json` text,
	`extra_dirs` text DEFAULT '[]' NOT NULL,
	`writable_dirs` text DEFAULT '[]' NOT NULL,
	`remote_host_id` text,
	`agent_device_id` text,
	`orca_remote_lead` text,
	`active_turn_started_at` integer,
	`active_turn_pid` integer,
	`last_turn_ended_at` integer,
	`list_preview` text,
	`list_preview_role` text,
	`list_message_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_send_at` ON `sessions` (`user_send_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_sdk_session_id` ON `sessions` (`sdk_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_workdir_created` ON `sessions` (`working_dir`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_created_at` ON `sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_kind` ON `sessions` (`workspace_kind`);--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_orca_role` ON `sessions` (`orca_role`);--> statement-breakpoint
CREATE INDEX `idx_sessions_worktree_path` ON `sessions` (`worktree_path`);--> statement-breakpoint
CREATE INDEX `idx_sessions_feishu_lookup` ON `sessions` (`source`,`feishu_bot_app_id`,`feishu_open_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_im_lookup` ON `sessions` (`source`,`im_bot_context_id`,`im_user_id`);--> statement-breakpoint
CREATE TABLE `shared_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shared_task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`terminal` integer NOT NULL,
	`snapshot` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_task_events_revision_idx` ON `shared_task_events` (`shared_task_id`,`kind`,`revision`);--> statement-breakpoint
CREATE INDEX `shared_task_events_session_idx` ON `shared_task_events` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `skill_usage_exposures` (
	`id` text PRIMARY KEY NOT NULL,
	`analyzer_version` text DEFAULT '6' NOT NULL,
	`raw_file_path` text NOT NULL,
	`raw_line_no` integer NOT NULL,
	`session_id` text NOT NULL,
	`sdk_session_id` text NOT NULL,
	`agent_kind` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text,
	`skill_document_hash` text,
	`exposure_content_hash` text NOT NULL,
	`document_hash_source` text NOT NULL,
	`source` text NOT NULL,
	`tool_use_id` text,
	`seen_at` integer NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`repeated_tool_call_count` integer DEFAULT 0 NOT NULL,
	`tool_error_count` integer DEFAULT 0 NOT NULL,
	`command_call_count` integer DEFAULT 0 NOT NULL,
	`command_failure_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`raw_file_path`) REFERENCES `skill_usage_sources`(`raw_file_path`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_skill_document_version` ON `skill_usage_exposures` (`analyzer_version`,`skill_name`,`skill_document_hash`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_skill_recent` ON `skill_usage_exposures` (`skill_name`,`analyzer_version`,`seen_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_skill_recent_any_version` ON `skill_usage_exposures` (`skill_name`,`seen_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_analyzer_recent_source` ON `skill_usage_exposures` (`analyzer_version`,`seen_at`,`raw_file_path`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_session` ON `skill_usage_exposures` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_raw_file` ON `skill_usage_exposures` (`raw_file_path`);--> statement-breakpoint
CREATE TABLE `skill_usage_sources` (
	`raw_file_path` text PRIMARY KEY NOT NULL,
	`analyzer_version` text DEFAULT '6' NOT NULL,
	`agent_kind` text NOT NULL,
	`session_id` text NOT NULL,
	`sdk_session_id` text NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`last_scanned_at` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_skill_usage_sources_session` ON `skill_usage_sources` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_sources_sdk_session` ON `skill_usage_sources` (`sdk_session_id`);--> statement-breakpoint
CREATE TABLE `subagent_run_aliases` (
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`alias` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `alias`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `subagent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subagent_run_aliases_lookup_idx` ON `subagent_run_aliases` (`session_id`,`provider`,`alias`,`created_at`);--> statement-breakpoint
CREATE TABLE `subagent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`logical_agent_id` text NOT NULL,
	`parent_tool_use_id` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`provider_run_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`title` text,
	`description` text,
	`summary` text,
	`returned_result` text,
	`returned_result_empty` integer,
	`returned_result_truncated` integer,
	`model` text,
	`reasoning_effort` text,
	`total_tokens` integer,
	`tool_uses` integer,
	`duration_ms` integer,
	`cost_usd` real,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`activity` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	`rewind_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subagent_runs_logical_idx` ON `subagent_runs` (`session_id`,`provider`,`logical_agent_id`);--> statement-breakpoint
CREATE INDEX `subagent_runs_session_idx` ON `subagent_runs` (`session_id`,`rewind_at`,`deleted_at`,`started_at`);--> statement-breakpoint
CREATE INDEX `subagent_runs_parent_tool_use_idx` ON `subagent_runs` (`session_id`,`parent_tool_use_id`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_customized` integer DEFAULT false NOT NULL,
	`color` text NOT NULL,
	`favorite_order` integer,
	`sort_order` integer,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_tags_name_idx` ON `task_tags` (`name`);--> statement-breakpoint
CREATE TABLE `vec_table_meta` (
	`vec_table` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`model_id` text NOT NULL,
	`dim` integer NOT NULL,
	`registered_at` integer NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `wechat_file_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`abs_path` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`promoted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `wechat_inbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_wechat_file_attachments_task` ON `wechat_file_attachments` (`binding_epoch`,`task_id`);--> statement-breakpoint
CREATE TABLE `wechat_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`platform_seq` integer NOT NULL,
	`peer_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`platform_created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_until` integer,
	`session_id` text,
	`conversation_epoch` integer DEFAULT 0 NOT NULL,
	`payload_json` text NOT NULL,
	`context_nonce` text NOT NULL,
	`context_ciphertext` text NOT NULL,
	`context_tag` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wechat_inbox_platform_message` ON `wechat_inbox` (`binding_epoch`,`platform_message_id`);--> statement-breakpoint
CREATE INDEX `idx_wechat_inbox_queue` ON `wechat_inbox` (`binding_epoch`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_wechat_inbox_lease` ON `wechat_inbox` (`binding_epoch`,`lease_until`);--> statement-breakpoint
CREATE INDEX `idx_wechat_inbox_conversation` ON `wechat_inbox` (`binding_epoch`,`peer_id`,`conversation_epoch`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wechat_inbox_running_session` ON `wechat_inbox` (`binding_epoch`,`session_id`) WHERE "wechat_inbox"."session_id" IS NOT NULL AND "wechat_inbox"."status" IN ('dispatching', 'accepted_running', 'waiting_desktop', 'delivery_pending');--> statement-breakpoint
CREATE TABLE `wechat_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`task_id` text NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`media_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `wechat_inbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wechat_outbox_client_id` ON `wechat_outbox` (`binding_epoch`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_wechat_outbox_delivery` ON `wechat_outbox` (`binding_epoch`,`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `idx_wechat_outbox_task` ON `wechat_outbox` (`binding_epoch`,`task_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `wechat_sync_state` (
	`binding_epoch` text PRIMARY KEY NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`sync_cursor` text DEFAULT '' NOT NULL,
	`last_poll_at` integer,
	`last_error_code` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_wechat_sync_active` ON `wechat_sync_state` (`is_active`) WHERE "wechat_sync_state"."is_active" = 1;--> statement-breakpoint
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
CREATE UNIQUE INDEX `uniq_work_item_progress_events_request` ON `work_item_progress_events` (`project_id`,`session_id`,`binding_revision`,`actor_kind`,`actor_id`,`request_id`);