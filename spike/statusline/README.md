# Status line spike

Throwaway. Question: does the Claude Code status line input expose the 5-hour and weekly limit percentages?

## Install

1. `mkdir -p ~/.sesh-spike` (the script does this too).
2. Add to `~/.claude/settings.json` (replace the path; it needs `node` on the PATH):
   ```json
   "statusLine": { "type": "command", "command": "/abs/path/to/sesh/spike/statusline/statusline.sh" }
   ```
3. Start an interactive `claude` session on a Pro/Max login and send a couple of prompts.
4. `tail -n 3 ~/.sesh-spike/statusline.jsonl | jq .` Each line is `{"ts": ..., "input": <status line JSON>}`.
   The bar shows `5h N% | 7d N%`, or `n/a` when a field is missing.

The script assumes `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage`. These names come from
the Claude Code docs as remembered, **not yet confirmed against a real capture**. Adjust once you see the real JSON.

## Findings

Checked 2026-10-20 with Claude Code 2.1.305.

### Status line input: NOT YET VERIFIED

The spike was built by a bot running `claude -p` (headless). In print mode Claude Code never renders the status line, so the
script was never invoked and nothing was written to `~/.sesh-spike/`. An interactive session on Matthew's plan is still needed
to capture a real example, the field names, subscription vs API behaviour, update frequency, and whether `session_id` is in the
input. Fill those in here after that run.

### OTel: real dump (verified)

Ran `claude -p "say hi"` with `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=console OTEL_LOGS_EXPORTER=console`
on a logged-in subscription account and inspected all 1315 lines of output.

- Metrics: `claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.active_time.total`.
- Log events: `user_prompt`, `api_request`, `assistant_response`, `hook_registered`, `plugin_loaded`,
  `mcp_server_connection`, `managed_settings_resolved`.
- Attributes on every record: `session.id`, `user.id`, `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`,
  `terminal.type`, plus `event.timestamp`, `event.sequence` and `prompt.id` on events. Resource: `service.name`, `service.version`,
  `os.type`, `os.version`, `host.arch`.
- **Nothing about plan, subscription tier, or rate limits** (grep for `rate_limit|five_hour|plan|subscription|tier|limit` finds nothing).
- `session.id` is on everything, so it is the join key if the status line input carries a session id too.

### Verdict: undetermined

OTel carries no limit data, so the plan-usage math depends entirely on the status line. Re-run the interactive step above,
then set the verdict to "usable as is", "usable with caveats", or "not available". If unavailable, the fallback is to estimate
usage from OTel token and cost metrics against published plan limits, which is approximate.
