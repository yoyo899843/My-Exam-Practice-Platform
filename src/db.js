import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { questionTypes } from './question-types.js';

export function openDatabase(path = process.env.DATABASE_PATH || './data/practice.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, prefix TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', questions_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}', current_index INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, submitted_at TEXT, duration_seconds INTEGER, results_json TEXT);
    CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
  for (const { table } of Object.values(questionTypes)) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL, chapter TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
    explanation TEXT NOT NULL, language TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(user_id, subject, chapter, language);`);
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
