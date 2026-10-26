import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/hub/db.js';
import { temporaryDirectory } from './helpers/processes.js';

async function fixture(t, modules) {
  const directory = await temporaryDirectory(t);
  const migrationsDir = join(directory, 'migrations');
  await mkdir(migrationsDir);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const [name, content] of Object.entries(modules)) await writeFile(join(migrationsDir, name), content);
  return { filename: join(directory, 'store.sqlite'), migrationsDir };
}

const first = `export const version = 1; export function up(db) { db.exec('CREATE TABLE sample (value TEXT NOT NULL)'); }`;

test('fresh foundation has exact columns, enforced foreign keys, WAL, and durable reopen', async t => {
  const filename = join(await temporaryDirectory(t), 'nested', 'store.sqlite');
  const database = await openDatabase({ filename });
  t.after(() => database.close());
  assert.equal(database.filename, filename);
  assert.ok(database.db instanceof DatabaseSync);
  const { db } = database;
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const columns = {
    owners: 'id name created_at',
    participants: 'id owner_id kind name runtime workspace_json context created_at',
    agent_bindings: 'participant_id resume_hash generation',
    connections: 'id participant_id generation token_hash boot_id created_at closed_at',
    session_requests: 'resume_hash request_id payload_json result_json',
    browser_sessions: 'token_hash token_value participant_id',
    rooms: 'id name goal next_sequence created_at',
    memberships: 'room_id participant_id epoch active joined_sequence acknowledged_sequence paused',
    events: 'id room_id sequence author_id author_name author_kind text reply_to created_at mentions_json',
    requests: 'participant_id request_id operation payload_json result_json',
    batches: 'id room_id participant_id membership_epoch scanned_through events_json status created_at',
    tasks: 'id room_id title scope status created_by owner_id source_message_id worker_ref latest_update result version created_at updated_at',
    hub_settings: 'key value',
    invitations: 'id token_hash room_id owner_id created_by kind label expires_at revoked_at used_key used_payload result_json created_at',
    room_access: 'owner_id room_id invitation_id',
    agent_scopes: 'participant_id room_id invitation_id',
    invitation_emails: 'id invitation_id participant_id room_id message_json status created_at',
  };
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), [...Object.keys(columns), 'schema_migrations'].sort());
  for (const [table, names] of Object.entries(columns)) {
    assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name), names.split(' '));
  }
  assert.throws(() => db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('p', 'missing', 'agent', 'A', null, null, '', 'now'), /FOREIGN KEY/);
  database.transaction(() => {
    db.exec("INSERT INTO owners VALUES ('o', 'Owner', 'now')");
    db.exec("INSERT INTO participants VALUES ('p', 'o', 'agent', 'Agent', NULL, NULL, '', 'now')");
    db.exec("INSERT INTO rooms(id,name,goal,created_at) VALUES ('r','Room','','now')");
    db.exec("INSERT INTO memberships VALUES ('r','p','epoch1',1,0,0,0)");
    db.exec("INSERT INTO batches VALUES ('b','r','p','epoch1',1,'[]','pending','now')");
  });
  assert.throws(() => db.exec("INSERT INTO batches VALUES ('b2','r','p','epoch1',1,'[]','pending','now')"), /UNIQUE/);
  database.transaction(() => {
    db.exec("UPDATE batches SET status='invalidated' WHERE id='b'");
    db.exec("UPDATE memberships SET epoch='epoch2' WHERE room_id='r'");
    db.exec("INSERT INTO batches VALUES ('b2','r','p','epoch2',1,'[]','pending','now')");
  });
  const applied = { ...db.prepare('SELECT * FROM schema_migrations').get() };
  assert.equal(applied.version, 1);
  assert.ok(Number.isFinite(Date.parse(applied.applied_at)));
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5]);
  database.close();
  database.close();
  assert.throws(() => database.transaction(() => {}), /closed/);
  assert.throws(() => db.prepare('SELECT 1'), /not open/);
  const reopened = await openDatabase({ filename });
  t.after(() => reopened.close());
  assert.deepEqual({ ...reopened.db.prepare('SELECT * FROM schema_migrations').get() }, applied);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM batches').get().n, 2);
  assert.equal(reopened.db.prepare("SELECT membership_epoch FROM batches WHERE id='b'").get().membership_epoch, 'epoch1');
  assert.equal(reopened.db.prepare('SELECT next_sequence FROM rooms').get().next_sequence, 1);
});

