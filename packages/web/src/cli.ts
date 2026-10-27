import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { ANONYMOUS, noopMetrics, type Metrics } from "./metrics.js";

// The sesh CLI is one file, cli/sesh.mjs, and this server is where it comes from: install.sh downloads it and an
// installed copy asks /cli/version whether its own hash is still the newest. Serving it here (rather than from
// GitHub) keeps the private repo private and means the CLI always matches the deployment it reports to. The URLs are
// literal so Vercel's file tracing ships both files with the function.
const CLI = new URL("../cli/sesh.mjs", import.meta.url);
const INSTALL = new URL("../content/install.sh", import.meta.url);

/** The CLI's text, its sha256 and the version it says it is. */
async function loadCli() {
  const body = await readFile(CLI);
  const version = /export const VERSION = "([^"]+)"/.exec(body.toString("utf8"))?.[1] ?? "unknown";
  return { body, version, sha256: createHash("sha256").update(body).digest("hex") };
}

/** Event property for a version a client sent: a plain x.y.z or "unknown", so the property stays low-cardinality. */
const versionOf = (header: string | undefined) => (header && /^\d+\.\d+\.\d+$/.test(header) ? header : "unknown");

export function createCliRoutes(opts: { metrics?: Metrics } = {}) {
  const app = new Hono();
  const metrics = opts.metrics ?? noopMetrics;

  app.get("/cli/version", async (c) => {
    const cli = await loadCli().catch(() => undefined);
    if (!cli) return c.json({ error: "cli_unavailable" }, 503);
    const from = versionOf(c.req.header("x-sesh-cli-version"));
    await metrics.capture("cli_version_checked", ANONYMOUS, { from_version: from, current: from === cli.version });
    return c.json({ version: cli.version, sha256: cli.sha256 }, 200, { "cache-control": "no-store" });
  });

  app.get("/cli/sesh.mjs", async (c) => {
    const cli = await loadCli().catch(() => undefined);
    if (!cli) return c.json({ error: "cli_unavailable" }, 503);
    const header = c.req.header("x-sesh-cli-version");
    await metrics.capture("cli_downloaded", ANONYMOUS, {
      // An installed CLI updating sends its version; install.sh sends none.
      kind: header ? "update" : "install",
      from_version: header ? versionOf(header) : undefined,
      version: cli.version,
    });
    return c.body(cli.body, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
  });

  app.get("/install.sh", async (c) => {
    const script = await readFile(INSTALL, "utf8").catch(() => undefined);
    if (script === undefined) return c.json({ error: "install_unavailable" }, 503);
    await metrics.capture("install_script_fetched", ANONYMOUS);
    // The script installs from the server it came from, so a preview or self-hosted sesh installs itself.
    return c.body(script.replaceAll("__SESH_SERVER__", new URL(c.req.url).origin), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  return app;
}
