import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { config } from './config.js';

const pool = createPool();
await migrate(pool);
const server = createApp(pool).listen(config.PORT, '0.0.0.0', () => console.log(`API listening on ${config.PORT}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 30000).unref();
  });
}
