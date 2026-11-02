# Development

## Run it locally

```bash
npm install
npm run db:up          # local Postgres on port 54330
cp packages/web/.env.example packages/web/.env   # DATABASE_URL; leave TOKEN_SECRET unset for a random one
npm run dev            # http://localhost:3000, restarts on change
curl localhost:3000/health   # {"ok":true}
```

Without `RESEND_API_KEY`, login codes are printed to the server console. Set `POSTHOG_API_KEY` to turn on product
metrics (unset sends nothing); they go through `@craftmilldev/analytics` and Craftmill's shared proxy. Every event carries `product = sesh` and `app = sesh-web`; filter on `product` in
PostHog to see only Sesh (the Craftmill project is shared with loopway, whose `app` is `web`/`cli`). `npm run dev` applies migrations to the local database.

The CLI sends its own events (`cli_command_succeeded` / `cli_command_failed`, with the command name, duration and, for
`upload`, session counts; never paths, tokens or contents) with `product = sesh` and `app = sesh-cli`, so the two
Sesh surfaces split on `app`. It uses Craftmill's public PostHog project key; `POSTHOG_API_KEY` / `POSTHOG_HOST`
override it. (The CLI is one dependency-free file, so it posts to the same proxy with `fetch` instead of importing the package.) `DO_NOT_TRACK=1` or `SESH_TELEMETRY=0` turns it off. The status line, `sessions`, `config` and
`upload --dry-run` send nothing.

## Test

```bash
npm test && npm run typecheck && npm run lint && npm run format:check
```

CI runs the same four on every pull request and on `main`.
