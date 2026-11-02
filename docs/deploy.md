# Deploy

sesh deploys to Vercel the way loopway does: Vercel uploads only the Root Directory, so `packages/web/tsconfig.json` must not extend a file outside it (a test enforces this). Vercel detects Hono at `packages/web/src/index.ts`, and only `main` deploys
(`packages/web/vercel.json`). One-time setup, which needs a Vercel login:

1. In the `craftmill` Vercel team, import `craftmilldev/sesh` as a new project named `sesh`, with **Root Directory** set to `packages/web`.
2. Set `DATABASE_URL` (Neon's pooled string) and `DATABASE_URL_UNPOOLED` (the direct one), `TOKEN_SECRET`
   (`openssl rand -hex 32`), `RESEND_API_KEY` and `EMAIL_FROM` in the project's environment variables. Optionally set
   `POSTHOG_API_KEY` (events go through Craftmill's shared proxy at `https://a.craftmill.dev/api/ingest`; `POSTHOG_HOST` overrides it). The build applies pending migrations before deploying.
3. Deploy `main`, then check `https://<deployment>/health` returns 200.

After that, every merge to `main` deploys.
