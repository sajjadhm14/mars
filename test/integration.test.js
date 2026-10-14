import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildMessage, processOneReminder, createTransport } from '../src/reminders.js';

// Every run gets a separate PostgreSQL schema; existing application data is untouched.
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = createPool();
let pool, server, base, cookie, account;
const past = () => new Date(Date.now() - 60000).toISOString();
const future = () => new Date(Date.now() + 3600000).toISOString();
const password = 'test-password-1234';
const example = overrides => ({ title: 'کتاب بخوانم', description: 'فصل دوم', reminderAt: past(), ...overrides });
async function request(path, method = 'GET', body, session = cookie) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
}
const sessionCookie = result => result.headers.get('set-cookie')?.split(';')[0];
async function register(overrides = {}) {
  return request('/auth/register', 'POST', { username: 'tester', email: 'test@example.test', password, ...overrides }, '');
}
async function add(overrides) {
  const result = await request('/tasks', 'POST', example(overrides));
  assert.equal(result.status, 201);
  return result.data;
}
const sent = [];
const transport = { async sendMail(message) { sent.push(message); return { accepted: [message.to] }; } };

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool({ options: `-c search_path=${schema}` });
  await migrate(pool);
  server = createApp(pool).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async () => {
  sent.length = 0; cookie = '';
  await pool.query('TRUNCATE tasks, worker_status, sessions, users, auth_rate_limits');
  const result = await register();
  assert.equal(result.status, 201);
  cookie = sessionCookie(result); account = result.data.user;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('CRUD, validation, timestamps and task completion', async () => {
  assert.equal((await request('/tasks', 'POST', example({ title: '  ' }))).status, 400);
  assert.equal((await request('/tasks', 'POST', example({ recipient: 'invalid' }))).status, 400);
  assert.equal((await request('/tasks', 'POST', example({ reminderAt: 'tomorrow' }))).status, 400);
  assert.equal((await request('/tasks/not-a-uuid', 'DELETE')).status, 400);
  const task = await add({ reminderAt: '2030-06-15T12:00:00+03:30' });
  assert.equal(task.reminderAt, '2030-06-15T08:30:00.000Z');
  assert.equal((await request('/tasks')).data.length, 1);
  const edit = await request(`/tasks/${task.id}`, 'PUT', example({ title: 'عنوان تازه' }));
  assert.equal(edit.data.title, 'عنوان تازه');
  assert.ok((await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: true })).data.completedAt);
  assert.equal((await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: false })).data.completedAt, null);
  assert.equal((await request(`/tasks/${task.id}`, 'DELETE')).status, 204);
  assert.equal((await request('/tasks')).data.length, 0);
});

test('only overdue unfinished tasks are sent; sent tasks are not sent again', async () => {
  const due = await add();
  const completed = await add();
  await request(`/tasks/${completed.id}/completion`, 'PATCH', { completed: true });
  await add({ reminderAt: future() });
  assert.equal(await processOneReminder(pool, transport), true);
  assert.equal(await processOneReminder(pool, transport), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /کتاب بخوانم/);
  const row = (await pool.query('SELECT * FROM tasks WHERE id=$1', [due.id])).rows[0];
  assert.ok(row.reminder_sent_at);
  assert.equal(row.reminder_attempts, 1);
});

