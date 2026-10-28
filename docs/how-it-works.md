# How Sesh works

The server, the sign-in and org model, how events are ingested and what the pages show.

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
heaviest sessions with their share of the day. `/app/insights` shows motion over time: tool calls, prompts and active sessions for today and for each UTC day of the last 7, 14 (default) or 28, as one line chart with a chip per metric to turn it on or off (prompts, tool calls and active sessions are on; `tool calls per prompt` is off and, when on, has its own right-hand axis; at least one stays on). `GET /api/insights/activity?days=7|14|28` answers oldest first, zero-filled, plus a `today` object, and each row and `today` carry `tool_calls_per_prompt` (tool calls / prompts to two decimals, `null` on a day with no prompts, which the chart draws as a gap); `by_dow` adds the average per day for each weekday, Mon..Sun (UTC), over the same range: the sum on those days / how many of them the range holds, so a day with no activity counts as zero (`tool_calls_per_prompt` is the averaged tool calls / averaged prompts, `null` with no prompts); any other `days` is a 400. A `By day` / `By weekday` toggle switches the one chart between the daily series and the weekday averages (same metric chips), kept in the page's `?by=weekday`. The range is kept in the page's `?days=` and the metrics in `?metrics=` (`prompts,tools,sessions,ratio`; only what differs from the defaults is written). `/app/sessions` is the full list (`GET /api/sessions?page=N`, 25 a page,
newest first) and `/app/sessions/<id>` one session with its prompts and events. `/app/members` holds the member list
(`GET /api/members`), invites, org switching and creation; `/app/tokens` holds the ingest tokens. An org with no sessions shows how to
connect Claude Code. The UI is in the Craftmill house style (paper, ink, ruled lines; Sorts Mill Goudy and Courier Prime,
self-hosted under `public/fonts/` and served by `src/ui.ts`, so the CSP stays `style-src 'self'`).
