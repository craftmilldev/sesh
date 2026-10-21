import "./env.js";
import { serve } from "@hono/node-server";
import app from "../src/index.js";

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`sesh listening on http://localhost:${port}`);
});
