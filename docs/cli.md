# The sesh command

Install it with `curl -fsSL https://raw.githubusercontent.com/craftmilldev/sesh/main/install.sh | sh`.

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
- `sesh upload <session-id>`, or `--all`, `--since <date>`, `--project <text>` (or no argument to pick from a numbered list on a terminal), with `--dry-run`: backfills past sessions as OTel logs to the server in `config.json`, one session at a time, then prints how many turns were accepted, already known or failed. It is safe to re-run: turns the server already has are skipped, so nothing is counted twice. What is sent is the same per-turn events live OTel export sends (token counts, model, tool names and timings, a prompt's length, session and prompt ids); it does not send prompt text, replies or tool output, and `--dry-run` prints exactly what would go.
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
