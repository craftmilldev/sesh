import { runMigrations } from "../src/db/run-migrations.js";
import { createMetrics } from "../src/metrics.js";

// Migrate first, so a failing migration fails the build and Vercel keeps the previous deployment live.
await runMigrations({ metrics: createMetrics() });
