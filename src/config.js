import { z } from 'zod';

const boolean = z.enum(['true', 'false']).transform(value => value === 'true');
export const config = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_COOKIE_SECURE: boolean.default(false),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: boolean.default(false),
  SMTP_REQUIRE_TLS: boolean.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().min(1).default('Yadavari <reminder@example.test>'),
  REMINDER_POLL_MS: z.coerce.number().int().min(100).default(15000),
  REMINDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
}).parse(process.env);
