CREATE TABLE `device_grant_organizations` (
	`device_code_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	CONSTRAINT `fk_device_grant_organizations_device_code_id_device_code_id_fk` FOREIGN KEY (`device_code_id`) REFERENCES `device_code`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_device_grant_organizations_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`)
);
