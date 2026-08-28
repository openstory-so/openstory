ALTER TABLE `account` ADD `issuer` text;--> statement-breakpoint
DROP INDEX IF EXISTS `device_code_device_code_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `device_code_user_code_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_uidx` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_deviceCode_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_userCode_uidx` ON `device_code` (`user_code`);