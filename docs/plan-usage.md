# Plan usage

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

`GET /api/insights/pace?days=7|14|28` gives the same pace for each of the last UTC days, as it stood at the end of that day (the computation takes an as-of time: only readings captured up to it count, each member's highest reading per window), `null` where nothing was expected; today's value is as of now. `GET /api/limits` is the same computation as of now.

`GET /api/insights/limit-hits?days=7|14|28` gives, for each of the last UTC days (oldest first, zero-filled, the last is today), how many distinct members have a snapshot captured that day with the 5h used percent at 100 or more (`{ days: [{ day, members }] }`, counts only, no names); `/app/insights` draws it as a "5h limit reached" bar chart with today's count.
