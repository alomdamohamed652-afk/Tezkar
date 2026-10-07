import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10)
});

export const env = envSchema.parse(process.env);
