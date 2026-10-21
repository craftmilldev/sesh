// Vercel entry point. Vercel detects Hono at src/index.ts (it must import hono) and serves the default export as a
// Function.
// Don't add a src/app.ts: Vercel tries it before src/index.ts, which is why the routes live in api.ts.
import { Hono } from "hono";
import { createApp } from "./api.js";
import { getDb } from "./db/index.js";
import { senderFromEnv } from "./email.js";
import { createMetrics } from "./metrics.js";

const tokenSecret = process.env.TOKEN_SECRET;
if (!tokenSecret) throw new Error("TOKEN_SECRET is required (it signs session tokens)");

const app = new Hono();
app.route("/", createApp({ getDb, tokenSecret, metrics: createMetrics(), sendEmail: senderFromEnv() }));

export default app;
