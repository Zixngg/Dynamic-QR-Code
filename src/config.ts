import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(1433),
  DB_USER: z.string(),
  DB_PASS: z.string(),
  DB_NAME: z.string(),

  // Auth + cookies
  JWT_SECRET: z.string().min(16),
  ACCESS_TTL_MIN: z.coerce.number().default(15),   // access token lifetime (minutes)
  REFRESH_TTL_DAYS: z.coerce.number().default(30), // refresh token lifetime (days)
  COOKIE_DOMAIN: z.string().default('localhost'),
});

export const env = Env.parse(process.env);
