import { randomBytes } from "node:crypto";
import { migrate, openDb, type Db } from "./index.js";

/** The docker-compose.yml Postgres; CI sets TEST_DATABASE_URL to its service container. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:54330/postgres";

/**
 * A migrated Db in its own throwaway database on the test Postgres server, so test files stay
 * isolated and can run in parallel. close() drops the database.
 */
export async function openTestDb(): Promise<Db> {
  const admin = new URL(process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL);
  const name = `sesh_test_${randomBytes(6).toString("hex")}`;
  const adminDb = await openDb({ databaseUrl: admin.toString() });
  try {
    await adminDb.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    await adminDb.close();
    throw new Error(`Can't reach the test Postgres at ${admin.host}. Start it with \`npm run db:up\`.`, { cause: err });
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = await openDb({ databaseUrl: url.toString() });
  await migrate(db);
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction(fn),
    async close() {
      await db.close();
      await adminDb.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await adminDb.close();
    },
  };
}
