CREATE TABLE `blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blobs_json" CHECK(json_valid("blobs"."value"))
);
--> statement-breakpoint
CREATE INDEX `blobs_owner` ON `blobs` (`game_id`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	`snapshot_id` text NOT NULL,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "checkpoints_json" CHECK(json_valid("checkpoints"."value"))
);
--> statement-breakpoint
CREATE INDEX `checkpoints_snapshot` ON `checkpoints` (`game_id`,`snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoints_id_game_id_session_id_unique` ON `checkpoints` (`id`,`game_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`trashed_at` text,
	`value` text NOT NULL,
	CONSTRAINT "games_json" CHECK(json_valid("games"."value"))
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memories_json" CHECK(json_valid("memories"."value"))
);
--> statement-breakpoint
CREATE INDEX `memories_owner` ON `memories` (`game_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_json" CHECK(json_valid("messages"."value"))
);
--> statement-breakpoint
CREATE INDEX `messages_owner` ON `messages` (`game_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_id_sequence_unique` ON `messages` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `progress` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	`snapshot_id` text NOT NULL,
	FOREIGN KEY (`snapshot_id`,`game_id`) REFERENCES `snapshots`(`id`,`game_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "progress_json" CHECK(json_valid("progress"."value"))
);
--> statement-breakpoint
CREATE INDEX `progress_owner` ON `progress` (`game_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_json" CHECK(json_valid("sessions"."value"))
);
--> statement-breakpoint
CREATE INDEX `sessions_game` ON `sessions` (`game_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_id_game_id_unique` ON `sessions` (`id`,`game_id`);--> statement-breakpoint
CREATE TABLE `snapshot_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "snapshot_resources_json" CHECK(json_valid("snapshot_resources"."value"))
);
--> statement-breakpoint
CREATE INDEX `snapshot_resources_snapshot` ON `snapshot_resources` (`game_id`,`snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshot_resources_id_game_id_snapshot_id_unique` ON `snapshot_resources` (`id`,`game_id`,`snapshot_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text NOT NULL,
	`game_id` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`id`, `game_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "snapshots_json" CHECK(json_valid("snapshots"."value"))
);
--> statement-breakpoint
CREATE INDEX `snapshots_owner` ON `snapshots` (`game_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transactions_json" CHECK(json_valid("transactions"."value"))
);
--> statement-breakpoint
CREATE INDEX `transactions_owner` ON `transactions` (`game_id`,`session_id`);