-- #1976 DATA REPAIR: Better Auth 1.7.2 created a second OAuth account for
-- existing users when the old row had NULL issuer. Better Auth 1.7.6 now
-- rejects multiple rows for the same (provider_id, account_id).
-- Keep the non-NULL issuer row (it has the latest tokens). Only remove the
-- NULL row when provider, account identity AND owner all match; identities
-- claimed by different users require manual investigation, not deletion.
-- HAND-WRITTEN ON PURPOSE: no schema diff exists for this data repair;
-- generated with `bun db:generate --custom --name=dedupe_oauth_accounts`.

DELETE FROM `account` WHERE `issuer` IS NULL
  AND EXISTS (
    SELECT 1 FROM `account` AS `current`
    WHERE `current`.`issuer` IS NOT NULL
      AND `current`.`provider_id` = `account`.`provider_id`
      AND `current`.`account_id` = `account`.`account_id`
      AND `current`.`user_id` = `account`.`user_id`
  );
