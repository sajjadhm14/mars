import pg from 'pg';

export function createPool(options = {}) {
  const pool = new pg.Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    max: 10,
    connectionTimeoutMillis: 5000,
    ...options,
  });
  pool.on('error', error => console.error('Database connection error:', error.code));
  return pool;
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(68420911)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username VARCHAR(32) NOT NULL,
        email VARCHAR(254) NOT NULL,
        reminder_email VARCHAR(254) NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username));
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        recipient VARCHAR(254) NOT NULL,
        reminder_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        reminder_sent_at TIMESTAMPTZ,
        reminder_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tasks_pending_reminder_idx ON tasks (reminder_at)
        WHERE completed_at IS NULL AND reminder_sent_at IS NULL;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id, reminder_at);
      CREATE TABLE IF NOT EXISTS worker_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_seen_at TIMESTAMPTZ NOT NULL
      );
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
