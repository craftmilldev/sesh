import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Metrics } from "../src/metrics.js";

describe("app", () => {
  it("answers /health with 200", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the landing page and records the view", async () => {
    const events: string[] = [];
    const metrics: Metrics = { capture: async (event) => void events.push(event) };
    const res = await createApp({ metrics }).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>sesh</h1>");
    expect(events).toEqual(["landing_viewed"]);
  });
});
