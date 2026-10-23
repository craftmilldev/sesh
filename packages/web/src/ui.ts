import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";

// The signed-in app is a React SPA in client/ that talks to the JSON API under /api on the same origin.
// scripts/client.ts bundles it into public/app.js and public/app.css. This module returns the HTML shell that loads
// the bundle and serves the bundle itself: Vercel's CDN only serves public/ files that are committed, not ones the
// build writes. The URLs are literal so Vercel's file tracing ships both files with the function.

const BUNDLE = {
  "/app.js": { url: new URL("../public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" },
  "/app.css": { url: new URL("../public/app.css", import.meta.url), type: "text/css; charset=utf-8" },
};

const FONTS = {
  "/fonts/sorts-mill-goudy-latin-400-normal.woff2": new URL(
    "../public/fonts/sorts-mill-goudy-latin-400-normal.woff2",
    import.meta.url,
  ),
  "/fonts/sorts-mill-goudy-latin-400-italic.woff2": new URL(
    "../public/fonts/sorts-mill-goudy-latin-400-italic.woff2",
    import.meta.url,
  ),
  "/fonts/courier-prime-latin-400-normal.woff2": new URL(
    "../public/fonts/courier-prime-latin-400-normal.woff2",
    import.meta.url,
  ),
};

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sesh</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

// The session token lives in localStorage, where any script on the page can read it, so the page may run only our own
// bundle: no inline script, no other origins, no framing.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface WebOptions {
  /** Product metrics. Defaults to recording nothing. */
  metrics?: Metrics;
}

export function createWeb(opts: WebOptions = {}) {
  const app = new Hono();
  const metrics = opts.metrics ?? noopMetrics;

  app.get("/", async (c) => {
    await metrics.capture("landing_viewed", ANONYMOUS);
    return c.html(SHELL, 200, SECURITY_HEADERS);
  });
  app.get("/login", async (c) => {
    await metrics.capture("login_page_viewed", ANONYMOUS);
    return c.html(SHELL, 200, SECURITY_HEADERS);
  });
  // Whether there is a session, and whether an invite works, is decided by the API calls the page makes.
  for (const path of ["/app", "/app/sessions", "/app/settings", "/app/sessions/:id", "/invite/:token"])
    app.get(path, (c) => c.html(SHELL, 200, SECURITY_HEADERS));

  for (const [path, { url, type }] of Object.entries(BUNDLE)) {
    app.get(path, async (c) => {
      const body = await readFile(url).catch(() => undefined);
      if (!body) return c.notFound(); // not built yet
      return c.body(body, 200, { "content-type": type });
    });
  }
  for (const [path, url] of Object.entries(FONTS)) {
    app.get(path, async (c) => {
      const body = await readFile(url).catch(() => undefined);
      if (!body) return c.notFound();
      return c.body(body, 200, {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
      });
    });
  }
  return app;
}
