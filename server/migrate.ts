import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(743921604)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      console.log(`Applied ${file}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error('Database migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
