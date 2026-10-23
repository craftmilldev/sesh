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
logs in, opens the link and joins as a member. A switcher on `/app/settings` changes the active org. Only owners invite.

Any member can make ingest tokens on `/app/settings` (`/api/tokens`) for the active org (named, shown once, stored hashed, revocable). The
page shows the `OTEL_*` env vars to set for Claude Code, which sends OTLP/HTTP to `POST /v1/logs` and `/v1/metrics`
with `Authorization: Bearer <token>`; the token says which org and user. Each accepted payload (JSON or protobuf,
optionally gzipped, up to 4 MB) is stored as it arrived in `sesh.raw_payloads`. Logs payloads are then parsed (`src/claude-code.ts`, `src/parse.ts`) into
`sesh.sessions` (agent `claude-code`, user, started/ended), `sesh.prompts` (by `prompt.id`; length only) and `sesh.events`
(`api_request` / `tool_call` with model, tokens, cost, duration, tool, success and the record's attributes as JSON).
Parsing is idempotent and order-independent. Prompt text and `user.*` identity attributes are dropped before storing.
Only JSON logs are parsed so far; protobuf payloads stay raw.

`/app` is about the team, not individuals, and names no one. It shows today's sessions (since the viewer's local midnight,
`GET /api/today?since=ISO`): total tokens, cache hit, prompts and tool calls, the team's plan-window pool, and the 5
heaviest sessions with their share of the day. `/app/sessions` is the full list (`GET /api/sessions?page=N`, 25 a page,
newest first) and `/app/sessions/<id>` one session with its prompts and events. `/app/settings` holds the member list
(`GET /api/members`), invites, org switching and creation, and ingest tokens. An org with no sessions shows how to
connect Claude Code. The UI is in the Craftmill house style (paper, ink, ruled lines; Sorts Mill Goudy and Courier Prime,
self-hosted under `public/fonts/` and served by `src/ui.ts`, so the CSP stays `style-src 'self'`).

Plan usage comes from the Claude Code status line, not OTel. [`packages/web/statusline/sesh-statusline.js`](packages/web/statusline/sesh-statusline.js)
reads the status line JSON, prints `5h N% | 7d N%`, and at most once a minute posts the session id and the two windows'
used percentage and reset time to `POST /v1/limits` (same bearer ingest token; 401 and nothing stored otherwise), which
stores a `sesh.limit_snapshots` row. Everything else in the input is dropped. The post runs in a detached process with a
5 second timeout and every error is swallowed, so a down server never slows or breaks the status line. `GET /api/limits` turns the latest readings into one team pool: each org member is an equal share, a member's share used is
their latest reading, and a member with none (never posted, or the window has reset) counts as 0% used, so
`used = (sum of used %) / members`, rounded. It returns `{ members, five_hour_used, seven_day_used,
five_hour_reporting, seven_day_reporting }`. Headless `claude -p` never runs the status line, so a runner that drives it (loopway) reports plan usage as OTLP
instead: a `plan.usage.utilization` gauge (0 to 1) with one point per window (`plan.window` `5h` or `7d`), `plan.resets_at`
(unix seconds) and `session.id`, sent to `POST /v1/metrics` with the same ingest token. Points sharing a session and time
become one `sesh.limit_snapshots` row (percent = utilization x 100); other windows are ignored. JSON metrics only.

To install it, copy the script somewhere stable, make an ingest token on `/app/settings`, and add to `~/.claude/settings.json`:

```json
{
  "env": { "SESH_URL": "https://<your sesh origin>", "SESH_TOKEN": "<ingest token>" },
  "statusLine": { "type": "command", "command": "node /abs/path/to/sesh-statusline.js" }
}
```

Without `SESH_URL` and `SESH_TOKEN` it only prints the bar. `SESH_STATE_DIR` (default `~/.sesh`) holds the throttle file.

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
