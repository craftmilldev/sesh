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
logs in, opens the link and joins as a member. A switcher on `/app/members` changes the active org. Only owners invite.

Any member can make ingest tokens on `/app/tokens` (`/api/tokens`) for the active org (named, shown once, stored hashed, revocable). The
page shows the `OTEL_*` env vars to set for Claude Code, which sends OTLP/HTTP to `POST /v1/logs` and `/v1/metrics`
with `Authorization: Bearer <token>`; the token says which org and user. Each accepted payload (JSON or protobuf,
optionally gzipped, up to 4 MB) is stored as it arrived in `sesh.raw_payloads`. Logs payloads are then parsed (`src/claude-code.ts`, `src/parse.ts`) into
`sesh.sessions` (agent `claude-code`, user, started/ended), `sesh.prompts` (by `prompt.id`; length only) and `sesh.events`
(`api_request` / `tool_call` with model, tokens, cost, duration, tool, success and the record's attributes as JSON).
Parsing is idempotent and order-independent. Prompt text and `user.*` identity attributes are dropped before storing.
Only JSON logs are parsed so far; protobuf payloads stay raw.

`/app` is about the team, not individuals, and names no one. It shows today, a UTC day for everyone (`GET /api/today`; `?day=YYYY-MM-DD`
asks for another): the sessions with a prompt or event today, and the work done today, by when each prompt and event happened, not by when its
session started: total tokens, cache hit, prompts and tool calls, the team's plan-window pool, and the 5
heaviest sessions with their share of the day. `/app/insights` shows motion over time: tool calls, prompts and active sessions for today and for each UTC day of the last 7, 14 (default) or 28, as a bar chart per metric (`GET /api/insights/activity?days=7|14|28`: oldest first, zero-filled, plus a `today` object; any other `days` is a 400; the range is kept in the page's `?days=`). `/app/sessions` is the full list (`GET /api/sessions?page=N`, 25 a page,
newest first) and `/app/sessions/<id>` one session with its prompts and events. `/app/members` holds the member list
(`GET /api/members`), invites, org switching and creation; `/app/tokens` holds the ingest tokens. An org with no sessions shows how to
connect Claude Code. The UI is in the Craftmill house style (paper, ink, ruled lines; Sorts Mill Goudy and Courier Prime,
self-hosted under `public/fonts/` and served by `src/ui.ts`, so the CSP stays `style-src 'self'`).

Plan usage comes from the Claude Code status line, not OTel. [`packages/cli/sesh.mjs`](packages/cli/sesh.mjs)
reads the status line JSON, prints `5h N% | 7d N%`, and at most once a minute posts the session id and the two windows'
used percentage and reset time to `POST /v1/limits` (same bearer ingest token; 401 and nothing stored otherwise), which
stores a `sesh.limit_snapshots` row. Everything else in the input is dropped. The post runs in a detached process with a
5 second timeout and every error is swallowed, so a down server never slows or breaks the status line. `GET /api/limits` turns the latest readings into one team pool: each org member is an equal share, a member's share used is
their latest reading, and a member with none (never posted, or the window has reset) counts as 0% used, so
`used = (sum of used %) / members`, rounded. A member's reading for a window is the highest one posted for it, not
the latest: an idle session's status line keeps posting the last value it saw, and usage only rises until the reset.
It also gives the 7 day pace: a window should be used up by its reset at 20% a weekday and nothing on Saturday or
Sunday (UTC), so `expected` for a member is the weekday time since the window opened over the 5 weekdays every 7 day
window holds, and `pace = (sum of used %) / (sum of expected %)` over members with a known window (100 is on pace;
null when nothing is expected yet, as when a window opens on a weekend). A 7 day window that has reset with no new
reading is rolled forward by whole weeks and counts as 0% used. It returns `{ members, five_hour_used,
seven_day_used, five_hour_reporting, seven_day_reporting, seven_day_expected, seven_day_pace }`. Headless `claude -p` never runs the status line, so a runner that drives it (loopway) reports plan usage as OTLP
instead: a `plan.usage.utilization` gauge (0 to 1) with one point per window (`plan.window` `5h` or `7d`), `plan.resets_at`
(unix seconds) and `session.id`, sent to `POST /v1/metrics` with the same ingest token. Points sharing a session and time
become one `sesh.limit_snapshots` row (percent = utilization x 100); other windows are ignored. JSON metrics only.

It posts where Claude Code's OTel export already goes: `OTEL_EXPORTER_OTLP_ENDPOINT` plus `/v1/limits`, with the
ingest token from the `Authorization=Bearer <token>` in `OTEL_EXPORTER_OTLP_HEADERS`. Claude Code passes no `OTEL_*`
variables to the status line (not even ones set in settings.json `env`), so the installer works these out and saves
them as `{ "url", "token" }` in `config.json` next to the script, which the script reads. `SESH_URL` and `SESH_TOKEN`
override that, and the `OTEL_*` variables are used if they ever do arrive; with none it only prints the bar. Once the
OTel env vars from `/app/tokens` are set up, install the `sesh` command (which is also the status line) with:

```bash
curl -fsSL https://raw.githubusercontent.com/craftmilldev/sesh/main/install.sh | sh
```

[`install.sh`](install.sh) downloads the latest GitHub release's `sesh.mjs` to `~/.sesh/sesh.mjs` (`SESH_VERSION=0.1.0` picks a release), links it as `~/.local/bin/sesh` and runs
`sesh setup`. The CLI ([`packages/cli/sesh.mjs`](packages/cli/sesh.mjs), plain Node 22+, no dependencies) has:

- `sesh status`: version, server, masked token, whether Claude Code's status line is sesh's, the last reading posted, auto-update, and whether the server is reachable and has a newer CLI.
- `sesh setup [--replace] [--url <server> --token <token>]`: saves the endpoint and token to `config.json` (mode 600; from the OTel settings in the shell or `settings.json` `env`, or the flags), and sets `statusLine` in `~/.claude/settings.json` with a 60 second `refreshInterval` (the old file is kept as `settings.json.bak`). It won't replace a status line that isn't sesh's unless you say yes (or pass `--replace`, or set `SESH_REPLACE=1`).
- `sesh statusline on|off`: set or remove sesh's status line. With no argument it is the status line itself, which Claude Code runs.
- `sesh sessions`: lists the Claude Code sessions in `~/.claude/projects` (id, date, project, prompt count, tokens). It reads local files only and makes no network calls.
- `sesh upload <session-id>`, or `--all`, `--since <date>`, `--project <text>` (or no argument to pick from a numbered list on a terminal), with `--dry-run`: backfills past sessions as OTel logs to the server in `config.json`, eight sessions at a time (gzipped, with a progress line and the time left), then prints how many turns were accepted, already known or failed. It is safe to re-run: sessions already uploaded and unchanged (tracked in `~/.sesh/uploaded.json`) are skipped unless you pass `--force`, and turns the server already has are skipped, so nothing is counted twice. What is sent is the same per-turn events live OTel export sends (token counts, model, tool names and timings, a prompt's length, session and prompt ids); it does not send prompt text, replies or tool output, and `--dry-run` prints exactly what would go.
- `sesh config [set url|token|auto_update <value>]`, `sesh update`, `sesh --version`.

An installed CLI (the file at `~/.sesh/sesh.mjs`, not a checkout) updates itself the way loopway's does: before a command it
asks GitHub for the repo's latest release (`cli-v<x.y.z>`; at most every 10 minutes, 3 second timeout, remembered in
`update-check.json` even when it fails) and, if that is newer, downloads the release's `sesh.mjs`, checks that it runs
and reports that version, swaps it in and runs the command again. The status line never waits on it: its detached
background process does the check and the install quietly, so a status line alone keeps current. Turn it off with
`sesh config set auto_update off` or `SESH_NO_UPDATE=1`.

The CLI is its own workspace, `packages/cli` (`@sesh/cli`, with its tests). `.github/workflows/release-cli.yml` releases it
when CI passes on `main` and `packages/cli` changed: the next patch after the last `cli-v*` tag (raise `version` in
`packages/cli/package.json` for a minor or major), with that version written into `sesh.mjs`'s `VERSION`. The file in the
repo carries a placeholder `VERSION`.

By hand: copy the script somewhere stable as `sesh.mjs`, put the `config.json` beside it
(`{ "url": "https://<sesh>/v1/limits", "token": "<ingest token>" }`) and add to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "node /abs/path/to/sesh.mjs statusline", "refreshInterval": 60 }
}
```

`SESH_STATE_DIR` (default `~/.sesh`) holds the throttle file.

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
metrics (unset sends nothing). Every event carries `product = sesh` and `app = sesh-web`; filter on `product` in
PostHog to see only Sesh (the Craftmill project is shared with loopway, whose `app` is `web`/`cli`). `npm run dev` applies migrations to the local database.

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
