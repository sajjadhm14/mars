import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from './config.js';

const derive = promisify(scrypt);
const cookieName = 'yadavari_session';
const sessionMs = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.SESSION_COOKIE_SECURE, path: '/' };
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const emailSchema = z.email('ایمیل معتبر وارد کنید.').max(254).transform(value => value.toLowerCase());
const usernameSchema = z.string().trim().min(3, 'نام کاربری باید حداقل ۳ حرف باشد.').max(32)
  .regex(/^[a-zA-Z0-9_]+$/, 'نام کاربری فقط شامل حروف انگلیسی، عدد و زیرخط است.');
const passwordSchema = z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد.').max(128, 'رمز عبور حداکثر ۱۲۸ کاراکتر است.');
const registerSchema = z.object({ username: usernameSchema, email: emailSchema, password: passwordSchema }).strict();
const loginSchema = z.object({ username: z.string().trim().min(1).max(32), password: z.string().min(1).max(128) }).strict();
const profileSchema = z.object({ reminderEmail: emailSchema }).strict();

export function publicUser(row) {
  return { id: row.id, username: row.username, email: row.email, reminderEmail: row.reminder_email, createdAt: row.created_at };
}
export function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, scryptOptions);
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
const dummyHash = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
async function checkPassword(password, stored) {
  const [version, salt, digest] = (stored || dummyHash).split('$');
  if (version !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(digest || '')) return false;
  const actual = await derive(password, salt, 64, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
function readToken(req) {
  const value = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}
async function newSession(client, userId, previousToken) {
  if (previousToken) await client.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(previousToken)]);
  const token = randomBytes(32).toString('hex');
  await client.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, new Date(Date.now() + sessionMs)]);
  await client.query('DELETE FROM sessions WHERE expires_at <= now()');
  return token;
}
async function limitAttempt(pool, key, limit) {
  await pool.query('DELETE FROM auth_rate_limits WHERE expires_at <= now()');
  const { rows } = await pool.query(`INSERT INTO auth_rate_limits (key, attempts, expires_at)
    VALUES ($1, 1, now()+interval '15 minutes')
    ON CONFLICT (key) DO UPDATE SET
      attempts=CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
      expires_at=CASE WHEN auth_rate_limits.expires_at <= now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END
    RETURNING attempts`, [key]);
  return rows[0].attempts <= limit;
}

export function attachAuth(app, pool) {
  app.post(['/api/auth/register', '/api/auth/login'], async (req, res, next) => {
    if (!await limitAttempt(pool, `ip:${req.ip}`, 60)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد است. ۱۵ دقیقه بعد دوباره امتحان کنید.' });
    }
    next();
  });

  app.post('/api/auth/register', async (req, res) => {
    const data = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(data.password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize first registration so only one account can adopt legacy personal tasks.
      await client.query('SELECT pg_advisory_xact_lock(68420912)');
      const { rows: existing } = await client.query('SELECT 1 FROM users LIMIT 1');
      const { rows } = await client.query(`INSERT INTO users (id, username, email, reminder_email, password_hash)
        VALUES ($1,$2,$3,$3,$4) RETURNING *`, [randomUUID(), data.username, data.email, passwordHash]);
      const user = rows[0];
      if (!existing.length) await client.query('UPDATE tasks SET user_id=$1 WHERE user_id IS NULL', [user.id]);
      const token = await newSession(client, user.id, readToken(req));
      await client.query('COMMIT');
      res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMs });
      res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return res.status(409).json({ error: 'این نام کاربری یا ایمیل قبلاً ثبت شده است.' });
      throw error;
    } finally { client.release(); }
  });

  app.post('/api/auth/login', async (req, res) => {
    const data = loginSchema.parse(req.body);
    const rateKey = `username:${data.username.toLowerCase()}`;
    if (!await limitAttempt(pool, rateKey, 10)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'تعداد تلاش‌های ورود زیاد است. ۱۵ دقیقه بعد دوباره امتحان کنید.' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [data.username]);
    const matches = await checkPassword(data.password, rows[0]?.password_hash);
    if (!rows[0] || !matches) return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const token = await newSession(client, rows[0].id, readToken(req));
      await client.query('DELETE FROM auth_rate_limits WHERE key=$1', [rateKey]);
      await client.query('COMMIT');
      res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMs });
      res.json({ user: publicUser(rows[0]) });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readToken(req);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });

  app.use('/api', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = readToken(req);
    if (token) {
      const { rows } = await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at > now()`, [hashToken(token)]);
      if (rows[0]) { req.user = rows[0]; return next(); }
    }
    res.clearCookie(cookieName, cookieOptions);
    res.status(401).json({ error: 'برای ادامه وارد حساب کاربری شوید.' });
  });
  app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));
  app.get('/api/profile', (req, res) => res.json({ user: publicUser(req.user) }));
  app.patch('/api/profile', async (req, res) => {
    const { reminderEmail } = profileSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('UPDATE users SET reminder_email=$2, updated_at=now() WHERE id=$1 RETURNING *', [req.user.id, reminderEmail]);
      await client.query(`UPDATE tasks SET recipient=$2::varchar(254), reminder_attempts=0, next_attempt_at=NULL,
        last_error=NULL, updated_at=now() WHERE user_id=$1 AND completed_at IS NULL
        AND reminder_sent_at IS NULL AND recipient IS DISTINCT FROM $2::varchar(254)`, [req.user.id, reminderEmail]);
      await client.query('COMMIT');
      res.json({ user: publicUser(rows[0]) });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
}
