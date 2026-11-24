-- The account-restriction concept was removed before it ever shipped: permissions are
-- role-assigned only. Production never applied the stage-4 file that created this table,
-- but development databases where it ran keep it; drop it everywhere, harmlessly.
DROP TABLE IF EXISTS permission_account_restrictions;
