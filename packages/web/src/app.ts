import { Hono } from "hono";
import { html } from "hono/html";
import { ANONYMOUS, type Metrics, noopMetrics } from "./metrics.js";

export interface AppOptions {
  metrics?: Metrics;
}

export function createApp({ metrics = noopMetrics }: AppOptions = {}) {
  const app = new Hono();

  // Nothing is checked yet (there is no database); a failing check will return 503 and record health_check_failed.
  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/", async (c) => {
    await metrics.capture("landing_viewed", ANONYMOUS);
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>sesh</title>
            <style>
              body {
                font:
                  18px/1.5 system-ui,
                  sans-serif;
                max-width: 36rem;
                margin: 6rem auto;
                padding: 0 1rem;
              }
            </style>
          </head>
          <body>
            <h1>sesh</h1>
            <p>Session insights for Claude Code teams. It shows the shape of the work, never who did it.</p>
            <p>Coming soon.</p>
          </body>
        </html>`,
    );
  });

  return app;
}