test('two workers cannot send the same task concurrently', async () => {
  await add();
  let release, announce;
  const entered = new Promise(resolve => { announce = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const first = processOneReminder(pool, { async sendMail(message) { announce(); await barrier; return transport.sendMail(message); } });
  await entered;
  try { assert.equal(await processOneReminder(pool, transport), false); }
  finally { release(); }
  await first;
  assert.equal(sent.length, 1);
});

test('SMTP failure retries later and survives a new database connection', async () => {
  const task = await add();
  await processOneReminder(pool, { async sendMail() { throw Object.assign(new Error('temporary'), { code: 'ECONNECTION' }); } });
  let row = (await pool.query('SELECT * FROM tasks WHERE id=$1', [task.id])).rows[0];
  assert.equal(row.reminder_attempts, 1);
  assert.equal(row.reminder_sent_at, null);
  assert.ok(row.next_attempt_at > new Date());
  assert.equal(await processOneReminder(pool, transport), false);
  await pool.query("UPDATE tasks SET next_attempt_at=now()-interval '1 second'");
  const restarted = createPool({ options: `-c search_path=${schema}` });
  try { assert.equal(await processOneReminder(restarted, transport), true); }
  finally { await restarted.end(); }
  row = (await pool.query('SELECT * FROM tasks WHERE id=$1', [task.id])).rows[0];
  assert.ok(row.reminder_sent_at);
  assert.equal(row.last_error, null);
});

test('retry cap and manual retry', async () => {
  const task = await add();
  await processOneReminder(pool, { async sendMail() { return { accepted: [] }; } }, 1);
  assert.equal(await processOneReminder(pool, transport, 1), false);
  assert.equal((await request(`/tasks/${task.id}/retry`, 'POST', {})).status, 200);
  assert.equal(await processOneReminder(pool, transport, 1), true);
});

test('editing text preserves sent state; rescheduling starts a new reminder', async () => {
  const task = await add();
  await processOneReminder(pool, transport);
  await request(`/tasks/${task.id}`, 'PUT', example({ title: 'تغییر عنوان', reminderAt: task.reminderAt }));
  assert.equal(await processOneReminder(pool, transport), false);
  await request(`/tasks/${task.id}`, 'PUT', example({ reminderAt: new Date(Date.now() - 10000).toISOString() }));
  assert.equal(await processOneReminder(pool, transport), true);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].messageId, sent[1].messageId);
});

test('completion stops a pending retry; reopening a sent task does not resend', async () => {
  const task = await add();
  await processOneReminder(pool, { async sendMail() { throw new Error('offline'); } });
  await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: true });
  await pool.query('UPDATE tasks SET next_attempt_at=NULL');
  assert.equal(await processOneReminder(pool, transport), false);
  await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: false });
  assert.equal(await processOneReminder(pool, transport), true);
  await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: true });
  await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: false });
  assert.equal(await processOneReminder(pool, transport), false);
});

test('same-origin mutation guard and default worker status', async () => {
  const response = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify(example()) });
  assert.equal(response.status, 403);
  assert.equal((await request('/config')).data.workerOnline, false);
  await pool.query('INSERT INTO worker_status VALUES (1, now())');
  assert.equal((await request('/config')).data.workerOnline, true);
});

test('email message IDs stay stable for delivery retries', () => {
  const task = { id: randomUUID(), title: 'سلام', description: '', recipient: 'test@example.test', reminder_at: new Date() };
  assert.equal(buildMessage(task).messageId, buildMessage(task).messageId);
});

