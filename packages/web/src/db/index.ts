import { migrations } from "./migrations.js";

/**
 * The only thing the rest of the app knows about the database.
 * Postgres everywhere: a local Docker Postgres (see docker-compose.yml) in dev and tests, Neon on Vercel.
 * For jsonb params, pass the JS object itself (not JSON.stringify'd): postgres.js learns the param
 * type from the server and serializes it, so a pre-stringified value gets stored as a JSON *string*.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn on one connection inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres:// URL. */
  databaseUrl: string;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // Neon's connection strings carry libpq's `channel_binding`, which postgres.js doesn't understand
  // and would forward to the server as a startup parameter.
  const u = new URL(opts.databaseUrl);
  u.searchParams.delete("channel_binding");
  // prepare:false: Neon's pooled endpoint (-pooler) is PgBouncer in transaction mode.
  // onnotice: no-op, since postgres.js console.logs NOTICEs by default, and our idempotent
  // `CREATE ... IF NOT EXISTS` migration bookkeeping emits one on every run.
  const sql = postgres(u.toString(), { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async transaction<R>(fn: (tx: Pick<Db, "query">) => Promise<R>) {
      return (await sql.begin((tx) =>
        fn({
          query: async <T>(text: string, params: unknown[] = []) =>
            (await tx.unsafe(text, params as never[])) as unknown as T[],
        }),
      )) as R;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Arbitrary constant: the advisory lock that makes concurrent `migrate()` runs (two builds at once) take turns. */
export const MIGRATE_LOCK = 7_204_114;

export async function migrate(db: Db): Promise<string[]> {
  // Transaction-level locks (not session-level) so this holds through a pooler and releases itself on failure.
  await db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
    await tx.query(`CREATE SCHEMA IF NOT EXISTS sesh`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS sesh.schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  });
  const applied: string[] = [];
  for (const m of migrations) {
    // Each statement separately: postgres.js unsafe() with params can't run multi-statement strings.
    // One transaction (Postgres DDL is transactional), so a failure leaves nothing half-applied and unrecorded.
    // Under the lock, re-check: a concurrent run may have applied it since we started.
    const ran = await db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock($1)`, [MIGRATE_LOCK]);
      const done = await tx.query(`SELECT 1 FROM sesh.schema_migrations WHERE version = $1`, [m.version]);
      if (done.length) return false;
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query(`INSERT INTO sesh.schema_migrations (version) VALUES ($1)`, [m.version]);
      return true;
    });
    if (ran) applied.push(m.version);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

let shared: Promise<Db> | undefined;

/**
 * Process-wide DB, configured from env. Reused across requests (and across invocations on warm Vercel functions).
 * Serves from DATABASE_URL_POOLED, else DATABASE_URL. Migrations pick their own URL in run-migrations.ts.
 */
export function getDb(): Promise<Db> {
  if (!shared) {
    const databaseUrl = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Locally: `npm run db:up`, then copy packages/web/.env.example to .env.",
      );
    }
    shared = openDb({ databaseUrl });
  }
  return shared;
}
