import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const bundledMigrations = fileURLToPath(new URL('./migrations/', import.meta.url));

function synchronous(fn, db) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
    throw new TypeError('Database callbacks must be synchronous functions.');
  }
  const result = fn(db);
  if (result != null && typeof result.then === 'function') {
    // Consume rejected promises without mistaking them for committed work.
    Promise.resolve(result).catch(() => {});
    throw new TypeError('Database callbacks must be synchronous functions.');
  }
  return result;
}

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries) {
    const match = /^(\d+).*\.(?:js|mjs)$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const expected = Number(match[1]);
    const url = pathToFileURL(resolve(directory, entry.name));
    // Each open loads the supplied files anew, including repaired test migrations.
    url.searchParams.set('load', randomUUID());
    const migration = await import(url.href);
    if (!Number.isSafeInteger(expected) || expected < 1 || migration.version !== expected || typeof migration.up !== 'function') {
      throw new Error(`Invalid migration module: ${entry.name}`);
    }
    migrations.push(migration);
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let index = 0; index < migrations.length; index++) {
    if (index && migrations[index].version === migrations[index - 1].version) {
      throw new Error(`Duplicate migration version: ${migrations[index].version}`);
    }
    if (migrations[index].version !== index + 1) throw new Error('Migration versions must be contiguous starting at 1.');
  }
  return migrations;
}

export async function openDatabase({ filename, migrationsDir = bundledMigrations }) {
  if (typeof filename !== 'string' || !filename) throw new TypeError('filename must be a nonempty string.');
  const migrations = await discover(migrationsDir);
  if (filename !== ':memory:') await mkdir(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  let closed = false;
  let depth = 0;
  let nextSavepoint = 0;

  function close() {
    if (closed) return;
    if (depth) throw new Error('Cannot close the database inside a transaction.');
    db.close();
    closed = true;
  }

  function transaction(fn) {
    if (closed) throw new Error('Database is closed.');
    const savepoint = depth ? `nested_${++nextSavepoint}` : null;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = synchronous(fn, db);
      db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally {
      depth--;
    }
  }

  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      applied_at TEXT NOT NULL
    )`);
    const appliedVersion = () => {
      const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      if (rows.some(row => row.version > migrations.length)) throw new Error('Unsupported newer database version.');
      if (rows.some((row, index) => row.version !== index + 1)) throw new Error('Database migration versions contain a gap.');
      return rows.length;
    };
    transaction(appliedVersion);
    for (const migration of migrations) {
      transaction(() => {
        if (migration.version <= appliedVersion()) return;
        synchronous(migration.up, db);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      });
    }
    return { db, transaction, close, filename };
  } catch (error) {
    close();
    throw error;
  }
}
