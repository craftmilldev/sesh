#!/bin/sh
# Throwaway spike: log the Claude Code status line input and print the limit percentages if present.
# Needs node (already there if Claude Code was installed with npm) only for parsing; no dependencies.
mkdir -p "$HOME/.sesh-spike"
input=$(cat)
printf '{"ts":"%s","input":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$input" >> "$HOME/.sesh-spike/statusline.jsonl"
printf '%s' "$input" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s);
  const rl = j.rate_limits || {};
  const pct = (w) => (rl[w] && rl[w].used_percentage != null ? rl[w].used_percentage + "%" : "n/a");
  console.log("5h " + pct("five_hour") + " | 7d " + pct("seven_day"));
});'
