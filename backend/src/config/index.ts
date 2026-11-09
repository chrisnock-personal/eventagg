import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default("3001"),
  // Loopback by default: nginx (same container, host network) proxies /api/
  // to 127.0.0.1:3001, so nothing else needs to reach the backend directly.
  // With host networking, 0.0.0.0 here would expose the API on the LAN,
  // bypassing nginx. "" (docker-compose's unset) counts as the default.
  BIND_ADDRESS: z.string().optional().transform((v) => v || "127.0.0.1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // PostgreSQL connection
  PGHOST: z.string().min(1, "PGHOST is required"),
  PGPORT: z.string().default("5432"),
  PGDATABASE: z.string().min(1, "PGDATABASE is required"),
  PGUSER: z.string().min(1, "PGUSER is required"),
  PGPASSWORD: z.string().min(1, "PGPASSWORD is required"),
  PGSSL: z.enum(["true", "false"]).default("false"),

  // Optional connection pool tuning
  PG_POOL_MAX: z.string().default("10"),
  PG_POOL_IDLE_TIMEOUT_MS: z.string().default("30000"),
  PG_POOL_CONNECTION_TIMEOUT_MS: z.string().default("5000"),

  // CORS
  // Defaults to same-origin only (no Access-Control-Allow-Origin header at
  // all) rather than "*" -this app's own nginx.conf proxies the frontend
  // and API on the same origin, so no cross-origin browser requests are
  // needed for the documented deployment. "*" combined with credentials:
  // true (see app.ts) is silently rejected by browsers anyway, so the old
  // "*" default never actually worked for a credentialed cross-origin
  // caller -it was a footgun with no upside. Set this explicitly to a
  // real origin (or "*", for a non-credentialed integration) only if a
  // separately-hosted frontend needs to call this API directly.
  CORS_ORIGIN: z.string().default(""),

  // Auth
  // JWT_SECRET is intentionally optional here (not required like PGPASSWORD)
  // -session.ts auto-generates a random one at boot if unset, rather than
  // refusing to start, matching this codebase's existing pattern for other
  // secrets (organisations.ingest_api_key auto-generates too). The
  // trade-off is documented there: sessions invalidate on every restart
  // unless this is set explicitly.
  // docker-compose.yml passes this through as "" (not unset) when the host
  // doesn't set it -normalize "" to undefined here so config.jwtSecret is
  // never a falsy-but-truthy-looking empty string downstream.
  JWT_SECRET: z.string().optional().transform((v) => v || undefined),
  // Secure (HTTPS-only) session cookie. On by default: nginx serves the app
  // over HTTPS and redirects HTTP. Only turn it off if something in front
  // serves the UI over plain HTTP (browsers drop Secure cookies there).
  // "" (docker-compose's unset) counts as the default.
  COOKIE_SECURE: z.enum(["true", "false", ""]).default("true").transform((v) => v || "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:");
  parsed.error.issues.forEach((err) => {
    console.error(`    ${err.path.join(".")}: ${err.message}`);
  });
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: parseInt(env.PORT, 10),
  bindAddress: env.BIND_ADDRESS,
  nodeEnv: env.NODE_ENV,
  corsOrigin: env.CORS_ORIGIN,

  jwtSecret: env.JWT_SECRET,
  cookieSecure: env.COOKIE_SECURE === "true",

  db: {
    host: env.PGHOST,
    port: parseInt(env.PGPORT, 10),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    max: parseInt(env.PG_POOL_MAX, 10),
    idleTimeoutMillis: parseInt(env.PG_POOL_IDLE_TIMEOUT_MS, 10),
    connectionTimeoutMillis: parseInt(env.PG_POOL_CONNECTION_TIMEOUT_MS, 10),
  },
} as const;
