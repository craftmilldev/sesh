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
metrics (unset sends nothing). Every event carries `product = sesh` and `app = sesh-web`; filter on `product` in
PostHog to see only Sesh (the Craftmill project is shared with loopway, whose `app` is `web`/`cli`). `npm run dev` applies migrations to the local database.

## Test

```bash
npm test && npm run typecheck && npm run lint && npm run format:check
```

CI runs the same four on every pull request and on `main`.
