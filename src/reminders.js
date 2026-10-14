import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { config } from './config.js';

export function createTransport() {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: config.SMTP_REQUIRE_TLS,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

export function buildMessage(task) {
  const deliveryKey = createHash('sha256').update(`${task.id}:${task.reminder_at.toISOString()}:${task.recipient}`).digest('hex');
  return {
    from: config.SMTP_FROM,
    to: task.recipient,
    subject: `وقتشه! ${task.title}`,
    text: `پاشو، «${task.title}» رو هنوز انجام ندادی!\n\n${task.description ? task.description + '\n\n' : ''}وقتی انجامش دادی، توی یادآوری تیکش رو بزن.\n\nیک قدم کوچک هم حسابه 🌱`,
    messageId: `<${deliveryKey}@yadavari.local>`,
  };
}

export async function processOneReminder(pool, transport, maxAttempts = config.REMINDER_MAX_ATTEMPTS) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT t.*, u.reminder_email AS delivery_recipient
      FROM tasks t JOIN users u ON u.id=t.user_id
      WHERE t.completed_at IS NULL AND t.reminder_sent_at IS NULL AND t.reminder_at <= now()
        AND t.reminder_attempts < $1 AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
      ORDER BY t.reminder_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED`, [maxAttempts]);
    const task = rows[0];
    if (!task) { await client.query('COMMIT'); return false; }
    task.recipient = task.delivery_recipient;
    // Keep the row locked through SMTP: parallel workers cannot send this task together,
    // and a completion committed before this lock excludes the task from delivery.
    let sendError;
    try {
      const result = await transport.sendMail(buildMessage(task));
      if (!result.accepted?.length) throw Object.assign(new Error('No recipient accepted'), { code: 'EREJECTED' });
    } catch (error) { sendError = error; }
    if (sendError) {
      const delaySeconds = Math.min(3600, 30 * 2 ** task.reminder_attempts);
      await client.query(`UPDATE tasks SET reminder_attempts=reminder_attempts+1,
        next_attempt_at=now()+($2 * interval '1 second'), last_error=$3, updated_at=now() WHERE id=$1`,
      [task.id, delaySeconds, String(sendError.code || 'SMTP_ERROR').slice(0, 100)]);
      console.warn('Reminder delivery failed:', task.id, sendError.code || 'SMTP_ERROR');
    } else {
      await client.query(`UPDATE tasks SET reminder_sent_at=now(), reminder_attempts=reminder_attempts+1,
        recipient=$2, next_attempt_at=NULL, last_error=NULL, updated_at=now() WHERE id=$1`, [task.id, task.recipient]);
      console.log('Reminder accepted by SMTP:', task.id);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
