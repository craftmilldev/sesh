# sesh

Session insights for Claude Code teams: org session logging from OTel. It shows the shape of the work, never who did it.

This is the scaffold: a Hono app with a landing page (`/`) and a health check (`/health`), on the same stack as
[loopway](https://github.com/craftmilldev/loopway) (TypeScript, Node 22+, npm workspaces, Vitest, ESLint, Prettier).
Login, orgs and ingest come later.

The earlier statusline spike is in [`spike/statusline/`](spike/statusline/).

## Run

```bash
npm install
npm run dev            # http://localhost:3000, restarts on change
curl localhost:3000/health   # {"ok":true}
```

Copy `packages/web/.env.example` to `packages/web/.env` to change `PORT` or turn on PostHog metrics
(`POSTHOG_API_KEY`; unset sends nothing). `npm run db:up` starts a local Postgres 17 on port 54330; nothing uses it yet.

## Test

```bash
npm test && npm run typecheck && npm run lint && npm run format:check
```

CI runs the same four on every pull request and on `main`.

## Deploy

sesh deploys to Vercel the way loopway does: Vercel detects Hono at `packages/web/src/index.ts`, and only `main` deploys
(`packages/web/vercel.json`). One-time setup, which needs a Vercel login:

1. In the `craftmill` Vercel team, import `craftmilldev/sesh` as a new project named `sesh`, with **Root Directory** set to `packages/web`.
2. Optionally set `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU) in the project's environment variables.
3. Deploy `main`, then check `https://<deployment>/health` returns 200.

After that, every merge to `main` deploys.
