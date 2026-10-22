import type { BuildOptions } from "esbuild";

// Bundles the React app (client/) into public/app.js and public/app.css. Used by scripts/build.ts and scripts/dev.ts.
export const clientBuild: BuildOptions = {
  entryPoints: { app: "client/main.tsx" },
  outdir: "public",
  bundle: true,
  external: ["/fonts/*"], // served by src/ui.ts
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  sourcemap: true,
  logLevel: "info",
};