test('nested rollback isolates inner failures and outer rollback undoes released savepoints', async t => {
  const database = await openDatabase({ filename: ':memory:' });
  t.after(() => database.close());
  const { db, transaction } = database;
  const insert = name => db.prepare('INSERT INTO owners VALUES (?, ?, ?)').run(name, name, 'now');
  assert.equal(transaction(() => {
    insert('outer');
    assert.throws(() => transaction(() => { insert('discard'); throw new Error('inner'); }), /inner/);
    transaction(() => insert('inner'));
    assert.throws(() => database.close(), /inside a transaction/);
    return 42;
  }), 42);
  assert.throws(() => transaction(() => {
    transaction(() => insert('also-discard'));
    throw new Error('outer failure');
  }), /outer failure/);
  assert.deepEqual(db.prepare('SELECT id FROM owners ORDER BY id').all().map(row => row.id), ['inner', 'outer']);
});

test('async functions never run; promise and thenable returns roll back their writes', async t => {
  const database = await openDatabase({ filename: ':memory:' });
  t.after(() => database.close());
  let ran = false;
  assert.throws(() => database.transaction(async () => { ran = true; }), /synchronous/);
  assert.equal(ran, false);
  for (const value of [Promise.resolve(), Promise.reject(new Error('rejected callback')), { then(resolve) { resolve(); } }]) {
    assert.throws(() => database.transaction(() => {
      database.db.exec("INSERT INTO owners VALUES ('x','X','now')");
      return value;
    }), /synchronous/);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM owners').get().n, 0);
});

test('migrations run in order, roll back DDL and ledger together, and recover after repair', async t => {
  const options = await fixture(t, {
    '002-second.js': `export const version=2; export function up(db) { db.exec("INSERT INTO sample VALUES ('lost'); CREATE TABLE partial(value TEXT)"); throw new Error('migration failed'); }`,
    '001-first.js': first,
  });
  await assert.rejects(openDatabase(options), /migration failed/);
  const inspect = new DatabaseSync(options.filename);
  try {
    assert.deepEqual(inspect.prepare('SELECT version FROM schema_migrations').all().map(row => row.version), [1]);
    assert.equal(inspect.prepare('SELECT count(*) AS n FROM sample').get().n, 0);
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
  } finally { inspect.close(); }
  await writeFile(join(options.migrationsDir, '002-second.js'), `export const version=2; export function up(db) { db.exec("INSERT INTO sample VALUES ('recovered')"); }`);
  const recovered = await openDatabase(options);
  recovered.close();
  const reopened = await openDatabase(options);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.db.prepare('SELECT value FROM sample').all().map(row => row.value), ['recovered']);
  assert.deepEqual(reopened.db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version), [1, 2]);
});

test('duplicate, gapped, mismatched, and async migration modules fail', async t => {
  for (const [modules, message] of [
    [{ '001-a.js': first, '001-b.js': first }, /Duplicate/],
    [{ '002-a.js': 'export const version=2; export function up() {}' }, /contiguous/],
    [{ '001-a.js': 'export const version=2; export function up() {}' }, /Invalid migration/],
    [{ '001-a.js': 'export const version=1; export async function up() {}' }, /synchronous/],
    [{ '001-a.js': `export const version=1; export function up(db) { db.exec('CREATE TABLE partial(x)'); return Promise.resolve(); }` }, /synchronous/],
  ]) {
    await assert.rejects(openDatabase(await fixture(t, modules)), message);
  }
});

test('newer versions and gaps in the persisted ledger are rejected', async t => {
  const options = await fixture(t, { '001-first.js': first, '002-next.js': 'export const version=2; export function up() {}' });
  const database = await openDatabase(options);
  database.db.exec('DELETE FROM schema_migrations WHERE version=1');
  database.close();
  await assert.rejects(openDatabase(options), /gap/);
  const inspect = new DatabaseSync(options.filename);
  inspect.exec("INSERT INTO schema_migrations VALUES (3, 'now')");
  inspect.close();
  await assert.rejects(openDatabase(options), /newer/);
});
