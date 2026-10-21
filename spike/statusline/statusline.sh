#!/bin/sh
# Throwaway spike: log the Claude Code status line input and print the limit percentages if present.
# Needs node (already there if Claude Code was installed with npm) only for parsing; no dependencies.
mkdir -p "$HOME/.sesh-spike"
node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j = null;
  try { j = JSON.parse(s); } catch (e) {}
  // One compact line per call; unparseable input is kept as a string.
  const rec = { ts: new Date().toISOString(), input: j === null ? s : j };
  require("fs").appendFileSync(process.env.HOME + "/.sesh-spike/statusline.jsonl", JSON.stringify(rec) + "\n");
  const rl = (j && j.rate_limits) || {};
  const pct = (w) => (rl[w] && rl[w].used_percentage != null ? rl[w].used_percentage + "%" : "n/a");
  console.log("5h " + pct("five_hour") + " | 7d " + pct("seven_day"));
});'
