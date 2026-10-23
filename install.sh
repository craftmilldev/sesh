#!/bin/sh
# Installs the sesh status line for Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/craftmilldev/sesh/main/install.sh | sh
#
# It downloads sesh-statusline.js to ~/.sesh/ and sets statusLine in ~/.claude/settings.json. The status line
# reports to the sesh your OTel export already goes to (the OTEL_* env vars from sesh's settings page), so set
# those up first; it adds no token of its own.
#
# An existing statusLine that isn't sesh's is only replaced if you say so (or SESH_REPLACE=1). The old
# settings.json is kept as settings.json.bak. Needs Node 22+, which runs the status line itself.
#
# Other settings: SESH_REF (git ref to download, default main), SESH_DIR (default ~/.sesh),
# CLAUDE_CONFIG_DIR (default ~/.claude).

set -eu

REF="${SESH_REF:-main}"
SRC="https://raw.githubusercontent.com/craftmilldev/sesh/${REF}/packages/web/statusline/sesh-statusline.js"
DIR="${SESH_DIR:-$HOME/.sesh}"
SCRIPT="$DIR/sesh-statusline.mjs"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

say() { printf '%s\n' "$*" >&2; }
die() { say "sesh: $*"; exit 1; }

# With curl | sh, stdin is this script, so the one question goes to the terminal. No terminal means no.
ask_yes() {
  [ -t 2 ] && (: </dev/tty) 2>/dev/null || return 1
  printf '%s' "$1" >&2
  IFS= read -r answer </dev/tty || return 1
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Node runs the status line, and does the JSON reading and editing below.
command -v node >/dev/null 2>&1 || die "Node 22 or later is required (https://nodejs.org)."
NODE="$(command -v node)"
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node 22 or later is required; found $("$NODE" --version)."

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required."
fi

mkdir -p "$DIR"
tmp="$DIR/.sesh-statusline.$$.mjs"
trap 'rm -f "$tmp"' EXIT
fetch "$SRC" "$tmp" || die "could not download $SRC"
# A quick check that it is the script and not an error page, then run it on an empty input.
grep -q 'formatBar' "$tmp" || die "$SRC doesn't look like the sesh status line."
echo '{}' | "$NODE" "$tmp" >/dev/null 2>&1 || die "the downloaded status line doesn't run under $("$NODE" --version)."
mv "$tmp" "$SCRIPT"
chmod 755 "$SCRIPT"
say "Installed $SCRIPT"

# The command Claude Code runs. Node's absolute path, since the status line may not get the shell's PATH.
COMMAND="\"$NODE\" \"$SCRIPT\""

# Read the settings before changing anything: the current status line, and where it would report. Claude Code
# gives the status line its own environment plus the settings' env, so look at both.
mkdir -p "$(dirname "$SETTINGS")"
state="$(SETTINGS="$SETTINGS" SCRIPT="$SCRIPT" "$NODE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  let s = {};
  try { s = JSON.parse(readFileSync(process.env.SETTINGS, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") { console.error("cannot read " + process.env.SETTINGS + ": " + e.message); process.exit(1); } }
  const { target } = await import(pathToFileURL(process.env.SCRIPT).href);
  const to = target({ ...process.env, ...(s && s.env) });
  const c = s && s.statusLine && s.statusLine.command;
  console.log(to ? new URL(to.url).origin : "");
  process.stdout.write(typeof c === "string" ? c : "");
')" || die "fix $SETTINGS and run this again."
origin="$(printf '%s\n' "$state" | sed -n 1p)"
current="$(printf '%s\n' "$state" | sed '1d')"

case "$current" in
  "" | *sesh-statusline*) ;;
  *)
    say "Claude Code already has a status line: $current"
    if [ "${SESH_REPLACE:-}" != 1 ] && ! ask_yes 'Replace it with sesh? [y/N] '; then
      say "Left your status line as it is. To use sesh's, set statusLine.command in $SETTINGS to:"
      say "  $COMMAND"
      exit 0
    fi
    ;;
esac

backup=""
if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$SETTINGS.bak" && backup=" (the old one is $SETTINGS.bak)"; fi
SETTINGS="$SETTINGS" COMMAND="$COMMAND" "$NODE" -e '
  const fs = require("fs");
  const { SETTINGS, COMMAND } = process.env;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch {}
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  s.statusLine = { type: "command", command: COMMAND };
  const tmp = SETTINGS + ".sesh-tmp";
  let mode = 0o600;
  try { mode = fs.statSync(SETTINGS).mode & 0o777; } catch {}
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode });
  fs.renameSync(tmp, SETTINGS);
'
say "Updated $SETTINGS$backup"
if [ -n "$origin" ]; then
  say "Reporting plan usage to $origin. Restart Claude Code to see the status line: 5h N% | 7d N%"
else
  say "No OTel export to sesh found (OTEL_EXPORTER_OTLP_ENDPOINT and an Authorization=Bearer header in"
  say "OTEL_EXPORTER_OTLP_HEADERS), so the status line will show plan usage but not report it."
  say "Set those up from sesh's settings page; the status line picks them up without reinstalling."
fi
