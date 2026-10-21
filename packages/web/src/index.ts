// Vercel entry point. Vercel detects Hono at src/index.ts and serves the default export as a Function.
import { createApp } from "./app.js";
import { createMetrics } from "./metrics.js";

export default createApp({ metrics: createMetrics() });
