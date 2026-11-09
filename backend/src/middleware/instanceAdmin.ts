import { Request, Response, NextFunction } from "express";
import { getMultiTenancyConfig } from "../services/tenancyService";

// Who may manage whole-instance settings (TLS certificate, SMTP, backups,
// DB maintenance): the superadmin once multi-tenancy is on, and before that
// the (only) organisation's admin, who owns the instance in practice. A plain
// requireRole("superadmin") left these unreachable on a single-tenant
// install, where nobody is a superadmin; requireRole("admin") would let every
// org admin change platform-wide settings once there are several orgs.
export async function isInstanceAdmin(role: string | undefined): Promise<boolean> {
  if (role === "superadmin") return true;
  if (role !== "admin") return false;
  return !(await getMultiTenancyConfig()).enabled;
}

export async function requireInstanceAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await isInstanceAdmin(req.user?.role)) return next();
    res.status(403).json({ error: "Forbidden -instance-wide settings need the superadmin (or the admin, before multi-tenancy is enabled)" });
  } catch (err) { next(err); }
}
