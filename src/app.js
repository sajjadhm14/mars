import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { taskSchema, serializeTask } from './tasks.js';
import { attachAuth } from './auth.js';

export function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  // JSON-only writes plus Origin/Fetch Metadata checks protect cookie-authenticated requests.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'درخواست غیرمجاز است.' });
      const origin = req.get('origin');
      if (origin) {
        try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'درخواست غیرمجاز است.' }); }
        catch { return res.status(403).json({ error: 'درخواست غیرمجاز است.' }); }
      }
      if (req.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'بدنهٔ درخواست باید JSON باشد.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const serialize = row => serializeTask(row, config.REMINDER_MAX_ATTEMPTS);
  const returning = 'RETURNING *, (SELECT reminder_email FROM users WHERE id=tasks.user_id) AS reminder_email';

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  attachAuth(app, pool);
  app.get('/api/config', async (_req, res) => {
    const { rows } = await pool.query('SELECT last_seen_at FROM worker_status WHERE id = 1');
    const lastSeen = rows[0]?.last_seen_at;
    res.json({
      mailMode: config.SMTP_HOST === 'mailpit' ? 'local' : 'smtp',
      workerOnline: Boolean(lastSeen && Date.now() - lastSeen.getTime() < Math.max(config.REMINDER_POLL_MS * 3, 90000)),
    });
  });
  app.get('/api/tasks', async (req, res) => {
    const { rows } = await pool.query(`SELECT t.*, u.reminder_email FROM tasks t JOIN users u ON u.id=t.user_id
      WHERE t.user_id=$1 ORDER BY t.reminder_at ASC, t.created_at DESC`, [req.user.id]);
    res.json(rows.map(serialize));
  });
  app.param('id', (req, _res, next, id) => {
    z.uuid().parse(id);
    next();
  });
  app.post('/api/tasks', async (req, res) => {
    const task = taskSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tasks (id, title, description, recipient, reminder_at, user_id)
      SELECT $1, $2, $3, reminder_email, $4, id FROM users WHERE id=$5 ${returning}`,
    [randomUUID(), task.title, task.description, task.reminderAt, req.user.id]);
    res.status(201).json(serialize(rows[0]));
  });
  app.put('/api/tasks/:id', async (req, res) => {
    const task = taskSchema.parse(req.body);
    // Recipient comes from the profile; only rescheduling starts another sent reminder.
    const reset = '(reminder_at IS DISTINCT FROM $4::timestamptz)';
    const { rows } = await pool.query(`
      UPDATE tasks SET title=$2, description=$3, reminder_at=$4::timestamptz,
        reminder_sent_at=CASE WHEN ${reset} THEN NULL ELSE reminder_sent_at END,
        reminder_attempts=CASE WHEN ${reset} THEN 0 ELSE reminder_attempts END,
        next_attempt_at=CASE WHEN ${reset} THEN NULL ELSE next_attempt_at END,
        last_error=CASE WHEN ${reset} THEN NULL ELSE last_error END,
        updated_at=now()
      WHERE id=$1 AND user_id=$5 ${returning}`,
    [req.params.id, task.title, task.description, task.reminderAt, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'تسک پیدا نشد.' });
    res.json(serialize(rows[0]));
  });
  app.patch('/api/tasks/:id/completion', async (req, res) => {
    const { completed } = z.object({ completed: z.boolean() }).strict().parse(req.body);
    const { rows } = await pool.query(`UPDATE tasks
      SET completed_at=CASE WHEN $2 THEN COALESCE(completed_at, now()) ELSE NULL END, updated_at=now()
      WHERE id=$1 AND user_id=$3 ${returning}`, [req.params.id, completed, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'تسک پیدا نشد.' });
    res.json(serialize(rows[0]));
  });
  app.post('/api/tasks/:id/retry', async (req, res) => {
    const { rows } = await pool.query(`UPDATE tasks SET reminder_attempts=0, next_attempt_at=NULL,
      last_error=NULL, updated_at=now()
      WHERE id=$1 AND user_id=$2 AND completed_at IS NULL AND reminder_sent_at IS NULL ${returning}`, [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(409).json({ error: 'این یادآوری قابل ارسال مجدد نیست.' });
    res.json(serialize(rows[0]));
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'تسک پیدا نشد.' });
    res.status(204).end();
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر پیدا نشد.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof ZodError) return res.status(400).json({ error: 'اطلاعات واردشده معتبر نیست.', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON معتبر نیست.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'حجم درخواست بیش از حد مجاز است.' });
    console.error('Request failed:', error.code || error.name);
    res.status(500).json({ error: 'ارتباط با سرویس برقرار نشد. دوباره تلاش کنید.' });
  });
  return app;
}
