import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vercel builds with Root Directory set to packages/web and uploads only that directory, so a tsconfig
// that extends a file outside it silently falls back to non-strict defaults there while CI stays strict.
describe("packages/web/tsconfig.json", () => {
  const config = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as {
    extends?: string;
    compilerOptions: { strict?: boolean };
  };

  it("is self-contained, so Vercel compiles with the same options as CI", () => {
    expect(config.extends).toBeUndefined();
  });

  it("is strict", () => {
    expect(config.compilerOptions.strict).toBe(true);
  });
});
