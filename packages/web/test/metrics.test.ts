import { describe, expect, it } from "vitest";
import { createMetrics, noopMetrics } from "../src/metrics.js";

describe("createMetrics", () => {
  it("is a no-op without POSTHOG_API_KEY", () => {
    expect(createMetrics({})).toBe(noopMetrics);
  });
});
