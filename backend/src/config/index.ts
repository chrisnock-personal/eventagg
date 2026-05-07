import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default("3001"),
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
  CORS_ORIGIN: z.string().default("*"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:");
  parsed.error.errors.forEach((err) => {
    console.error(`    ${err.path.join(".")}: ${err.message}`);
  });
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: parseInt(env.PORT, 10),
  nodeEnv: env.NODE_ENV,
  corsOrigin: env.CORS_ORIGIN,

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
