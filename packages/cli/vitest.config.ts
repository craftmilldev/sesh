import { defineConfig } from "vitest/config";

// The tests run the real CLI: none of it should reach PostHog.
export default defineConfig({ test: { env: { SESH_TELEMETRY: "0" } } });
