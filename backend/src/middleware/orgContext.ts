import { Request, Response, NextFunction } from "express";
import { runWithOrgContext, OrgContext } from "../db/pool";

// Establishes the RLS org context for the duration of this request. Must be
// mounted after requireAuth/requireApiKey, since it reads req.user/req.org.
//
// AsyncLocalStorage's .run() propagates its context through the entire async
// chain kicked off by the synchronous next() call inside it — everything
// downstream (however deeply nested via async/await) sees this context, no
// need to bracket against res.on('finish').
export function orgContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  const org = req.org;

  const ctx: OrgContext = org
    ? { orgId: org.id, bypass: false }
    : { orgId: user?.orgId ?? null, bypass: user?.role === "superadmin" };

  runWithOrgContext(ctx, () => {
    next();
    return Promise.resolve();
  });
}
