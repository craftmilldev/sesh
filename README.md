# sesh

Session insights for Claude Code teams: org session logging from OTel. It shows the shape of the work, never who did it.

A Hono app on the same stack as [loopway](https://github.com/craftmilldev/loopway) (TypeScript, Node 22+, npm
workspaces, Postgres, Vitest, ESLint, Prettier): a landing page (`/`), a health check (`/health`), and sign-in.
Sign-in works like loopway's: `/login` emails a one-time code, and redeeming it sets a session cookie. A new email
gets a user and a personal org they own; a returning one signs in to the same org. `/app` is the signed-in shell
(name and org); signed-out requests to `/app` redirect to `/login`. Ingest comes later.

The earlier statusline spike is in [`spike/statusline/`](spike/statusline/).

## Run

```bash
npm install
npm run db:up          # local Postgres on port 54330
cp packages/web/.env.example packages/web/.env   # DATABASE_URL; leave TOKEN_SECRET unset for a random one
npm run dev            # http://localhost:3000, restarts on change
curl localhost:3000/health   # {"ok":true}
```

Without `RESEND_API_KEY`, login codes are printed to the server console. Set `POSTHOG_API_KEY` to turn on product
metrics (unset sends nothing). `npm run dev` applies migrations to the local database.

## Test

```bash
npm test && npm run typecheck && npm run lint && npm run format:check
```

CI runs the same four on every pull request and on `main`.

## Deploy

sesh deploys to Vercel the way loopway does: Vercel detects Hono at `packages/web/src/index.ts`, and only `main` deploys
(`packages/web/vercel.json`). One-time setup, which needs a Vercel login:

1. In the `craftmill` Vercel team, import `craftmilldev/sesh` as a new project named `sesh`, with **Root Directory** set to `packages/web`.
2. Set `DATABASE_URL` (Neon's pooled string) and `DATABASE_URL_UNPOOLED` (the direct one), `TOKEN_SECRET`
   (`openssl rand -hex 32`), `RESEND_API_KEY` and `EMAIL_FROM` in the project's environment variables. Optionally set
   `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU). The build applies pending migrations before deploying.
3. Deploy `main`, then check `https://<deployment>/health` returns 200.

After that, every merge to `main` deploys.
