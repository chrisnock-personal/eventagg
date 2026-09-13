-- 024_users_audit_log_rls.sql
-- Reversibility: schema-only -dropping these policies and disabling RLS
-- fully reverses this; no data changes involved.
--
-- Extends the Row-Level Security backstop (023, on `policies`) to `users`
-- and `audit_log`. Unlike `policies`, org_id IS NULL on these tables means
-- "superadmin" (a user with no org) or "a superadmin's own action"
-- (login/logout logged with no org) -NOT "visible to everyone". So unlike
-- policies_tenant_isolation, there is no `OR org_id IS NULL` branch here:
-- only app.bypass_rls (superadmin / system contexts) can see those rows.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );
