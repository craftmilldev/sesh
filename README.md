# sesh

Session insights for Claude Code teams: org session logging from OTel. It shows the shape of the work, never who did it.

A Hono app on the same stack as [loopway](https://github.com/craftmilldev/loopway) (TypeScript, Node 22+, npm
workspaces, Postgres, Vitest, ESLint, Prettier). The landing page (`/`) and health check (`/health`) are server-rendered;
everything signed-in is a React single-page app (`packages/web/client/`, bundled by esbuild into `public/app.js`) served
at `/login`, `/app` and `/invite/<token>`, and talking to a JSON API under `/api`.

Sign-in works like loopway's: `POST /api/login` emails a one-time code, and `POST /api/login/verify` trades it for a
session token (a 30-day JWT). The SPA keeps the token, the active org and the invite link to return to in localStorage
(`sesh_session`, `sesh_org`, `sesh_next`); the server sets no cookies. Every API call sends
`Authorization: Bearer <session token>` and, for the active org, `X-Sesh-Org: <org id>`, which is only a hint: it is
checked against the user's memberships on every request. Because localStorage is readable by any script on the page,
the SPA's pages are sent with a Content-Security-Policy that allows only the app's own bundle. A new email gets a user
and a personal org they own; a returning one signs in to the same org. `/app` shows the name and active org; the API
answers 401 to a missing or bad token and the SPA sends the user to `/login`. Users can create more orgs (they own what
they create), and an owner can email a one-use invite link (valid 7 days) for the active org to someone; the invitee
logs in, opens the link and joins as a member. A switcher on `/app` changes the active org. Only owners invite.

Any member can make ingest tokens on `/app` (`/api/tokens`) for the active org (named, shown once, stored hashed, revocable). The
page shows the `OTEL_*` env vars to set for Claude Code, which sends OTLP/HTTP to `POST /v1/logs` and `/v1/metrics`
with `Authorization: Bearer <token>`; the token says which org and user. Each accepted payload (JSON or protobuf,
optionally gzipped, up to 4 MB) is stored as it arrived in `sesh.raw_payloads`. Logs payloads are then parsed (`src/claude-code.ts`, `src/parse.ts`) into
`sesh.sessions` (agent `claude-code`, user, started/ended), `sesh.prompts` (by `prompt.id`; length only) and `sesh.events`
(`api_request` / `tool_call` with model, tokens, cost, duration, tool, success and the record's attributes as JSON).
Parsing is idempotent and order-independent. Prompt text and `user.*` identity attributes are dropped before storing.
Only JSON logs are parsed so far; protobuf payloads stay raw.

`/app` lists the active org's sessions (`GET /api/sessions?page=N`, 25 a page, newest first): who, start time, tokens in
total and by type (input, output, cache read, cache write), prompts and tool calls, summed from `sesh.events` and
`sesh.prompts`. An org with none shows how to connect Claude Code.

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

sesh deploys to Vercel the way loopway does: Vercel uploads only the Root Directory, so `packages/web/tsconfig.json` must not extend a file outside it (a test enforces this). Vercel detects Hono at `packages/web/src/index.ts`, and only `main` deploys
(`packages/web/vercel.json`). One-time setup, which needs a Vercel login:

1. In the `craftmill` Vercel team, import `craftmilldev/sesh` as a new project named `sesh`, with **Root Directory** set to `packages/web`.
2. Set `DATABASE_URL` (Neon's pooled string) and `DATABASE_URL_UNPOOLED` (the direct one), `TOKEN_SECRET`
   (`openssl rand -hex 32`), `RESEND_API_KEY` and `EMAIL_FROM` in the project's environment variables. Optionally set
   `POSTHOG_API_KEY` (and `POSTHOG_HOST` for EU). The build applies pending migrations before deploying.
3. Deploy `main`, then check `https://<deployment>/health` returns 200.

After that, every merge to `main` deploys.
