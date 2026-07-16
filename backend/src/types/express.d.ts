import { SessionUser } from "../middleware/session";
import { RequestOrg } from "../middleware/auth";

// Augments Express's Request type so every route can use req.user/req.org
// directly instead of an unsafe (req as any) cast. Both stay optional here —
// they're only populated after requireAuth/requireApiKey runs; call sites
// past that point use a non-null assertion (req.user!) since the middleware
// guarantees it, same as the (req as any) casts did implicitly before.
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      org?: RequestOrg;
    }
  }
}

export {};
