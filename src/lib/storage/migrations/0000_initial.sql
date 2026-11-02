CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
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
	FOREIGN KEY (`snapshot_id`,`game_id`,`session_id`) REFERENCES `snapshots`(`id`,`game_id`,`session_id`) ON UPDATE no action ON DELETE no action,
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
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`session_id`,`game_id`) REFERENCES `sessions`(`id`,`game_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "snapshots_json" CHECK(json_valid("snapshots"."value"))
);
--> statement-breakpoint
CREATE INDEX `snapshots_owner` ON `snapshots` (`game_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_id_game_id_session_id_unique` ON `snapshots` (`id`,`game_id`,`session_id`);--> statement-breakpoint
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