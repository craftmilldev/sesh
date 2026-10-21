// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { createApp } from "./app.js";
import { getDb } from "./db/index.js";
import { senderFromEnv } from "./email.js";
import { createMetrics } from "./metrics.js";

const tokenSecret = process.env.TOKEN_SECRET;
if (!tokenSecret) throw new Error("TOKEN_SECRET is required (it signs session tokens)");

export default createApp({ getDb, tokenSecret, metrics: createMetrics(), sendEmail: senderFromEnv() });
