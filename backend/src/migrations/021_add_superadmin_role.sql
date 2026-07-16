-- 021_add_superadmin_role.sql
-- Multi-tenancy phase 1: add a platform-level 'superadmin' role that is not
-- tied to any organisation (org_id = NULL). Every other role must belong to
-- exactly one organisation.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('superadmin', 'admin', 'editor', 'viewer'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_role_check;
ALTER TABLE users ADD CONSTRAINT users_org_role_check
    CHECK (
        (role = 'superadmin' AND org_id IS NULL) OR
        (role != 'superadmin' AND org_id IS NOT NULL)
    );
