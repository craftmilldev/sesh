# Sesh

Session insights for Claude Code teams. Sesh collects your team's Claude Code sessions through OpenTelemetry and shows
the shape of the work: tokens, tool calls, prompts, and how much of the team's plan is used. It never shows who did it.

It's for teams that share Claude Code plans and want to know where the usage goes, without reading anyone's prompts.
Prompt text and user identity are dropped before anything is stored.

## Set up

You need a Sesh server (see [Deploy](docs/deploy.md), or [run it locally](docs/development.md)) and Node 22+.

1. Sign in at your server. It emails you a one-time code. Create or join an org.
2. Open **Tokens** and make a token. The page shows the environment variables to set for Claude Code. Put them in your
   shell profile or the `env` block of `~/.claude/settings.json`.
3. Install the `sesh` command. It adds a status line to Claude Code that reports plan usage (`5h 12% | 7d 40%`):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/craftmilldev/sesh/main/install.sh | sh
   ```

4. Start Claude Code. Sessions show up on the home page.

To bring in sessions from before you set this up, run `sesh sessions` to list them and `sesh upload --all` to send them.
Re-running is safe.

## Learn more

- [How it works](docs/how-it-works.md): sign-in, orgs, ingest, and what each page shows
- [The sesh command](docs/cli.md): every command and how it updates itself
- [Plan usage](docs/plan-usage.md): how the team pool and 7 day pace are worked out
- [Deploy](docs/deploy.md) and [Development](docs/development.md)
