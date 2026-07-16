-- 022_global_policies.sql
-- Multi-tenancy phase 2: allow policies to be "global" (org_id = NULL),
-- visible to every organisation and editable only by superadmin. Promotes
-- the existing EXAMPLE/DEMO seed policies to global, since they were always
-- template/demo content rather than one org's own data.

ALTER TABLE policies ALTER COLUMN org_id DROP NOT NULL;

-- A plain UNIQUE(org_id, name) index treats every NULL org_id as distinct
-- from every other NULL, so two global policies could otherwise collide
-- silently under the same name. A dedicated partial index closes that gap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_global_name
    ON policies (name)
    WHERE org_id IS NULL AND is_active = TRUE;

UPDATE policies SET org_id = NULL
WHERE name IN (
    'EXAMPLE - User Session',
    'EXAMPLE - Trade Lifecycle',
    'EXAMPLE - Order Flow',
    'EXAMPLE - API Request/Response',
    'DEMO - Telephone Call'
);
