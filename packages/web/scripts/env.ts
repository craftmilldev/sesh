// Load .env if present (Node >= 21.7 has this built in).
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* missing file is fine */
  }
}
