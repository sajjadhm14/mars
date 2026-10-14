import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, migrate } from './db.js';
import { config } from './config.js';
import { createTransport, processOneReminder } from './reminders.js';

const pool = createPool();
await migrate(pool);
const transport = createTransport();
let stopping = false;
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; abort.abort(); });
console.log('Reminder worker started');
while (!stopping) {
  try {
    await pool.query(`INSERT INTO worker_status (id, last_seen_at) VALUES (1, now())
      ON CONFLICT (id) DO UPDATE SET last_seen_at=now()`);
    // Bounded batches leave time for health updates and shutdown.
    for (let i = 0; i < 5 && !stopping; i++) {
      if (!await processOneReminder(pool, transport)) break;
    }
  } catch (error) { console.error('Reminder worker error:', error.code || error.name); }
  if (!stopping) await sleep(config.REMINDER_POLL_MS, undefined, { signal: abort.signal }).catch(() => {});
}
transport.close();
await pool.end();
