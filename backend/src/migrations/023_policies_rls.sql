-- 023_policies_rls.sql
-- Row-Level Security prototype: a database-enforced backstop for tenant
-- isolation on `policies`, independent of the application-level org_id
-- scoping already in every service function. Even a query that forgets its
-- WHERE clause entirely can't return another org's rows.
--
-- FORCE (not just ENABLE) is required because eventagg_user owns this table
-- (it runs both migrations and all runtime queries -see entrypoint.sh) and
-- RLS never applies to a table's owner otherwise.
--
-- Fails closed: if the app forgets to establish an org context for a given
-- connection (see db/pool.ts's AsyncLocalStorage-based context), neither
-- app.current_org_id nor app.bypass_rls is set, current_setting(..., true)
-- returns NULL, and every branch of the USING/WITH CHECK clause is false —
-- zero rows visible, not an error and not every org's rows.

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policies_tenant_isolation ON policies;
CREATE POLICY policies_tenant_isolation ON policies
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id IS NULL
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
