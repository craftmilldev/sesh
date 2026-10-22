# sesh

Session insights for Claude Code teams: org session logging from OTel. It shows the shape of the work, never who did it.

A Hono app on the same stack as [loopway](https://github.com/craftmilldev/loopway) (TypeScript, Node 22+, npm
workspaces, Postgres, Vitest, ESLint, Prettier): a landing page (`/`), a health check (`/health`), and sign-in.
Sign-in works like loopway's: `/login` emails a one-time code, and redeeming it sets a session cookie. A new email
gets a user and a personal org they own; a returning one signs in to the same org. `/app` is the signed-in shell
(name and active org); signed-out requests to `/app` redirect to `/login`. Users can create more orgs (they own
what they create), and an owner can email a one-use invite link (valid 7 days) for the active org to someone; the invitee logs in,
opens the link and joins as a member. A switcher on `/app` changes the active org (kept in the `sesh_org` cookie and
checked against membership on every request). Only owners invite.

Any member can make ingest tokens on `/app` for the active org (named, shown once, stored hashed, revocable). The
page shows the `OTEL_*` env vars to set for Claude Code, which sends OTLP/HTTP to `POST /v1/logs` and `/v1/metrics`
with `Authorization: Bearer <token>`; the token says which org and user. Each accepted payload (JSON or protobuf,
optionally gzipped, up to 4 MB) is stored as it arrived in `sesh.raw_payloads`. Parsing it into sessions comes later.

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
