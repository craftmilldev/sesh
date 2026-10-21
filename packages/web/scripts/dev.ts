import "./env.js";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { getDb, migrate } from "../src/db/index.js";

if (!process.env.TOKEN_SECRET) {
  process.env.TOKEN_SECRET = randomBytes(32).toString("hex");
  console.warn("TOKEN_SECRET is unset: using a random one, so sessions end when this server restarts.");
}
const { default: app } = await import("../src/index.js"); // after TOKEN_SECRET is settled

// Open and migrate up front so the first request isn't slow and a fresh local database has its tables.
await migrate(await getDb());

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`sesh listening on http://localhost:${port}`);
});