test('real SMTP delivery reaches local Mailpit', { skip: process.env.TEST_MAILPIT !== 'true' }, async () => {
  assert.equal(process.env.SMTP_HOST, 'mailpit', 'This test must only use the local test mailbox');
  const title = `integration-${randomUUID()}`;
  await add({ title });
  const smtp = createTransport();
  try { assert.equal(await processOneReminder(pool, smtp), true); }
  finally { smtp.close(); }
  const response = await fetch(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`subject:${title}`)}`);
  assert.equal(response.status, 200);
  const inbox = await response.json();
  assert.equal(inbox.messages.length, 1);
  assert.ok(inbox.messages[0].Subject.includes(title));
});

test('all task and profile endpoints require login', async () => {
  for (const path of ['/tasks', '/profile', '/config', '/auth/me']) {
    assert.equal((await request(path, 'GET', undefined, '')).status, 401, path);
  }
  assert.equal((await request('/tasks', 'POST', example(), '')).status, 401);
  assert.equal((await request('/profile', 'PATCH', { reminderEmail: 'other@example.test' }, '')).status, 401);
  assert.equal((await request('/health', 'GET', undefined, '')).status, 200);
});

test('registration validates inputs and defaults reminder email to registration email', async () => {
  assert.equal(account.reminderEmail, account.email);
  assert.equal((await register({ username: 'a' })).status, 400);
  assert.equal((await register({ username: 'with space' })).status, 400);
  assert.equal((await register({ email: 'invalid' })).status, 400);
  assert.equal((await register({ password: 'short' })).status, 400);
  assert.equal((await register({ username: 'TESTER', email: 'new@example.test' })).status, 409);
  assert.equal((await register({ username: 'another', email: 'TEST@example.test' })).status, 409);
  const fresh = await register({ username: 'Another_User', email: 'New@example.test' });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.user.email, 'new@example.test');
  assert.equal(fresh.data.user.reminderEmail, 'new@example.test');
  assert.match(fresh.headers.get('set-cookie'), /HttpOnly/);
  assert.match(fresh.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(fresh.headers.get('set-cookie'), /Path=\//);
  assert.equal(fresh.data.user.password_hash, undefined);
  const users = (await pool.query('SELECT password_hash FROM users')).rows;
  assert.notEqual(users[0].password_hash, users[1].password_hash);
  for (const user of users) { assert.match(user.password_hash, /^scrypt-v1\$/); assert.notEqual(user.password_hash, password); }
  const tokens = (await pool.query('SELECT token_hash FROM sessions')).rows;
  assert.ok(tokens.every(row => row.token_hash !== sessionCookie(fresh).split('=')[1]));
});

test('login uses username/password, rotates session, and logout revokes it', async () => {
  const wrong = await request('/auth/login', 'POST', { username: 'tester', password: 'wrong-password' }, '');
  const unknown = await request('/auth/login', 'POST', { username: 'nobody', password }, '');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, unknown.data);
  assert.equal((await request('/auth/login', 'POST', { username: account.email, password }, '')).status, 401);
  const login = await request('/auth/login', 'POST', { username: 'TESTER', password });
  assert.equal(login.status, 200);
  const newCookie = sessionCookie(login);
  assert.notEqual(newCookie, cookie);
  assert.equal((await request('/auth/me')).status, 401, 'old session is revoked');
  assert.equal((await request('/auth/me', 'GET', undefined, newCookie)).data.user.id, account.id);
  assert.equal((await request('/auth/logout', 'POST', {}, newCookie)).status, 204);
  assert.equal((await request('/auth/me', 'GET', undefined, newCookie)).status, 401);
});

test('expired and forged sessions cannot authenticate', async () => {
  assert.equal((await request('/auth/me', 'GET', undefined, `yadavari_session=${'a'.repeat(64)}`)).status, 401);
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await request('/auth/me')).status, 401);
});

test('database-backed sessions survive an API instance restart', async () => {
  const restarted = createApp(pool).listen(0, '127.0.0.1');
  await new Promise(resolve => restarted.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.address().port}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, account.id);
  } finally { restarted.closeAllConnections(); await new Promise(resolve => restarted.close(resolve)); }
});

test('a second user cannot read, edit, complete, retry, or delete another user task', async () => {
  const task = await add();
  const other = await register({ username: 'second', email: 'second@example.test' });
  const otherCookie = sessionCookie(other);
  assert.deepEqual((await request('/tasks', 'GET', undefined, otherCookie)).data, []);
  assert.equal((await request(`/tasks/${task.id}`, 'PUT', example({ title: 'tampered' }), otherCookie)).status, 404);
  assert.equal((await request(`/tasks/${task.id}/completion`, 'PATCH', { completed: true }, otherCookie)).status, 404);
  assert.equal((await request(`/tasks/${task.id}/retry`, 'POST', {}, otherCookie)).status, 409);
  assert.equal((await request(`/tasks/${task.id}`, 'DELETE', undefined, otherCookie)).status, 404);
  assert.equal((await request('/tasks', 'POST', example({ userId: account.id }), otherCookie)).status, 400);
  const own = (await request('/tasks')).data;
  assert.equal(own.length, 1);
  assert.equal(own[0].title, task.title);
  assert.equal(own[0].completedAt, null);
});

test('profile email change applies to pending/new reminders without resending sent tasks', async () => {
  const delivered = await add();
  await processOneReminder(pool, transport);
  const pending = await add();
  const profile = await request('/profile', 'PATCH', { reminderEmail: 'reminders@example.test' });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.user.email, 'test@example.test');
  assert.equal(profile.data.user.reminderEmail, 'reminders@example.test');
  const current = (await request('/tasks')).data;
  assert.equal(current.find(task => task.id === pending.id).recipient, 'reminders@example.test');
  assert.equal(current.find(task => task.id === delivered.id).recipient, 'test@example.test');
  const added = await add({ reminderAt: future() });
  assert.equal(added.recipient, 'reminders@example.test');
  assert.equal(await processOneReminder(pool, transport), true);
  assert.equal(sent[1].to, 'reminders@example.test');
  assert.equal(await processOneReminder(pool, transport), false);
  assert.equal(sent.length, 2);
  assert.equal((await request('/profile')).data.user.reminderEmail, 'reminders@example.test');
  assert.equal((await request('/profile', 'PATCH', { reminderEmail: 'invalid' })).status, 400);
  assert.equal((await request('/profile', 'PATCH', { reminderEmail: 'good@example.test', email: 'unauthorized@example.test' })).status, 400);
  const restored = await request('/profile', 'PATCH', { reminderEmail: account.email });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.user.reminderEmail, account.email);
});

test('profile updates do not affect another account', async () => {
  const other = await register({ username: 'second', email: 'second@example.test' });
  await request('/profile', 'PATCH', { reminderEmail: 'mine@example.test' });
  assert.equal((await request('/profile', 'GET', undefined, sessionCookie(other))).data.user.reminderEmail, 'second@example.test');
});

test('profile change restarts failed delivery attempts at the new address', async () => {
  await add();
  await processOneReminder(pool, { async sendMail() { throw new Error('unreachable'); } }, 1);
  assert.equal(await processOneReminder(pool, transport, 1), false);
  assert.equal((await request('/profile', 'PATCH', { reminderEmail: 'fixed@example.test' })).status, 200);
  assert.equal(await processOneReminder(pool, transport, 1), true);
  assert.equal(sent[0].to, 'fixed@example.test');
});

test('foreign Origin is rejected even if a session cookie is present', async () => {
  const response = await fetch(`${base}/profile`, { method: 'PATCH', headers: { Cookie: cookie, Origin: 'http://malicious.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ reminderEmail: 'attacker@example.test' }) });
  assert.equal(response.status, 403);
  assert.equal((await request('/profile')).data.user.reminderEmail, account.email);
});

test('login rate limit persists in PostgreSQL', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await request('/auth/login', 'POST', { username: 'tester', password: 'wrong-password' }, '')).status, 401);
  }
  const blocked = await request('/auth/login', 'POST', { username: 'tester', password }, '');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
});

test('migration keeps legacy tasks and assigns them only to the first registered account', async () => {
  await pool.query('TRUNCATE tasks, sessions, users, auth_rate_limits');
  const id = randomUUID();
  await pool.query(`INSERT INTO tasks (id, title, recipient, reminder_at) VALUES ($1, 'legacy', 'legacy@example.test', now())`, [id]);
  assert.equal(await processOneReminder(pool, transport), false, 'unowned tasks are not delivered');
  await migrate(pool);
  const first = await register();
  assert.equal((await request('/tasks', 'GET', undefined, sessionCookie(first))).data[0].id, id);
  const second = await register({ username: 'second', email: 'second@example.test' });
  assert.deepEqual((await request('/tasks', 'GET', undefined, sessionCookie(second))).data, []);
});
